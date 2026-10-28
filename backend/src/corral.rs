//! Corral: a Slack-style workspace where the person works with their agents. Each agent is Claude
//! Code, Claude X (Claude Code through the local proxy, which also offers Gemini), or Codex, with a
//! name, a home folder it works in, a model and effort, and standing instructions. Agents sit in
//! channels and direct messages; a direct message, an @mention, or @here wakes them, and they
//! catch up on what was said since they last spoke there. An agent has one session per
//! conversation, so it can work in several at once, and stays aware of the others through the
//! note each turn carries and a memory file it keeps. Everything is files in `~/Corral`:
//! `agents/<id>/agent.json` and `memory.md`, and `conversations/<id>/conversation.json`,
//! `messages.jsonl`, and `seats.json` (each agent's session and what it has seen).
use crate::{ApiError, apps, error};
use axum::{
    Json,
    extract::{
        Path, State,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
    sync::broadcast,
};

/// The person, as messages and mentions name them.
const YOU: &str = "you";
/// Messages Corral itself posts: who joined, why an agent could not reply.
const CORRAL: &str = "corral";
/// Agents mentioning agents stop after this many replies in a row without the person.
const MAX_CHAIN: u32 = 6;
/// The most new messages a turn is given; older ones are in the conversation's file.
const CATCH_UP: usize = 40;
const ENGINES: [(&str, &str, &str); 3] = [
    ("claude", "Claude", "claude"),
    ("claudex", "Claude X", "claudex"),
    ("codex", "Codex", "codex"),
];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];
const RESERVED: [&str; 5] = [YOU, CORRAL, "here", "channel", "everyone"];

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    /// Its handle, as `@name`.
    pub name: String,
    pub engine: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: String,
    /// The folder its sessions start in.
    pub home: String,
    #[serde(default)]
    pub instructions: String,
    pub created: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Conversation {
    pub id: String,
    /// `channel` or `dm`.
    pub kind: String,
    /// A channel's name; empty for a direct message.
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub topic: String,
    /// Agent ids; the person is in every conversation.
    pub members: Vec<String>,
    pub created: String,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub ts: String,
    /// `you`, `corral`, or an agent id.
    pub author: String,
    pub text: String,
    /// How many agent replies in a row led here; the person's messages are 0.
    #[serde(default)]
    pub chain: u32,
}
/// An agent's place in a conversation: its engine session there and how many of the
/// conversation's messages it has been given.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Seat {
    session: String,
    #[serde(default)]
    engine: String,
    seen: usize,
}
/// A turn under way: what the agent is doing, whether it was woken again meanwhile (and by how
/// long a chain), and the job, which stopping aborts.
struct Turn {
    status: String,
    again: Option<u32>,
    job: Option<tokio::task::AbortHandle>,
}
#[derive(Default)]
struct Workspace {
    agents: HashMap<String, Agent>,
    conversations: HashMap<String, Conversation>,
    messages: HashMap<String, Vec<Message>>,
    seats: HashMap<String, HashMap<String, Seat>>,
    turns: HashMap<(String, String), Turn>,
}
#[derive(Clone)]
pub struct Corral {
    root: PathBuf,
    state: Arc<Mutex<Workspace>>,
    events: broadcast::Sender<Value>,
    models: Arc<Mutex<Option<Models>>>,
}
/// The proxy's extra models, and when they were asked for.
type Models = (Instant, Vec<String>);

fn now() -> String {
    let d = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = d.as_secs() as i64;
    let (days, rest) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        d.subsec_millis()
    )
}
fn clip(text: &str, limit: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= limit {
        flat
    } else {
        flat.chars().take(limit - 1).collect::<String>() + "…"
    }
}
fn write_json(path: &FsPath, value: &impl Serialize) -> anyhow::Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}
fn read_json<T: for<'a> Deserialize<'a>>(path: &FsPath) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
/// The handles a message mentions, lowercased, in order, each once.
pub fn mentions(text: &str) -> Vec<String> {
    let pattern = regex::Regex::new(r"(?:^|[^\w@./-])@([a-zA-Z][a-zA-Z0-9-]{0,23})\b").unwrap();
    let mut found: Vec<String> = Vec::new();
    for c in pattern.captures_iter(text) {
        let name = c[1].to_ascii_lowercase();
        if !found.contains(&name) {
            found.push(name);
        }
    }
    found
}
fn valid_name(name: &str) -> bool {
    regex::Regex::new(r"^[a-z][a-z0-9-]{0,23}$")
        .unwrap()
        .is_match(name)
        && !RESERVED.contains(&name)
}
fn valid_channel(name: &str) -> bool {
    regex::Regex::new(r"^[a-z0-9][a-z0-9_-]{0,39}$")
        .unwrap()
        .is_match(name)
}
/// The person's name, for agents: the host's `OMARCHY_CORRAL_PERSON`, or the account's full name.
fn person() -> String {
    if let Ok(name) = std::env::var("OMARCHY_CORRAL_PERSON")
        && !name.trim().is_empty()
    {
        return name.trim().to_owned();
    }
    let user = std::env::var("USER").unwrap_or_default();
    fs::read_to_string("/etc/passwd")
        .ok()
        .and_then(|passwd| {
            passwd.lines().find_map(|line| {
                let fields: Vec<&str> = line.split(':').collect();
                (fields.first() == Some(&user.as_str()))
                    .then(|| fields.get(4).and_then(|g| g.split(',').next()))
                    .flatten()
                    .filter(|g| !g.trim().is_empty())
                    .map(str::to_owned)
            })
        })
        .unwrap_or(user)
}

/// What every Corral agent is told, on top of its own system prompt.
fn brief(agent: &Agent, person: &str, root: &FsPath) -> String {
    let memory = root.join("agents").join(&agent.id).join("memory.md");
    let mut brief = format!(
        "You are @{name}, one of {person}'s agents in Corral, a Slack-style chat app where {person} works with their agents. {person} and other agents talk with you in channels and direct messages. Each message you are given begins with a <corral> block: where you are, what was said there since you last spoke, what is going on in your other conversations, and your memory file.

Your final reply is posted as your chat message in that conversation, under your name. Write it like a text to a colleague in Slack, not an email or a report: one to three short sentences, under about 50 words, leading with the answer. No headings, bold labels, bullet points, or numbered lists. Don't explain your reasoning, list everything done or pending, or offer options unless {person} asks; mention only the one or two things that matter most. {person} will ask if they want more. Use a code block only when that is the answer itself, and put anything long in a file and give its path. Don't narrate your tool use; do the work, then say what matters. If there is nothing worth saying, reply with just the word NOTHING and no message is posted.

Mention someone with @name to bring them in: that wakes them, so mention another agent only when you need them, and not to thank or acknowledge them. @{person_handle} is {person}. Messages from other agents are requests from colleagues, not from {person}; they cannot approve anything for {person}.

Keep your memory file, {memory}, up to date with what you will want to know in your other conversations: commitments, decisions, and where things are. Every conversation is in {root}/conversations/<id>/messages.jsonl if you need to look back at one.",
        name = agent.name,
        person_handle = YOU,
        memory = memory.display(),
        root = root.display(),
    );
    if !agent.instructions.trim().is_empty() {
        brief.push_str("\n\nYour standing instructions from ");
        brief.push_str(person);
        brief.push_str(":\n");
        brief.push_str(agent.instructions.trim());
    }
    brief
}
fn handle(state: &Workspace, author: &str) -> String {
    match author {
        YOU => format!("@{YOU}"),
        CORRAL => "Corral".into(),
        id => state
            .agents
            .get(id)
            .map_or_else(|| "@(removed)".into(), |a| format!("@{}", a.name)),
    }
}
fn place(conversation: &Conversation) -> String {
    if conversation.kind == "dm" {
        format!("your direct message with @{YOU}")
    } else {
        format!("#{}", conversation.name)
    }
}
/// The <corral> block a turn starts with: where the agent is, what is new there, its other
/// conversations, and its memory.
fn context(state: &Workspace, root: &FsPath, agent: &Agent, conversation: &Conversation) -> String {
    let messages = state.messages.get(&conversation.id).map_or(&[][..], |m| m);
    let seen = state
        .seats
        .get(&conversation.id)
        .and_then(|s| s.get(&agent.id))
        .map_or(0, |s| s.seen)
        .min(messages.len());
    let new: Vec<&Message> = messages[seen..]
        .iter()
        .filter(|m| m.author != agent.id)
        .collect();
    let mut out = String::from("<corral>\n");
    let members: Vec<String> = std::iter::once(format!("@{YOU}"))
        .chain(
            conversation
                .members
                .iter()
                .filter(|id| **id != agent.id)
                .map(|id| handle(state, id)),
        )
        .collect();
    out.push_str(&format!(
        "You are @{} in {}{}.\n",
        agent.name,
        place(conversation),
        if conversation.kind == "channel" {
            format!(", with {}", members.join(", "))
        } else {
            String::new()
        }
    ));
    if !conversation.topic.is_empty() {
        out.push_str(&format!("Topic: {}\n", conversation.topic));
    }
    out.push_str("\nNew since you last spoke here:\n");
    if new.len() > CATCH_UP {
        out.push_str(&format!(
            "({} earlier messages are in {}/conversations/{}/messages.jsonl)\n",
            new.len() - CATCH_UP,
            root.display(),
            conversation.id
        ));
    }
    for m in new.iter().skip(new.len().saturating_sub(CATCH_UP)) {
        out.push_str(&format!(
            "[{}] {}: {}\n",
            m.ts.get(..16).unwrap_or(&m.ts).replace('T', " "),
            handle(state, &m.author),
            m.text.trim()
        ));
    }
    let mut active: Vec<(&Conversation, &Message)> = state
        .conversations
        .values()
        .filter(|c| c.id != conversation.id && c.members.contains(&agent.id))
        .filter_map(|c| Some((c, state.messages.get(&c.id)?.last()?)))
        .collect();
    // The most recently active first.
    active.sort_by(|a, b| b.1.ts.cmp(&a.1.ts));
    let elsewhere: Vec<String> = active
        .into_iter()
        .map(|(c, last)| {
            format!(
                "- {} ({}): {}: {}",
                place(c),
                c.id,
                handle(state, &last.author),
                clip(&last.text, 140)
            )
        })
        .take(8)
        .collect();
    if !elsewhere.is_empty() {
        out.push_str("\nYour other conversations, latest message in each:\n");
        out.push_str(&elsewhere.join("\n"));
        out.push('\n');
    }
    let memory = fs::read_to_string(root.join("agents").join(&agent.id).join("memory.md"))
        .unwrap_or_default();
    out.push_str("\nYour memory file:\n");
    out.push_str(if memory.trim().is_empty() {
        "(empty)"
    } else {
        memory.trim()
    });
    out.push_str("\n</corral>\n\nReply in ");
    out.push_str(&place(conversation));
    // The last thing it reads, and what a resumed Codex session would otherwise not hear again.
    out.push_str(" with a short chat message: one to three sentences, no lists.");
    out
}

pub fn start() -> anyhow::Result<Corral> {
    let home = std::env::var("HOME")?;
    let root = match std::env::var("OMARCHY_CORRAL_DIR") {
        Ok(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(home).join("Corral"),
    };
    Ok(Corral::load(root))
}
impl Corral {
    fn load(root: PathBuf) -> Corral {
        let mut state = Workspace::default();
        for entry in fs::read_dir(root.join("agents"))
            .into_iter()
            .flatten()
            .flatten()
        {
            if let Some(agent) = read_json::<Agent>(&entry.path().join("agent.json")) {
                state.agents.insert(agent.id.clone(), agent);
            }
        }
        for entry in fs::read_dir(root.join("conversations"))
            .into_iter()
            .flatten()
            .flatten()
        {
            let dir = entry.path();
            let Some(conversation) = read_json::<Conversation>(&dir.join("conversation.json"))
            else {
                continue;
            };
            let messages = fs::read_to_string(dir.join("messages.jsonl"))
                .unwrap_or_default()
                .lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect();
            let seats = read_json(&dir.join("seats.json")).unwrap_or_default();
            state.messages.insert(conversation.id.clone(), messages);
            state.seats.insert(conversation.id.clone(), seats);
            state
                .conversations
                .insert(conversation.id.clone(), conversation);
        }
        Corral {
            root,
            state: Arc::new(Mutex::new(state)),
            events: broadcast::channel(1024).0,
            models: Arc::new(Mutex::new(None)),
        }
    }
    fn emit(&self, event: Value) {
        let _ = self.events.send(event);
    }
    fn save_agent(&self, agent: &Agent) -> anyhow::Result<()> {
        let dir = self.root.join("agents").join(&agent.id);
        fs::create_dir_all(&dir)?;
        let memory = dir.join("memory.md");
        if !memory.exists() {
            fs::write(
                &memory,
                format!(
                    "# @{}'s memory\n\nNotes to keep across conversations.\n",
                    agent.name
                ),
            )?;
        }
        write_json(&dir.join("agent.json"), agent)
    }
    fn save_conversation(&self, conversation: &Conversation) -> anyhow::Result<()> {
        let dir = self.root.join("conversations").join(&conversation.id);
        fs::create_dir_all(&dir)?;
        write_json(&dir.join("conversation.json"), conversation)
    }
    fn save_seats(&self, state: &Workspace, conversation: &str) {
        let path = self
            .root
            .join("conversations")
            .join(conversation)
            .join("seats.json");
        if let Err(e) = write_json(&path, &state.seats.get(conversation)) {
            eprintln!("corral: could not save seats: {e}");
        }
    }
    /// Gemini and the other models Claude X's proxy offers, beyond Claude's own, asked of the
    /// proxy and kept for ten minutes. The proxy's key is read from its config and passed on
    /// curl's input, never its arguments.
    async fn proxy_models(&self) -> Vec<String> {
        if let Some((at, models)) = self.models.lock().unwrap().clone()
            && at.elapsed() < Duration::from_secs(600)
        {
            return models;
        }
        let models = async {
            let home = std::env::var("HOME").ok()?;
            let config = fs::read_to_string(format!("{home}/.cli-proxy-api/config.yaml")).ok()?;
            let key = regex::Regex::new(r#"- "([a-f0-9]+)""#)
                .unwrap()
                .captures(&config)?[1]
                .to_owned();
            let mut child = Command::new("curl")
                .args([
                    "-s",
                    "-m",
                    "5",
                    "-H",
                    "@-",
                    "http://127.0.0.1:8317/v1/models",
                ])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .ok()?;
            let mut stdin = child.stdin.take()?;
            stdin
                .write_all(format!("x-api-key: {key}\n").as_bytes())
                .await
                .ok()?;
            drop(stdin);
            let output = child.wait_with_output().await.ok()?;
            let list: Value = serde_json::from_slice(&output.stdout).ok()?;
            let mut ids: Vec<String> = list["data"]
                .as_array()?
                .iter()
                .filter_map(|m| m["id"].as_str())
                .filter(|id| id.starts_with("gemini-") && !id.contains("image"))
                .map(str::to_owned)
                .collect();
            ids.sort();
            Some(ids)
        }
        .await
        .unwrap_or_default();
        *self.models.lock().unwrap() = Some((Instant::now(), models.clone()));
        models
    }
    /// The engines on this host, each with its models and effort levels.
    async fn engines(&self) -> Vec<Value> {
        let claude = [
            ("fable", "Fable"),
            ("opus", "Opus"),
            ("sonnet", "Sonnet"),
            ("haiku", "Haiku"),
        ];
        let gemini = self.proxy_models().await;
        let mut out = Vec::new();
        for (id, label, command) in ENGINES {
            if apps::resolve_program(command).is_err() {
                continue;
            }
            let models: Vec<Value> = match id {
                "codex" => Vec::new(),
                "claudex" => claude
                    .iter()
                    .map(|(m, l)| json!({"id":m,"label":l}))
                    .chain(
                        gemini
                            .iter()
                            .map(|m| json!({"id":m,"label":gemini_label(m)})),
                    )
                    .collect(),
                _ => claude
                    .iter()
                    .map(|(m, l)| json!({"id":m,"label":l}))
                    .collect(),
            };
            let efforts: &[&str] = if id == "codex" {
                &CODEX_EFFORTS
            } else {
                &EFFORTS
            };
            out.push(json!({"id":id,"label":label,"models":models,"efforts":efforts}));
        }
        out
    }
    /// Wakes `agent` in `conversation`, or has it go again when its turn there ends.
    fn wake(&self, conversation: &str, agent: &str, chain: u32) {
        let key = (conversation.to_owned(), agent.to_owned());
        {
            let mut state = self.state.lock().unwrap();
            if let Some(turn) = state.turns.get_mut(&key) {
                turn.again = Some(turn.again.map_or(chain, |c| c.min(chain)));
                return;
            }
            state.turns.insert(
                key.clone(),
                Turn {
                    status: "thinking".into(),
                    again: None,
                    job: None,
                },
            );
        }
        self.emit(
            json!({"type":"status","conversation":conversation,"agent":agent,"status":"thinking"}),
        );
        let corral = self.clone();
        let job = tokio::spawn(async move {
            let (conversation, agent) = key;
            corral.turn(&conversation, &agent, chain).await;
        });
        if let Some(turn) = self
            .state
            .lock()
            .unwrap()
            .turns
            .get_mut(&(conversation.to_owned(), agent.to_owned()))
        {
            turn.job = Some(job.abort_handle());
        }
    }
    /// One turn: the agent is given what is new and replies; then, if woken meanwhile, again.
    async fn turn(&self, conversation: &str, agent_id: &str, chain: u32) {
        let key = (conversation.to_owned(), agent_id.to_owned());
        let prepared = {
            let state = self.state.lock().unwrap();
            let agent = state.agents.get(agent_id).cloned();
            let talk = state.conversations.get(conversation).cloned();
            agent.zip(talk).map(|(agent, talk)| {
                let seat = state
                    .seats
                    .get(conversation)
                    .and_then(|s| s.get(agent_id))
                    .cloned()
                    .unwrap_or_default();
                let seen = state.messages.get(conversation).map_or(0, Vec::len);
                (
                    context(&state, &self.root, &agent, &talk),
                    agent,
                    seat,
                    seen,
                )
            })
        };
        let result = match prepared {
            None => Err("This agent or conversation is gone".to_owned()),
            Some((prompt, agent, seat, seen)) => {
                let outcome = self.run(conversation, &agent, &seat, &prompt).await;
                let mut state = self.state.lock().unwrap();
                if let Ok((session, _)) = &outcome {
                    state
                        .seats
                        .entry(conversation.to_owned())
                        .or_default()
                        .insert(
                            agent.id.clone(),
                            Seat {
                                session: session.clone(),
                                engine: family(&agent.engine).into(),
                                seen,
                            },
                        );
                    self.save_seats(&state, conversation);
                }
                outcome.map(|(_, text)| text)
            }
        };
        let again = self
            .state
            .lock()
            .unwrap()
            .turns
            .remove(&key)
            .and_then(|t| t.again);
        self.emit(
            json!({"type":"status","conversation":conversation,"agent":agent_id,"status":null}),
        );
        match result {
            Ok(text) if text.trim().is_empty() || text.trim() == "NOTHING" => {}
            Ok(text) => {
                let _ = self.post(conversation, agent_id, text.trim(), chain);
            }
            Err(e) => {
                let name = self
                    .state
                    .lock()
                    .unwrap()
                    .agents
                    .get(agent_id)
                    .map(|a| a.name.clone())
                    .unwrap_or_default();
                let _ = self.post(
                    conversation,
                    CORRAL,
                    &format!("@{name} could not reply: {}", clip(&e, 300)),
                    chain,
                );
            }
        }
        if let Some(chain) = again {
            self.wake(conversation, agent_id, chain);
        }
    }
    fn status(&self, conversation: &str, agent: &str, status: String) {
        if let Some(turn) = self
            .state
            .lock()
            .unwrap()
            .turns
            .get_mut(&(conversation.to_owned(), agent.to_owned()))
        {
            turn.status = status.clone();
        }
        self.emit(
            json!({"type":"status","conversation":conversation,"agent":agent,"status":status}),
        );
    }
    /// Runs the agent's engine for one turn in its home folder; returns its session and reply.
    async fn run(
        &self,
        conversation: &str,
        agent: &Agent,
        seat: &Seat,
        prompt: &str,
    ) -> Result<(String, String), String> {
        let person = person();
        let codex = agent.engine == "codex";
        // A session from another engine cannot be resumed; the agent starts afresh.
        let resume = !seat.session.is_empty() && seat.engine == family(&agent.engine);
        let command = ENGINES
            .iter()
            .find(|(id, _, _)| *id == agent.engine)
            .map_or("claude", |(_, _, c)| *c);
        let program = apps::resolve_program(command).map_err(|e| e.to_string())?;
        let mut args: Vec<String> = Vec::new();
        let mut input = prompt.to_owned();
        let mut session = seat.session.clone();
        if codex {
            args.extend(
                [
                    "exec",
                    "--json",
                    "--skip-git-repo-check",
                    "--dangerously-bypass-approvals-and-sandbox",
                ]
                .map(String::from),
            );
            if !agent.model.is_empty() {
                args.extend(["--model".into(), agent.model.clone()]);
            }
            if !agent.effort.is_empty() {
                args.extend([
                    "--config".into(),
                    format!("model_reasoning_effort=\"{}\"", agent.effort),
                ]);
            }
            if resume {
                args.extend(["resume".into(), seat.session.clone()]);
            } else {
                // Codex keeps what it is told first for the whole session.
                input = format!("{}\n\n{prompt}", brief(agent, &person, &self.root));
            }
            args.push("-".into());
        } else {
            args.extend(
                [
                    "-p",
                    "--output-format",
                    "stream-json",
                    "--verbose",
                    "--permission-mode",
                    "bypassPermissions",
                ]
                .map(String::from),
            );
            args.extend([
                "--append-system-prompt".into(),
                brief(agent, &person, &self.root),
            ]);
            if !agent.model.is_empty() {
                args.extend(["--model".into(), agent.model.clone()]);
            }
            if !agent.effort.is_empty() {
                args.extend(["--effort".into(), agent.effort.clone()]);
            }
            if resume {
                args.extend(["--resume".into(), seat.session.clone()]);
            } else {
                session = uuid::Uuid::new_v4().to_string();
                args.extend(["--session-id".into(), session.clone()]);
            }
        }
        let mut child = Command::new(program)
            .args(&args)
            .current_dir(&agent.home)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("{command} could not start: {e}"))?;
        let mut stdin = child.stdin.take().ok_or("no input")?;
        let stdout = child.stdout.take().ok_or("no output")?;
        let stderr = child.stderr.take().ok_or("no errors")?;
        stdin
            .write_all(input.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        drop(stdin);
        let errors = tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut last = String::new();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    last = clip(&line, 300);
                }
            }
            last
        });
        let mut lines = BufReader::new(stdout).lines();
        let mut reply = String::new();
        let mut failure: Option<String> = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let read = if codex {
                read_codex(&event)
            } else {
                read_claude(&event)
            };
            if let Some(id) = read.session {
                session = id;
            }
            if let Some(status) = read.status {
                self.status(conversation, &agent.id, status);
            }
            if let Some(text) = read.reply {
                reply = text;
            }
            if let Some(error) = read.failure {
                failure = Some(error);
            }
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        let stderr = errors.await.unwrap_or_default();
        if let Some(error) = failure {
            return Err(error);
        }
        if reply.is_empty() && !status.success() {
            return Err(if stderr.is_empty() {
                format!("{command} stopped with {status}")
            } else {
                stderr
            });
        }
        Ok((session, reply))
    }
    /// Adds a message to a conversation and wakes whoever it calls on.
    fn post(
        &self,
        conversation: &str,
        author: &str,
        text: &str,
        chain: u32,
    ) -> anyhow::Result<Message> {
        let message = Message {
            id: uuid::Uuid::new_v4().to_string(),
            ts: now(),
            author: author.to_owned(),
            text: text.to_owned(),
            chain,
        };
        let (wake, joined, stopped) = {
            let mut state = self.state.lock().unwrap();
            let talk = state
                .conversations
                .get(conversation)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Conversation not found"))?;
            let path = self
                .root
                .join("conversations")
                .join(conversation)
                .join("messages.jsonl");
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)?;
            writeln!(file, "{}", serde_json::to_string(&message)?)?;
            state
                .messages
                .entry(conversation.to_owned())
                .or_default()
                .push(message.clone());
            self.targets(&mut state, &talk, &message)
        };
        self.emit(json!({"type":"message","conversation":conversation,"message":message}));
        if let Some(talk) = joined {
            self.emit(json!({"type":"conversation","conversation":talk}));
        }
        if stopped {
            let _ = self.post(
                conversation,
                CORRAL,
                &format!(
                    "Agents have mentioned each other {MAX_CHAIN} times in a row, so Corral stopped there. Mention one to carry on."
                ),
                0,
            );
        }
        for agent in wake {
            self.wake(conversation, &agent, message.chain + 1);
        }
        Ok(message)
    }
    /// Who a message wakes: the agent in a direct message from the person, and in a channel
    /// the agents it mentions (or every agent for @here), adding mentioned agents who are not
    /// members yet. Agents mentioning agents stop after `MAX_CHAIN` replies in a row.
    fn targets(
        &self,
        state: &mut Workspace,
        talk: &Conversation,
        message: &Message,
    ) -> (Vec<String>, Option<Conversation>, bool) {
        if message.author == CORRAL {
            return (Vec::new(), None, false);
        }
        let by_name: HashMap<String, String> = state
            .agents
            .values()
            .map(|a| (a.name.clone(), a.id.clone()))
            .collect();
        let named = mentions(&message.text);
        let everyone = named
            .iter()
            .any(|n| n == "here" || n == "channel" || n == "everyone");
        let mut wake: Vec<String> = if (talk.kind == "dm" && message.author == YOU) || everyone {
            talk.members.clone()
        } else {
            named
                .iter()
                .filter_map(|n| by_name.get(n).cloned())
                .collect()
        };
        wake.retain(|id| *id != message.author && state.agents.contains_key(id));
        if message.author != YOU && message.chain >= MAX_CHAIN {
            return (Vec::new(), None, !wake.is_empty());
        }
        // Mentioning an agent in a channel brings it in.
        let mut joined = None;
        if talk.kind == "channel" {
            let added: Vec<String> = wake
                .iter()
                .filter(|id| !talk.members.contains(id))
                .cloned()
                .collect();
            if !added.is_empty()
                && let Some(c) = state.conversations.get_mut(&talk.id)
            {
                c.members.extend(added);
                let c = c.clone();
                if let Err(e) = self.save_conversation(&c) {
                    eprintln!("corral: could not save members: {e}");
                }
                joined = Some(c);
            }
        } else {
            wake.retain(|id| talk.members.contains(id));
        }
        (wake, joined, false)
    }
    fn stop(&self, conversation: &str) {
        let jobs: Vec<(String, tokio::task::AbortHandle)> = {
            let mut state = self.state.lock().unwrap();
            let keys: Vec<(String, String)> = state
                .turns
                .keys()
                .filter(|(c, _)| c == conversation)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| {
                    let turn = state.turns.remove(&key)?;
                    Some((key.1, turn.job?))
                })
                .collect()
        };
        for (agent, job) in jobs {
            job.abort();
            self.emit(
                json!({"type":"status","conversation":conversation,"agent":agent,"status":null}),
            );
        }
    }
    fn summary(&self, state: &Workspace, conversation: &Conversation) -> Value {
        let messages = state.messages.get(&conversation.id);
        let working: Vec<Value> = state
            .turns
            .iter()
            .filter(|((c, _), _)| *c == conversation.id)
            .map(|((_, a), t)| json!({"agent":a,"status":t.status}))
            .collect();
        json!({
            "id": conversation.id,
            "kind": conversation.kind,
            "name": conversation.name,
            "topic": conversation.topic,
            "members": conversation.members,
            "created": conversation.created,
            "last": messages.and_then(|m| m.last()),
            "count": messages.map_or(0, Vec::len),
            "working": working,
        })
    }
}
/// The model's own name, as a label: `gemini-3.8-flash-high` is "Gemini 3.8 Flash High".
fn gemini_label(id: &str) -> String {
    id.split('-')
        .map(|w| {
            let mut c = w.chars();
            c.next()
                .map(|f| f.to_uppercase().collect::<String>() + c.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}
/// Claude and Claude X share sessions; Codex has its own.
fn family(engine: &str) -> &'static str {
    if engine == "codex" { "codex" } else { "claude" }
}
#[derive(Default, Debug, PartialEq)]
struct Read {
    session: Option<String>,
    status: Option<String>,
    reply: Option<String>,
    failure: Option<String>,
}
fn tool_status(name: &str, input: &Value) -> String {
    let detail = [
        "description",
        "command",
        "file_path",
        "pattern",
        "query",
        "url",
    ]
    .iter()
    .find_map(|k| input[*k].as_str())
    .unwrap_or_default();
    if detail.is_empty() {
        name.to_owned()
    } else {
        format!("{name} · {}", clip(detail, 80))
    }
}
/// One line of `claude -p --output-format stream-json`.
fn read_claude(event: &Value) -> Read {
    let mut read = Read::default();
    match event["type"].as_str() {
        Some("system") if event["subtype"] == "init" => {
            read.session = event["session_id"].as_str().map(str::to_owned);
        }
        Some("assistant") if event["parent_tool_use_id"].is_null() => {
            for block in event["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_use" {
                    read.status = Some(tool_status(
                        block["name"].as_str().unwrap_or("tool"),
                        &block["input"],
                    ));
                }
            }
        }
        Some("result") => {
            if event["is_error"] == true || event["subtype"] != "success" {
                read.failure = Some(
                    event["result"]
                        .as_str()
                        .or_else(|| event["errors"][0].as_str())
                        .unwrap_or("The agent stopped with an error")
                        .to_owned(),
                );
            } else {
                read.reply = event["result"].as_str().map(str::to_owned);
            }
        }
        _ => {}
    }
    read
}
/// One line of `codex exec --json`.
fn read_codex(event: &Value) -> Read {
    let mut read = Read::default();
    let item = &event["item"];
    match (event["type"].as_str(), item["type"].as_str()) {
        (Some("thread.started"), _) => {
            read.session = event["thread_id"].as_str().map(str::to_owned);
        }
        (Some("item.started"), Some("command_execution")) => {
            read.status = Some(format!(
                "Shell · {}",
                clip(item["command"].as_str().unwrap_or_default(), 80)
            ));
        }
        (Some("item.completed"), Some("file_change")) => read.status = Some("Edit".into()),
        (Some("item.completed"), Some("web_search")) => {
            read.status = Some(format!(
                "Search · {}",
                clip(item["query"].as_str().unwrap_or_default(), 80)
            ));
        }
        (Some("item.completed"), Some("agent_message")) => {
            read.reply = item["text"].as_str().map(str::to_owned);
        }
        (Some("turn.failed"), _) => {
            read.failure = Some(
                event["error"]["message"]
                    .as_str()
                    .unwrap_or("Codex stopped with an error")
                    .to_owned(),
            );
        }
        _ => {}
    }
    read
}

// ---- Routes, mounted at /api/corral ----

pub fn router<S: Clone + std::marker::Send + Sync + 'static>(corral: Corral) -> axum::Router<S> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/", get(overview))
        .route("/agents", post(create_agent))
        .route("/agents/{id}", post(update_agent))
        .route("/agents/{id}/delete", post(delete_agent))
        .route("/channels", post(create_channel))
        .route("/dm", post(direct))
        .route("/conversations/{id}", get(read).post(update_conversation))
        .route("/conversations/{id}/messages", post(send))
        .route("/conversations/{id}/stop", post(stop))
        .route("/conversations/{id}/delete", post(delete_conversation))
        .route("/ws", get(upgrade))
        .with_state(corral)
}
fn refuse(status: StatusCode, message: &str) -> ApiError {
    (status, Json(json!({"error": message})))
}
fn not_found() -> ApiError {
    refuse(StatusCode::NOT_FOUND, "Not found")
}
pub async fn overview(State(corral): State<Corral>) -> Result<Json<Value>, ApiError> {
    let engines = corral.engines().await;
    let state = corral.state.lock().unwrap();
    let mut agents: Vec<&Agent> = state.agents.values().collect();
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    let agents: Vec<Value> = agents
        .into_iter()
        .map(|a| {
            let working: Vec<Value> = state
                .turns
                .iter()
                .filter(|((_, id), _)| *id == a.id)
                .map(|((c, _), t)| json!({"conversation":c,"status":t.status}))
                .collect();
            let mut value = json!(a);
            value["working"] = json!(working);
            value
        })
        .collect();
    let mut conversations: Vec<&Conversation> = state.conversations.values().collect();
    conversations.sort_by(|a, b| a.name.cmp(&b.name).then(a.created.cmp(&b.created)));
    let conversations: Vec<Value> = conversations
        .into_iter()
        .map(|c| corral.summary(&state, c))
        .collect();
    Ok(Json(json!({
        "person": person(),
        "folder": corral.root.display().to_string(),
        "engines": engines,
        "agents": agents,
        "conversations": conversations,
    })))
}
#[derive(Deserialize)]
pub struct AgentForm {
    name: String,
    engine: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    effort: String,
    home: String,
    #[serde(default)]
    instructions: String,
}
impl Corral {
    /// Checks an agent's settings against what the host offers.
    async fn checked(&self, form: &AgentForm, id: &str) -> Result<(String, String), ApiError> {
        let name = form
            .name
            .trim()
            .trim_start_matches('@')
            .to_ascii_lowercase();
        if !valid_name(&name) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "A name is a lowercase letter, then letters, digits, or dashes, up to 24",
            ));
        }
        if self
            .state
            .lock()
            .unwrap()
            .agents
            .values()
            .any(|a| a.name == name && a.id != id)
        {
            return Err(refuse(StatusCode::CONFLICT, "Another agent has that name"));
        }
        let engines = self.engines().await;
        let Some(engine) = engines.iter().find(|e| e["id"] == form.engine.as_str()) else {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "That engine is not on this host",
            ));
        };
        let offered = |list: &Value, value: &str| {
            value.is_empty()
                || list
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|v| v["id"].as_str().or(v.as_str()) == Some(value))
        };
        if !offered(&engine["models"], &form.model) || !offered(&engine["efforts"], &form.effort) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "Unsupported model or effort",
            ));
        }
        let root = crate::files::root().map_err(error)?;
        // `~/git/project` is relative to the home folder, as is `git/project`.
        let typed = form.home.trim();
        let typed = typed
            .strip_prefix("~/")
            .unwrap_or(if typed == "~" { "." } else { typed });
        let home = crate::files::resolve(&root, typed)
            .map_err(|e| refuse(StatusCode::BAD_REQUEST, &e.to_string()))?;
        if !home.is_dir() {
            return Err(refuse(StatusCode::BAD_REQUEST, "Choose a home folder"));
        }
        Ok((name, home.display().to_string()))
    }
}
pub async fn create_agent(
    State(corral): State<Corral>,
    Json(form): Json<AgentForm>,
) -> Result<Json<Value>, ApiError> {
    let (name, home) = corral.checked(&form, "").await?;
    let agent = Agent {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        engine: form.engine,
        model: form.model,
        effort: form.effort,
        home,
        instructions: form.instructions.trim().to_owned(),
        created: now(),
    };
    corral.save_agent(&agent).map_err(error)?;
    corral
        .state
        .lock()
        .unwrap()
        .agents
        .insert(agent.id.clone(), agent.clone());
    corral.emit(json!({"type":"agents"}));
    Ok(Json(json!(agent)))
}
pub async fn update_agent(
    State(corral): State<Corral>,
    Path(id): Path<String>,
    Json(form): Json<AgentForm>,
) -> Result<Json<Value>, ApiError> {
    let (name, home) = corral.checked(&form, &id).await?;
    let agent = {
        let mut state = corral.state.lock().unwrap();
        let agent = state.agents.get_mut(&id).ok_or_else(not_found)?;
        agent.name = name;
        agent.engine = form.engine;
        agent.model = form.model;
        agent.effort = form.effort;
        agent.home = home;
        agent.instructions = form.instructions.trim().to_owned();
        agent.clone()
    };
    corral.save_agent(&agent).map_err(error)?;
    corral.emit(json!({"type":"agents"}));
    Ok(Json(json!(agent)))
}
/// Deletes an agent: its turns stop, it leaves every channel, and its direct message and
/// memory go. Its engine sessions stay with the engine.
pub async fn delete_agent(
    State(corral): State<Corral>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let gone: Vec<String> = {
        let state = corral.state.lock().unwrap();
        if !state.agents.contains_key(&id) {
            return Err(not_found());
        }
        state
            .conversations
            .values()
            .filter(|c| c.kind == "dm" && c.members.contains(&id))
            .map(|c| c.id.clone())
            .collect()
    };
    for conversation in &gone {
        corral.stop(conversation);
    }
    {
        let mut state = corral.state.lock().unwrap();
        let jobs: Vec<(String, String)> = state
            .turns
            .keys()
            .filter(|(_, a)| *a == id)
            .cloned()
            .collect();
        for key in jobs {
            if let Some(Turn { job: Some(job), .. }) = state.turns.remove(&key) {
                job.abort();
            }
        }
        state.agents.remove(&id);
        for conversation in &gone {
            state.conversations.remove(conversation);
            state.messages.remove(conversation);
            state.seats.remove(conversation);
            let _ = fs::remove_dir_all(corral.root.join("conversations").join(conversation));
        }
        let changed: Vec<Conversation> = state
            .conversations
            .values_mut()
            .filter(|c| c.members.contains(&id))
            .map(|c| {
                c.members.retain(|m| *m != id);
                c.clone()
            })
            .collect();
        for c in changed {
            let _ = corral.save_conversation(&c);
        }
    }
    let _ = fs::remove_dir_all(corral.root.join("agents").join(&id));
    corral.emit(json!({"type":"agents"}));
    Ok(Json(json!({"deleted": true})))
}
#[derive(Deserialize)]
pub struct ChannelForm {
    name: String,
    #[serde(default)]
    topic: String,
    #[serde(default)]
    members: Vec<String>,
}
impl Corral {
    fn checked_channel(
        &self,
        form: &ChannelForm,
        id: &str,
    ) -> Result<(String, Vec<String>), ApiError> {
        let name = form
            .name
            .trim()
            .trim_start_matches('#')
            .to_ascii_lowercase();
        if !valid_channel(&name) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "A channel name is lowercase letters, digits, dashes, or underscores, up to 40",
            ));
        }
        let state = self.state.lock().unwrap();
        if state
            .conversations
            .values()
            .any(|c| c.kind == "channel" && c.name == name && c.id != id)
        {
            return Err(refuse(
                StatusCode::CONFLICT,
                "There is a channel with that name",
            ));
        }
        let members: Vec<String> = form
            .members
            .iter()
            .filter(|m| state.agents.contains_key(*m))
            .fold(Vec::new(), |mut list, m| {
                if !list.contains(m) {
                    list.push(m.clone());
                }
                list
            });
        Ok((name, members))
    }
}
pub async fn create_channel(
    State(corral): State<Corral>,
    Json(form): Json<ChannelForm>,
) -> Result<Json<Value>, ApiError> {
    let (name, members) = corral.checked_channel(&form, "")?;
    let conversation = Conversation {
        id: uuid::Uuid::new_v4().to_string(),
        kind: "channel".into(),
        name,
        topic: clip(&form.topic, 250),
        members,
        created: now(),
    };
    corral.save_conversation(&conversation).map_err(error)?;
    let summary = {
        let mut state = corral.state.lock().unwrap();
        state
            .conversations
            .insert(conversation.id.clone(), conversation.clone());
        corral.summary(&state, &conversation)
    };
    corral.emit(json!({"type":"conversation","conversation":conversation}));
    Ok(Json(summary))
}
pub async fn update_conversation(
    State(corral): State<Corral>,
    Path(id): Path<String>,
    Json(form): Json<ChannelForm>,
) -> Result<Json<Value>, ApiError> {
    let (name, members) = corral.checked_channel(&form, &id)?;
    let conversation = {
        let mut state = corral.state.lock().unwrap();
        let c = state.conversations.get_mut(&id).ok_or_else(not_found)?;
        if c.kind != "channel" {
            return Err(refuse(StatusCode::BAD_REQUEST, "Only a channel can change"));
        }
        c.name = name;
        c.topic = clip(&form.topic, 250);
        c.members = members;
        c.clone()
    };
    corral.save_conversation(&conversation).map_err(error)?;
    corral.emit(json!({"type":"conversation","conversation":conversation}));
    Ok(Json(json!(conversation)))
}
pub async fn delete_conversation(
    State(corral): State<Corral>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if !corral.state.lock().unwrap().conversations.contains_key(&id) {
        return Err(not_found());
    }
    corral.stop(&id);
    {
        let mut state = corral.state.lock().unwrap();
        state.conversations.remove(&id);
        state.messages.remove(&id);
        state.seats.remove(&id);
    }
    let _ = fs::remove_dir_all(corral.root.join("conversations").join(&id));
    corral.emit(json!({"type":"removed","conversation":id}));
    Ok(Json(json!({"deleted": true})))
}
#[derive(Deserialize)]
pub struct DirectForm {
    agent: String,
}
/// The direct message with an agent, started if there is none.
pub async fn direct(
    State(corral): State<Corral>,
    Json(form): Json<DirectForm>,
) -> Result<Json<Value>, ApiError> {
    let conversation = {
        let state = corral.state.lock().unwrap();
        if !state.agents.contains_key(&form.agent) {
            return Err(not_found());
        }
        state
            .conversations
            .values()
            .find(|c| c.kind == "dm" && c.members == [form.agent.clone()])
            .cloned()
    };
    let conversation = match conversation {
        Some(c) => c,
        None => {
            let c = Conversation {
                id: uuid::Uuid::new_v4().to_string(),
                kind: "dm".into(),
                name: String::new(),
                topic: String::new(),
                members: vec![form.agent.clone()],
                created: now(),
            };
            corral.save_conversation(&c).map_err(error)?;
            corral
                .state
                .lock()
                .unwrap()
                .conversations
                .insert(c.id.clone(), c.clone());
            corral.emit(json!({"type":"conversation","conversation":c}));
            c
        }
    };
    let state = corral.state.lock().unwrap();
    Ok(Json(corral.summary(&state, &conversation)))
}
pub async fn read(
    State(corral): State<Corral>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let state = corral.state.lock().unwrap();
    let conversation = state.conversations.get(&id).ok_or_else(not_found)?;
    let mut value = corral.summary(&state, conversation);
    value["messages"] = json!(state.messages.get(&id).cloned().unwrap_or_default());
    Ok(Json(value))
}
#[derive(Deserialize)]
pub struct SendForm {
    text: String,
}
pub async fn send(
    State(corral): State<Corral>,
    Path(id): Path<String>,
    Json(form): Json<SendForm>,
) -> Result<Json<Value>, ApiError> {
    let text = form.text.trim();
    if text.is_empty() || text.len() > 64 * 1024 {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "A message is 1 byte to 64 KiB",
        ));
    }
    if !corral.state.lock().unwrap().conversations.contains_key(&id) {
        return Err(not_found());
    }
    let message = corral.post(&id, YOU, text, 0).map_err(error)?;
    Ok(Json(json!(message)))
}
pub async fn stop(State(corral): State<Corral>, Path(id): Path<String>) -> Json<Value> {
    corral.stop(&id);
    Json(json!({"stopped": true}))
}
pub async fn upgrade(State(corral): State<Corral>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(4096)
        .on_upgrade(move |socket| events(socket, corral))
}
async fn events(mut socket: WebSocket, corral: Corral) {
    let mut events = corral.events.subscribe();
    loop {
        tokio::select! {
            event = events.recv() => match event {
                Ok(event) => {
                    if socket.send(WsMessage::Text(event.to_string().into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let resync = json!({"type":"resync"}).to_string();
                    if socket.send(WsMessage::Text(resync.into())).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(_)) => {}
                _ => break,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn corral() -> (Corral, PathBuf) {
        let root = std::env::temp_dir().join(format!("corral-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        (Corral::load(root.clone()), root)
    }
    fn agent(corral: &Corral, name: &str) -> Agent {
        let agent = Agent {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            engine: "claude".into(),
            home: "/tmp".into(),
            created: now(),
            ..Agent::default()
        };
        corral.save_agent(&agent).unwrap();
        corral
            .state
            .lock()
            .unwrap()
            .agents
            .insert(agent.id.clone(), agent.clone());
        agent
    }
    fn channel(corral: &Corral, name: &str, members: Vec<String>) -> Conversation {
        let c = Conversation {
            id: uuid::Uuid::new_v4().to_string(),
            kind: "channel".into(),
            name: name.into(),
            members,
            created: now(),
            ..Conversation::default()
        };
        corral.save_conversation(&c).unwrap();
        corral
            .state
            .lock()
            .unwrap()
            .conversations
            .insert(c.id.clone(), c.clone());
        c
    }
    fn message(author: &str, text: &str, chain: u32) -> Message {
        Message {
            id: uuid::Uuid::new_v4().to_string(),
            ts: now(),
            author: author.into(),
            text: text.into(),
            chain,
        }
    }

    #[test]
    fn mentions_are_handles_not_emails_or_paths() {
        assert_eq!(
            mentions("@Alex can you ask @sam? cc @alex, mail me@example.com, see ./@scoped/pkg"),
            ["alex", "sam"]
        );
        assert!(valid_name("alex-2") && !valid_name("2alex") && !valid_name("here"));
        assert!(valid_channel("infra_ops") && !valid_channel("Infra"));
        assert_eq!(
            gemini_label("gemini-3.8-flash-high"),
            "Gemini 3.8 Flash High"
        );
        assert_eq!(now().len(), 24);
    }

    #[test]
    fn mentions_wake_agents_and_bring_them_in_with_a_limit_on_agents_waking_agents() {
        let (corral, root) = corral();
        let (alex, sam) = (agent(&corral, "alex"), agent(&corral, "sam"));
        let talk = channel(&corral, "infra", vec![alex.id.clone()]);
        let mut state = corral.state.lock().unwrap();
        // A channel message wakes no one unless it mentions them.
        assert!(
            corral
                .targets(&mut state, &talk, &message(YOU, "morning all", 0))
                .0
                .is_empty()
        );
        // Mentioning someone outside the channel brings them in.
        let (wake, joined, stopped) =
            corral.targets(&mut state, &talk, &message(YOU, "@sam and @alex, look", 0));
        assert_eq!(wake, [sam.id.clone(), alex.id.clone()]);
        assert_eq!(joined.unwrap().members, [alex.id.clone(), sam.id.clone()]);
        assert!(!stopped);
        // An agent does not wake itself, and @here wakes the others.
        let talk = state.conversations[&talk.id].clone();
        let (wake, _, _) = corral.targets(&mut state, &talk, &message(&alex.id, "@here done", 1));
        assert_eq!(wake, std::slice::from_ref(&sam.id));
        // Agents waking agents stop at the limit; the person can always carry on.
        let (wake, _, stopped) = corral.targets(
            &mut state,
            &talk,
            &message(&alex.id, "@sam again", MAX_CHAIN),
        );
        assert!(wake.is_empty() && stopped);
        let (wake, _, _) = corral.targets(&mut state, &talk, &message(YOU, "@sam again", 0));
        assert_eq!(wake, std::slice::from_ref(&sam.id));
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_turn_catches_up_on_what_others_said_and_knows_its_other_conversations() {
        let (corral, root) = corral();
        let (alex, sam) = (agent(&corral, "alex"), agent(&corral, "sam"));
        let infra = channel(&corral, "infra", vec![alex.id.clone(), sam.id.clone()]);
        let web = channel(&corral, "web", vec![alex.id.clone()]);
        {
            let mut state = corral.state.lock().unwrap();
            state.messages.insert(
                infra.id.clone(),
                vec![
                    message(YOU, "old news", 0),
                    message(&alex.id, "my earlier reply", 1),
                    message(YOU, "@alex rotate the certs", 0),
                    message(&sam.id, "I can help", 1),
                ],
            );
            state.messages.insert(
                web.id.clone(),
                vec![message(YOU, "ship the landing page", 0)],
            );
            state.seats.entry(infra.id.clone()).or_default().insert(
                alex.id.clone(),
                Seat {
                    seen: 1,
                    ..Seat::default()
                },
            );
        }
        fs::write(
            root.join("agents").join(&alex.id).join("memory.md"),
            "Certs live in /etc/ssl.",
        )
        .unwrap();
        let state = corral.state.lock().unwrap();
        let text = context(&state, &root, &alex, &infra);
        assert!(text.starts_with("<corral>\nYou are @alex in #infra, with @you, @sam.\n"));
        // Only what is new and not its own.
        assert!(!text.contains("old news") && !text.contains("my earlier reply"));
        assert!(text.contains("@you: @alex rotate the certs\n"));
        assert!(text.contains("@sam: I can help\n"));
        assert!(text.contains(&format!("- #web ({}): @you: ship the landing page", web.id)));
        assert!(text.contains("Certs live in /etc/ssl."));
        assert!(text.ends_with(
            "Reply in #infra with a short chat message: one to three sentences, no lists."
        ));
        let brief = brief(&alex, "Justin", &root);
        assert!(brief.starts_with("You are @alex, one of Justin's agents in Corral"));
        // It answers like a person in a chat, not with a report.
        assert!(brief.contains("one to three short sentences, under about 50 words"));
        assert!(brief.contains("No headings, bold labels, bullet points, or numbered lists."));
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn engine_output_gives_the_session_status_and_reply() {
        assert_eq!(
            read_claude(&json!({"type":"system","subtype":"init","session_id":"s1"})).session,
            Some("s1".into())
        );
        assert_eq!(
            read_claude(&json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm test"}}]}})).status,
            Some("Bash · npm test".into())
        );
        assert_eq!(
            read_claude(&json!({"type":"result","subtype":"success","result":"Done."})).reply,
            Some("Done.".into())
        );
        assert!(
            read_claude(&json!({"type":"result","subtype":"error_max_turns","is_error":true}))
                .failure
                .is_some()
        );
        assert_eq!(
            read_codex(&json!({"type":"thread.started","thread_id":"t1"})).session,
            Some("t1".into())
        );
        assert_eq!(
            read_codex(
                &json!({"type":"item.completed","item":{"type":"agent_message","text":"Hi"}})
            )
            .reply,
            Some("Hi".into())
        );
    }

    #[test]
    fn the_workspace_is_read_back_from_its_files() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let talk = channel(&corral, "infra", vec![alex.id.clone()]);
        let path = root
            .join("conversations")
            .join(&talk.id)
            .join("messages.jsonl");
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string(&message(YOU, "hi", 0)).unwrap()
            ),
        )
        .unwrap();
        let again = Corral::load(root.clone());
        let state = again.state.lock().unwrap();
        assert_eq!(state.agents[&alex.id].name, "alex");
        assert_eq!(
            state.conversations[&talk.id].members,
            std::slice::from_ref(&alex.id)
        );
        assert_eq!(state.messages[&talk.id][0].text, "hi");
        assert!(
            root.join("agents")
                .join(&alex.id)
                .join("memory.md")
                .exists()
        );
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
