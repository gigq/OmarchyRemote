//! Corral: a Slack-style workspace where the person works with their agents. Each agent is Claude
//! Code, Claude X (Claude Code through the local proxy, which also offers Gemini), or Codex, with a
//! name, a home folder it works in, a model and effort, and standing instructions. Agents sit in
//! channels and direct messages; a direct message, an @mention, or @here wakes them, and they
//! catch up on what was said since they last spoke there. An agent has one session per
//! conversation, so it can work in several at once, and stays aware of the others through the
//! note each turn carries and a memory file it keeps. Everything is files in `~/Corral`:
//! `agents/<id>/agent.json` and `memory.md`, and `conversations/<id>/conversation.json`,
//! `messages.jsonl`, and `seats.json` (each agent's session and what it has seen).
use axum::{
    Json,
    extract::{
        Path, Query, State,
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
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

mod background;
pub mod farm;
mod hosts;
pub mod queue;
mod siblings;
pub use hosts::Host;
use hosts::{host_listing, host_turn};
use siblings::Step;

pub type ApiError = (StatusCode, Json<Value>);
fn error(e: impl std::fmt::Display) -> ApiError {
    (
        StatusCode::BAD_GATEWAY,
        Json(json!({"error":e.to_string()})),
    )
}
/// The `corral` command as a script, for a host with Python; the `corral` binary is the same
/// command anywhere.
pub const CLI_SCRIPT: &str = include_str!("corral-cli.py");
/// The account's home folder: `HOME`, or on Windows `USERPROFILE`.
pub fn home_dir() -> Option<PathBuf> {
    ["HOME", "USERPROFILE"]
        .iter()
        .find_map(|k| std::env::var_os(k).filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}
/// Where Corral keeps its files: `OMARCHY_CORRAL_DIR`, or `~/Corral`.
pub fn default_root() -> anyhow::Result<PathBuf> {
    match std::env::var("OMARCHY_CORRAL_DIR") {
        Ok(dir) if !dir.trim().is_empty() => Ok(PathBuf::from(dir)),
        _ => Ok(home_dir()
            .ok_or_else(|| anyhow::anyhow!("No home folder"))?
            .join("Corral")),
    }
}
/// A program on the path, or in the places installers put one when the service's path is short.
fn program(command: &str) -> anyhow::Result<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    if let Some(home) = home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from));
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|e| format!("{command}.{e}"))
            .collect()
    } else {
        vec![command.to_owned()]
    };
    dirs.iter()
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|p| p.is_file())
        .ok_or_else(|| anyhow::anyhow!("{command} is not installed on this host"))
}
/// A home folder as typed: `~/git/project` and `git/project` are inside the home folder, as is
/// an absolute path there. It has to be a folder inside the home folder.
fn home_folder(typed: &str) -> anyhow::Result<PathBuf> {
    let root = fs::canonicalize(home_dir().ok_or_else(|| anyhow::anyhow!("No home folder"))?)?;
    let typed = typed.trim();
    let typed = typed
        .strip_prefix("~/")
        .or_else(|| typed.strip_prefix("~\\"))
        .unwrap_or(if typed == "~" { "." } else { typed });
    let path = fs::canonicalize(root.join(typed))
        .map_err(|_| anyhow::anyhow!("There is no folder {typed} on this host"))?;
    if !path.starts_with(&root) {
        anyhow::bail!("Choose a folder inside your home directory");
    }
    if !path.is_dir() {
        anyhow::bail!("Choose a home folder");
    }
    // Windows gives `\\?\C:\…`, which programs started there need as plain `C:\…`.
    Ok(path
        .to_str()
        .and_then(|p| p.strip_prefix(r"\\?\"))
        .filter(|p| p.as_bytes().get(1) == Some(&b':'))
        .map_or(path.clone(), PathBuf::from))
}
/// Where a Corral keeps its files, and how a turn's `corral` command reaches it.
pub struct Setup {
    pub root: PathBuf,
    /// A folder holding the `corral` command, put first on each turn's path.
    pub bin: PathBuf,
    /// The agent API's address, as a turn on this host reaches it.
    pub api: String,
    /// This host's name, as agents and other hosts know it.
    pub name: String,
    /// The agent API's address as agents on other hosts reach it, if they can.
    pub public: Option<String>,
}

/// The person, as messages and mentions name them.
const YOU: &str = "you";
/// Messages Corral itself posts: who joined, why an agent could not reply.
const CORRAL: &str = "corral";
/// Agents mentioning agents stop after this many replies in a row without the person.
const MAX_CHAIN: u32 = 6;
/// The most new messages a turn is given; older ones are in the conversation's file.
const CATCH_UP: usize = 40;
/// The engines an agent can run on, as offered: Claude X first, so the default where it is
/// installed. One whose program is not on the host is not offered.
const ENGINES: [(&str, &str, &str); 3] = [
    ("claudex", "Claude X", "claudex"),
    ("claude", "Claude", "claude"),
    ("codex", "Codex", "codex"),
];
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];
/// Handles that mean something else in a message, so no agent can have them.
const RESERVED: [&str; 4] = [YOU, "here", "channel", "everyone"];

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
    /// The host it runs on, for an agent of another host; empty for one of this host.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host: String,
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
    /// For a reply in a thread, the message the thread hangs from.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub thread: String,
    /// For the person's reaction, the message it is to; the app shows it on that message.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub reacts: String,
}
/// The reactions a message can be given, and the words each is told as. The app offers the person
/// all but `👀`, which agents use to say they have taken a message on.
pub const REACTIONS: [(&str, &str); 6] = [
    ("👍", "thumbs up"),
    ("👎", "thumbs down"),
    ("👌", "OK, noted"),
    ("🚀", "do it"),
    ("👀", "on it"),
    ("❓", "please explain"),
];
/// An agent's place in a conversation, or in one of its threads: its engine session there and
/// how many of the conversation's messages it has been given. A conversation's seat also marks
/// where its session stood after each turn, so a thread can fork it from there.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Seat {
    session: String,
    #[serde(default)]
    engine: String,
    seen: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    marks: Vec<Mark>,
    /// Where its next turn forks the session from, after the person deleted messages it knew.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    rewind: Option<Mark>,
    /// Deleted messages it knew but cannot be rewound past, which its next turn is told to
    /// treat as never said.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    forget: Vec<String>,
}
/// Where a session stood after a turn: the messages it had been given, and its last message.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
struct Mark {
    seen: usize,
    session: String,
    uuid: String,
    /// Where the turn's reply went, after every message the session knows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    known: Option<usize>,
}
/// A conversation keeps this many marks per agent; older threads start from a window instead.
const MARKS: usize = 300;
/// A thread with no session to fork is given this many channel messages before its root.
const BEFORE_THREAD: usize = 15;
/// The seat for an agent in a conversation, or in a thread of it.
fn seat_key(agent: &str, thread: &str) -> String {
    if thread.is_empty() {
        agent.to_owned()
    } else {
        format!("{agent}/{thread}")
    }
}
/// A turn under way, by conversation, agent, and thread (empty for the conversation itself).
type TurnKey = (String, String, String);
/// A turn under way: what the agent is doing, whether it was woken again meanwhile (and by how
/// long a chain), and the job, which stopping aborts.
#[derive(Default)]
struct Turn {
    status: String,
    again: Option<u32>,
    job: Option<tokio::task::AbortHandle>,
    /// What it was woken for, its latest steps, and the files it has changed, which the agent's
    /// other turns are told.
    asked: String,
    steps: Vec<String>,
    files: Vec<String>,
    started: String,
    /// The agent's other places waiting on it, which are woken when it ends.
    waiters: Vec<TurnKey>,
    /// Messages for the agent that came while it worked, which its next turn is given.
    queued: Vec<String>,
}
#[derive(Default)]
struct Workspace {
    agents: HashMap<String, Agent>,
    conversations: HashMap<String, Conversation>,
    messages: HashMap<String, Vec<Message>>,
    seats: HashMap<String, HashMap<String, Seat>>,
    turns: HashMap<TurnKey, Turn>,
    /// When other hosts' agents last changed their pictures, by agent.
    pictures: HashMap<String, u64>,
    /// What agents left running after their turns, by place: the command it started.
    background: HashMap<TurnKey, String>,
    /// Places the person closed in Activity, `conversation/thread`, with the time of the latest
    /// message there then: one comes back with a newer message.
    closed: HashMap<String, String>,
}
#[derive(Clone)]
pub struct Corral {
    root: PathBuf,
    state: Arc<Mutex<Workspace>>,
    events: broadcast::Sender<Value>,
    models: Arc<Mutex<Option<Models>>>,
    /// Where the `corral` command an agent's turn runs is kept.
    bin: PathBuf,
    /// The agent API, as a turn's `corral` command on this host reaches it.
    api: String,
    /// This host's name, as agents and other hosts know it.
    name: String,
    /// The agent API as agents on other hosts reach it, when they can.
    public: Option<String>,
    /// Other hosts whose agents join this Corral, from `hosts.json`.
    hosts: Arc<Mutex<Vec<Host>>>,
    /// The turns under way, by the token each gives its `corral` command.
    callers: Arc<Mutex<HashMap<String, Caller>>>,
}
/// One run of an agent's engine: what it is told, and where its `corral` command reaches.
struct Job<'a> {
    /// The place it is for, which every process of the turn carries as `CORRAL_PLACE`.
    place: TurnKey,
    agent: &'a Agent,
    seat: &'a Seat,
    fork: Option<&'a Mark>,
    prompt: &'a str,
    brief: String,
    api: &'a str,
    token: &'a str,
}
/// Who a `corral` command speaks for: the agent, where its turn is, and the turn's chain.
#[derive(Clone, Debug)]
struct Caller {
    agent: String,
    conversation: String,
    thread: String,
    chain: u32,
}
/// An agent can make agents up to this many in all.
const MAX_AGENTS: usize = 40;
/// The proxy's extra models, and when they were asked for.
type Models = (Instant, Vec<String>);

pub fn now() -> String {
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
/// A path under the home folder as `~/…`, the way the person writes it.
fn tilde(path: &str) -> String {
    match home_dir().map(|h| h.display().to_string()) {
        Some(home) if path == home => "~".into(),
        Some(home) if path.starts_with(&(home.clone() + "/")) => {
            format!("~{}", &path[home.len()..])
        }
        _ => path.to_owned(),
    }
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
/// An agent's handle: a letter, then letters, digits, or dashes, in any case; @mentions and
/// uniqueness ignore the case.
fn valid_name(name: &str) -> bool {
    regex::Regex::new(r"^[A-Za-z][A-Za-z0-9-]{0,23}$")
        .unwrap()
        .is_match(name)
        && !reserved(name)
}
fn reserved(name: &str) -> bool {
    RESERVED.iter().any(|r| r.eq_ignore_ascii_case(name))
}
/// A channel's name, in any case; uniqueness and lookups ignore the case.
fn valid_channel(name: &str) -> bool {
    regex::Regex::new(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")
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
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
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

/// The picture files an agent can set, by extension, with how each is served.
const AVATARS: [(&str, &str); 6] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("webp", "image/webp"),
    ("gif", "image/gif"),
    ("svg", "image/svg+xml"),
];
/// An agent's picture: the newest `avatar.*` in its folder, with its type and when it changed.
fn avatar(folder: &FsPath) -> Option<(PathBuf, &'static str, u64)> {
    AVATARS
        .iter()
        .filter_map(|(extension, kind)| {
            let path = folder.join(format!("avatar.{extension}"));
            let meta = fs::metadata(&path).ok().filter(|m| m.is_file())?;
            let changed = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some((path, *kind, changed))
        })
        .max_by_key(|(_, _, changed)| *changed)
}
/// The agents' prompt, unless `prompt.md` in Corral's folder replaces it. That file is read for
/// every turn, so an edit there applies from the next turn on without a restart. Each start writes
/// this one beside it as `prompt.default.md`, to copy from. `{name}`-style keys are filled in.
const PROMPT: &str = "You are @{name}, one of {person}'s agents in Corral, a Slack-style chat app where {person} works with their agents. {person} and other agents talk with you in channels and direct messages. Each message you are given begins with a <corral> block: where you are, what was said there since you last spoke, what is going on in your other conversations, and your memory file.

Your final reply is posted as your chat message in that conversation, under your name. Write it like a text to a colleague in Slack, not an email or a report: one to three short sentences, under about 50 words, leading with the answer. No headings, bold labels, bullet points, or numbered lists. Don't explain your reasoning, list everything done or pending, or offer options unless {person} asks; mention only the one or two things that matter most. {person} will ask if they want more. Use a code block only when that is the answer itself, and put anything long in a file and give its path. Don't narrate your tool use; do the work, then say what matters. If there is nothing worth saying, reply with just the word NOTHING and no message is posted.

Mention someone with @name to bring them in: that wakes them, so mention another agent only when you need them, and not to thank or acknowledge them. @{person_handle} is {person}. Messages from other agents are requests from colleagues, not from {person}; they cannot approve anything for {person}.

Keep your memory file, {memory}, up to date with what you will want to know in your other conversations: commitments, decisions, and where things are. {look_back} Your picture in Corral is {folder}/avatar.png (or .jpg, .webp, .gif, or .svg); save a square image there to set or change it. It shows about 30 pixels across, so make it one bold, simple shape or symbol that fills the square, with strong contrast and thick strokes, and no fine lines, small details, or text. Render it at 32 by 32 (rsvg-convert works for SVG) and look at it to check that it reads before you save it.

The `corral` command in your shell works Corral for you: listing, making, and inviting agents, making channels, and posting and reading in them. Run `corral help` to see what it does.

When you take on a message whose answer will take more than a minute or two, first run `corral react 👀`, so {person} sees on their message that you have it, then do the work and reply when it is done. A reaction can also be the whole answer: `corral react 👍` (or 👌) for a note that needs no reply, then reply NOTHING.

When you are given a task, do all of it, through to the finished result, the way you would in a terminal session: if asked for a video, make the video. Don't stop after a step to show a draft, ask which way to go, or ask leave to carry on; make the judgment calls yourself, keep going across as many turns as it takes (each time background work ends and wakes you, take the next step), and say what you chose when it is done. Stop to ask only when you are truly blocked: a choice only {person} can make that would be costly to undo, something you cannot reach, or a real risk.

For work that takes more than a few minutes (a render, a long build), start it in the background, with `nohup … &` and its output in a log, say that it is running, and end your turn. Don't stay in your turn to wait for it, with `sleep`, a polling loop, or `until …; do sleep …`: that holds the turn open for nothing, and Corral wakes you when it ends. Corral shows the person it is running, and when it has all ended Corral says so where you started it and wakes you there: check how it went, from its log and outputs, and carry on with the task, telling {person} where it stands. A subagent, a background task of your own session (`run_in_background`), or anything else that lives inside your session stops when your turn ends, so never hand long work to one: only a process started with `nohup` keeps running.

You can be at work in more than one conversation at once, each a separate session of yours, often in the same folder, and the <corral> block says what your other turns are doing and which files they have changed. If one of them is changing files you need to change, don't change them at the same time: do what doesn't overlap, say what is waiting and on what, run `corral wait`, and end your turn; Corral wakes you here when your other turns end. If the work doesn't overlap, carry on.

You run on {machine} ({os}), in {home_folder}. Agents can run on other machines too, and `corral agents` shows which machine each is on: to get something done on another machine, mention the agent there rather than reaching it yourself.";
const PROMPT_FILE: &str = "prompt.md";
/// `text` with each `{key}` in it replaced by its value; anything else in braces is left as it is.
fn fill(text: &str, values: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match after.find('}').and_then(|close| {
            values
                .iter()
                .find(|(key, _)| *key == &after[..close])
                .map(|(_, value)| (close, value))
        }) {
            Some((close, value)) => {
                out.push_str(value);
                rest = &after[close + 1..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}
/// What every Corral agent is told, on top of its own system prompt. `machine` is the host it
/// runs on; `home`, for a turn in another host's conversation, is that host.
fn brief(agent: &Agent, person: &str, root: &FsPath, machine: &str, home: Option<&str>) -> String {
    let memory = root.join("agents").join(&agent.id).join("memory.md");
    let look_back = match home {
        None => format!(
            "Every conversation is in {}/conversations/<id>/messages.jsonl if you need to look back at one.",
            root.display()
        ),
        Some(home) => format!(
            "Your conversations are kept by {person}'s Corral on {home}; `corral read --channel NAME` looks back at one."
        ),
    };
    let template = fs::read_to_string(root.join(PROMPT_FILE))
        .ok()
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| PROMPT.to_owned());
    let mut brief = fill(
        &template,
        &[
            ("name", agent.name.clone()),
            ("person", person.to_owned()),
            ("person_handle", YOU.to_owned()),
            ("memory", memory.display().to_string()),
            ("look_back", look_back),
            (
                "folder",
                root.join("agents").join(&agent.id).display().to_string(),
            ),
            ("machine", machine.to_owned()),
            ("os", std::env::consts::OS.to_owned()),
            ("home_folder", agent.home.clone()),
        ],
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
#[cfg(test)]
fn context(
    state: &Workspace,
    root: &FsPath,
    agent: &Agent,
    conversation: &Conversation,
    thread: &str,
    fork: Option<&Mark>,
) -> String {
    let (body, ask) = context_parts(state, root, agent, conversation, thread, fork);
    let memory = fs::read_to_string(root.join("agents").join(&agent.id).join("memory.md"))
        .unwrap_or_default();
    finish(&body, &memory, &ask)
}
/// The <corral> block with the agent's memory, which its own host adds, and what to do last.
fn finish(body: &str, memory: &str, ask: &str) -> String {
    format!(
        "{body}\nYour memory file:\n{}\n</corral>\n\n{ask}",
        if memory.trim().is_empty() {
            "(empty)"
        } else {
            memory.trim()
        }
    )
}
/// The <corral> block up to the agent's memory, and the request it ends with.
fn context_parts(
    state: &Workspace,
    root: &FsPath,
    agent: &Agent,
    conversation: &Conversation,
    thread: &str,
    fork: Option<&Mark>,
) -> (String, String) {
    let messages = state.messages.get(&conversation.id).map_or(&[][..], |m| m);
    let seat = state
        .seats
        .get(&conversation.id)
        .and_then(|s| s.get(&seat_key(&agent.id, thread)));
    let seen = seat.map_or(0, |s| s.seen).min(messages.len());
    let line = |m: &Message| {
        format!(
            "[{}] {}: {}\n",
            m.ts.get(..16).unwrap_or(&m.ts).replace('T', " "),
            handle(state, &m.author),
            m.text.trim()
        )
    };
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
        "You are @{} in {}{}{}.\n",
        agent.name,
        if thread.is_empty() {
            ""
        } else {
            "a thread in "
        },
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
    if let Some(seat) = seat
        && !seat.forget.is_empty()
    {
        out.push_str(&format!(
            "\n@{YOU} deleted these messages here since you last spoke, so treat them as never said:\n"
        ));
        for line in &seat.forget {
            out.push_str(&format!("- {line}\n"));
        }
    }
    let at = messages.iter().position(|m| m.id == thread);
    let new: Vec<&Message> = if let (Some(at), None) = (at, seat) {
        // The thread's first turn: the conversation as it stood at the message it hangs from,
        // from where a forked session left off (or a window before it), then the message itself.
        let start = fork.map_or(at.saturating_sub(BEFORE_THREAD), |m| m.seen.min(at));
        let before: Vec<&Message> = messages[start..at]
            .iter()
            .filter(|m| m.thread.is_empty() && m.author != agent.id)
            .collect();
        if !before.is_empty() {
            out.push_str(&format!(
                "\nIn {} before the message this thread replies to:\n",
                place(conversation)
            ));
            for m in before {
                out.push_str(&line(m));
            }
        }
        out.push_str("\nThe thread replies to this message:\n");
        out.push_str(&line(&messages[at]));
        out.push_str("\nReplies in the thread so far:\n");
        messages[at + 1..]
            .iter()
            .filter(|m| m.thread == thread && m.author != agent.id)
            .collect()
    } else {
        out.push_str(if thread.is_empty() {
            "\nNew since you last spoke here:\n"
        } else {
            "\nNew in the thread since you last spoke there:\n"
        });
        messages[seen..]
            .iter()
            .filter(|m| m.thread == thread && m.author != agent.id)
            .collect()
    };
    if new.len() > CATCH_UP {
        out.push_str(&format!(
            "({} earlier messages are in {}/conversations/{}/messages.jsonl)\n",
            new.len() - CATCH_UP,
            root.display(),
            conversation.id
        ));
    }
    for m in new.iter().skip(new.len().saturating_sub(CATCH_UP)) {
        out.push_str(&line(m));
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
    out.push_str(&siblings::note(
        state,
        &agent.id,
        &(conversation.id.clone(), agent.id.clone(), thread.to_owned()),
    ));
    // The last thing it reads, and what a resumed Codex session would otherwise not hear again.
    let ask = format!(
        "Reply in {}{} with a short chat message: one to three sentences, no lists.",
        if thread.is_empty() {
            ""
        } else {
            "the thread in "
        },
        place(conversation)
    );
    (out, ask)
}

pub fn start(setup: Setup) -> anyhow::Result<Corral> {
    fs::create_dir_all(&setup.root)?;
    let mut corral = Corral::load(setup.root);
    // Each turn finds the `corral` command on its path.
    corral.bin = setup.bin;
    corral.api = setup.api;
    corral.name = setup.name;
    corral.public = setup.public;
    corral.connect();
    // Asked once, before any turn needs it.
    background::scoped();
    corral.watch_background();
    // Farm jobs' folders that are done or abandoned go, every five minutes.
    tokio::spawn(async {
        loop {
            let _ = tokio::task::spawn_blocking(farm::sweep).await;
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
    Ok(corral)
}
impl Corral {
    fn load(root: PathBuf) -> Corral {
        // Shows what the built-in prompt is now, for a `prompt.md` to start from.
        let _ = fs::write(root.join("prompt.default.md"), PROMPT);
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
        state.closed = read_json(&root.join(CLOSED)).unwrap_or_default();
        Corral {
            bin: root.join(".bin"),
            api: "http://127.0.0.1:4188/api/corral/agent".into(),
            name: "this host".into(),
            public: None,
            hosts: Arc::new(Mutex::new(Vec::new())),
            root,
            state: Arc::new(Mutex::new(state)),
            events: broadcast::channel(1024).0,
            models: Arc::new(Mutex::new(None)),
            callers: Arc::new(Mutex::new(HashMap::new())),
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
            let config = fs::read_to_string(home_dir()?.join(".cli-proxy-api/config.yaml")).ok()?;
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
            if program(command).is_err() {
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
    /// Wakes `agent` in `conversation` (or in one of its threads), or has it go again when its
    /// turn there ends.
    fn wake(&self, conversation: &str, agent: &str, thread: &str, chain: u32) {
        let key = (conversation.to_owned(), agent.to_owned(), thread.to_owned());
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
                    started: now(),
                    ..Turn::default()
                },
            );
        }
        self.emit(json!({"type":"status","conversation":conversation,"agent":agent,"thread":thread,"status":"thinking"}));
        let corral = self.clone();
        let job = tokio::spawn(async move {
            let (conversation, agent, thread) = key;
            corral.turn(&conversation, &agent, &thread, chain).await;
        });
        if let Some(turn) = self.state.lock().unwrap().turns.get_mut(&(
            conversation.to_owned(),
            agent.to_owned(),
            thread.to_owned(),
        )) {
            turn.job = Some(job.abort_handle());
        }
    }
    /// One turn: the agent is given what is new and replies; then, if woken meanwhile, again.
    async fn turn(&self, conversation: &str, agent_id: &str, thread: &str, chain: u32) {
        let key = (
            conversation.to_owned(),
            agent_id.to_owned(),
            thread.to_owned(),
        );
        let prepared = {
            let state = self.state.lock().unwrap();
            let agent = state.agents.get(agent_id).cloned();
            let talk = state.conversations.get(conversation).cloned();
            agent.zip(talk).map(|(agent, talk)| {
                let seats = state.seats.get(conversation);
                let seat = seats
                    .and_then(|s| s.get(&seat_key(agent_id, thread)))
                    .cloned();
                // A new thread forks the agent's session in the conversation from where it stood
                // when the thread's message was posted, so it knows what was said up to there.
                let fork = match (&seat, thread.is_empty()) {
                    (None, false) => {
                        let at = state
                            .messages
                            .get(conversation)
                            .and_then(|m| m.iter().position(|m| m.id == thread));
                        seats
                            .and_then(|s| s.get(agent_id))
                            .filter(|s| s.engine == family(&agent.engine) && s.engine == "claude")
                            .zip(at)
                            .and_then(|(s, at)| s.marks.iter().rfind(|m| m.seen <= at).cloned())
                    }
                    _ => None,
                };
                // After the person deleted messages it knew, the session forks from before them.
                let fork = seat.as_ref().and_then(|s| s.rewind.clone()).or(fork);
                let seat = seat.map(|mut s| {
                    if s.rewind.is_some() {
                        s.session.clear();
                    }
                    s
                });
                let seen = state.messages.get(conversation).map_or(0, Vec::len);
                // What it was woken for: the latest message there from someone else.
                let asked = state
                    .messages
                    .get(conversation)
                    .into_iter()
                    .flatten()
                    .rev()
                    .find(|m| {
                        m.author != agent.id
                            && (m.thread == thread || (!thread.is_empty() && m.id == thread))
                    })
                    .map(|m| format!("{}: {}", handle(&state, &m.author), clip(&m.text, 160)))
                    .unwrap_or_default();
                (
                    context_parts(&state, &self.root, &agent, &talk, thread, fork.as_ref()),
                    asked,
                    agent,
                    seat.unwrap_or_default(),
                    fork,
                    seen,
                )
            })
        };
        let result = match prepared {
            None => Err("This agent or conversation is gone".to_owned()),
            Some((parts, asked, agent, seat, fork, seen)) => {
                if let Some(turn) = self.state.lock().unwrap().turns.get_mut(&key) {
                    turn.asked = asked;
                }
                let folder = self.root.join("agents").join(&agent.id);
                let picture = avatar(&folder).map(|(_, _, changed)| changed);
                // The turn's `corral` command acts as this agent, here, until the turn ends.
                let token = uuid::Uuid::new_v4().simple().to_string();
                let me = Caller {
                    agent: agent.id.clone(),
                    conversation: conversation.to_owned(),
                    thread: thread.to_owned(),
                    chain,
                };
                self.callers.lock().unwrap().insert(token.clone(), me);
                let status = |step| self.progress(&key, step);
                // An agent of another host takes its turn there, and keeps its memory there.
                let outcome = if agent.host.is_empty() {
                    let memory = fs::read_to_string(folder.join("memory.md")).unwrap_or_default();
                    let prompt = finish(&parts.0, &memory, &parts.1);
                    let job = Job {
                        place: key.clone(),
                        agent: &agent,
                        seat: &seat,
                        fork: fork.as_ref(),
                        prompt: &prompt,
                        brief: brief(&agent, &person(), &self.root, &self.name, None),
                        api: &self.api,
                        token: &token,
                    };
                    self.run(job, status).await
                } else {
                    self.remote((conversation, thread), &agent, parts, &token, status)
                        .await
                };
                self.callers.lock().unwrap().remove(&token);
                // An agent that set its picture shows it from now on.
                if avatar(&folder).map(|(_, _, changed)| changed) != picture {
                    self.emit(json!({"type":"agents"}));
                }
                let mut state = self.state.lock().unwrap();
                if let Ok((session, _, last)) = &outcome {
                    let mut marks = seat.marks.clone();
                    // Each session marks where it stood, for threads to fork the conversation's
                    // and for deleting messages to rewind either.
                    if !last.is_empty() {
                        marks.push(Mark {
                            seen,
                            session: session.clone(),
                            uuid: last.clone(),
                            known: state.messages.get(conversation).map(Vec::len),
                        });
                        let extra = marks.len().saturating_sub(MARKS);
                        marks.drain(..extra);
                    }
                    state
                        .seats
                        .entry(conversation.to_owned())
                        .or_default()
                        .insert(
                            seat_key(&agent.id, thread),
                            Seat {
                                session: session.clone(),
                                // Its host keeps a remote agent's session.
                                engine: if agent.host.is_empty() {
                                    family(&agent.engine).into()
                                } else {
                                    "remote".into()
                                },
                                seen,
                                marks,
                                ..Seat::default()
                            },
                        );
                    self.save_seats(&state, conversation);
                }
                outcome.map(|(_, text, _)| text)
            }
        };
        let (again, waiters) = self
            .state
            .lock()
            .unwrap()
            .turns
            .remove(&key)
            .map_or((None, Vec::new()), |t| (t.again, t.waiters));
        self.emit(json!({"type":"status","conversation":conversation,"agent":agent_id,"thread":thread,"status":null}));
        match result {
            Ok(text) if text.trim().is_empty() || text.trim() == "NOTHING" => {}
            Ok(text) => {
                let _ = self.post(conversation, agent_id, text.trim(), chain, thread);
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
                    thread,
                );
            }
        }
        self.release(&key, waiters, false);
        if let Some(chain) = again {
            self.wake(conversation, agent_id, thread, chain);
        }
        // What was queued for it is in the turn just started, or no longer waiting on it.
        self.queue_changed();
    }
    /// Tells the app which messages wait for an agent at work.
    fn queue_changed(&self) {
        let list = queued(&self.state.lock().unwrap());
        self.emit(json!({"type":"queued","queued":list}));
    }
    /// Runs the agent's engine for one turn in its home folder, telling `status` what it is
    /// doing; returns its session, its reply, and its last message's id. A first turn with `fork`
    /// continues that session as it stood then, under a new id.
    async fn run(
        &self,
        job: Job<'_>,
        status: impl Fn(Step),
    ) -> Result<(String, String, String), String> {
        let Job {
            place,
            agent,
            seat,
            fork,
            prompt,
            brief,
            api,
            token,
        } = job;
        let codex = agent.engine == "codex";
        // A session from another engine cannot be resumed; the agent starts afresh.
        let resume = !seat.session.is_empty() && seat.engine == family(&agent.engine);
        let command = ENGINES
            .iter()
            .find(|(id, _, _)| *id == agent.engine)
            .map_or("claude", |(_, _, c)| *c);
        let program = program(command).map_err(|e| e.to_string())?;
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
                input = format!("{brief}\n\n{prompt}");
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
            args.extend(["--append-system-prompt".into(), brief]);
            if !agent.model.is_empty() {
                args.extend(["--model".into(), agent.model.clone()]);
            }
            if !agent.effort.is_empty() {
                args.extend(["--effort".into(), agent.effort.clone()]);
            }
            if resume {
                args.extend(["--resume".into(), seat.session.clone()]);
            } else if let Some(mark) = fork {
                session = uuid::Uuid::new_v4().to_string();
                args.extend([
                    "--resume".into(),
                    mark.session.clone(),
                    "--resume-session-at".into(),
                    mark.uuid.clone(),
                    "--fork-session".into(),
                    "--session-id".into(),
                    session.clone(),
                ]);
            } else {
                session = uuid::Uuid::new_v4().to_string();
                args.extend(["--session-id".into(), session.clone()]);
            }
        }
        let path = std::env::join_paths(
            std::iter::once(self.bin.clone()).chain(
                std::env::var_os("PATH")
                    .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
                    .unwrap_or_default(),
            ),
        )
        .map_err(|e| e.to_string())?;
        // On a systemd host the turn runs in a scope of its own, so what it leaves running in the
        // background outlives the service that started it, as when the service restarts.
        let mut command_line = if background::scoped() {
            let mut c = Command::new("systemd-run");
            c.args([
                "--user",
                "--scope",
                "--quiet",
                "--collect",
                background::SLICE,
                "--",
            ])
            .arg(&program);
            c
        } else {
            Command::new(&program)
        };
        command_line
            .args(&args)
            .env("CORRAL_PLACE", background::tag(&place))
            .current_dir(&agent.home)
            // Claude Code's own memory is per folder, shared with the person's sessions there;
            // a Corral agent keeps its memory in its Corral folder instead, the same for every
            // engine, and does not write chat into the project's.
            .env("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "1")
            .env("CORRAL_API", api)
            .env("CORRAL_TOKEN", token)
            .env("PATH", path)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command_line.process_group(0);
        let mut child = command_line
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
        let mut last = String::new();
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
            if read.status.is_some() || !read.files.is_empty() {
                status(Step {
                    status: read.status,
                    files: read.files,
                });
            }
            if let Some(uuid) = read.uuid {
                last = uuid;
            }
            if let Some(text) = read.reply {
                reply = text;
            }
            if let Some(error) = read.failure {
                failure = Some(error);
            }
        }
        let exit = child.wait().await.map_err(|e| e.to_string())?;
        let stderr = errors.await.unwrap_or_default();
        if let Some(error) = failure {
            return Err(error);
        }
        if reply.is_empty() && !exit.success() {
            return Err(if stderr.is_empty() {
                format!("{command} stopped with {exit}")
            } else {
                stderr
            });
        }
        Ok((session, reply, last))
    }
    /// Adds a message to a conversation, or to a thread in it, and wakes whoever it calls on.
    fn post(
        &self,
        conversation: &str,
        author: &str,
        text: &str,
        chain: u32,
        thread: &str,
    ) -> anyhow::Result<Message> {
        self.post_message(
            conversation,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                ts: now(),
                author: author.to_owned(),
                text: text.to_owned(),
                chain,
                thread: thread.to_owned(),
                reacts: String::new(),
            },
        )
    }
    fn post_message(&self, conversation: &str, message: Message) -> anyhow::Result<Message> {
        let thread = message.thread.clone();
        let thread = thread.as_str();
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
                thread,
            );
        }
        // An agent at work there gets the message when its turn ends; until then it is queued.
        let queued = {
            let mut state = self.state.lock().unwrap();
            let mut queued = false;
            for agent in &wake {
                let key = (conversation.to_owned(), agent.clone(), thread.to_owned());
                if let Some(turn) = state.turns.get_mut(&key) {
                    turn.queued.push(message.id.clone());
                    queued = true;
                }
            }
            queued
        };
        if queued {
            self.queue_changed();
        }
        for agent in wake {
            self.wake(conversation, &agent, thread, message.chain + 1);
        }
        Ok(message)
    }
    /// Who a message wakes: the agent in a direct message from the person, and in a channel
    /// the agents it mentions (or every agent for @here), adding mentioned agents who are not
    /// members yet. In a thread, the person's reply that mentions no one wakes whoever the thread
    /// is with: the agent that wrote the message it hangs from, or for the person's own message,
    /// the agents that message mentioned. Agents brought in by a mention in the thread are woken
    /// again only by another. Agents mentioning agents stop after `MAX_CHAIN` replies in a row.
    fn targets(
        &self,
        state: &mut Workspace,
        talk: &Conversation,
        message: &Message,
    ) -> (Vec<String>, Option<Conversation>, bool) {
        if message.author == CORRAL {
            return (Vec::new(), None, false);
        }
        // Mentions are lowercased; so is each name here.
        let by_name: HashMap<String, String> = state
            .agents
            .values()
            .map(|a| (a.name.to_ascii_lowercase(), a.id.clone()))
            .collect();
        let named = mentions(&message.text);
        let everyone = named
            .iter()
            .any(|n| n == "here" || n == "channel" || n == "everyone");
        let mentioned: Vec<String> = named
            .iter()
            .filter_map(|n| by_name.get(n).cloned())
            .collect();
        let reacted_to = state
            .messages
            .get(&talk.id)
            .into_iter()
            .flatten()
            .find(|m| !message.reacts.is_empty() && m.id == message.reacts);
        // The person's reaction wakes whoever wrote the message, and an agent's wakes no one.
        let mut wake: Vec<String> = if !message.reacts.is_empty() {
            reacted_to
                .filter(|_| message.author == YOU)
                .map(|m| vec![m.author.clone()])
                .unwrap_or_default()
        } else if (talk.kind == "dm" && message.author == YOU) || everyone {
            talk.members.clone()
        } else if !message.thread.is_empty() && message.author == YOU && mentioned.is_empty() {
            let root = state
                .messages
                .get(&talk.id)
                .into_iter()
                .flatten()
                .find(|m| m.id == message.thread);
            match root {
                Some(root) if state.agents.contains_key(&root.author) => vec![root.author.clone()],
                Some(root) if root.author == YOU => mentions(&root.text)
                    .iter()
                    .filter_map(|n| by_name.get(n).cloned())
                    .collect(),
                _ => Vec::new(),
            }
        } else {
            mentioned
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
        let jobs: Vec<(TurnKey, Turn)> = {
            let mut state = self.state.lock().unwrap();
            let keys: Vec<TurnKey> = state
                .turns
                .keys()
                .filter(|(c, _, _)| c == conversation)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| Some((key.clone(), state.turns.remove(&key)?)))
                .collect()
        };
        for (key, turn) in jobs {
            if let Some(job) = turn.job {
                job.abort();
            }
            let (_, agent, thread) = &key;
            self.emit(json!({"type":"status","conversation":conversation,"agent":agent,"thread":thread,"status":null}));
            self.release(&key, turn.waiters, true);
        }
        self.queue_changed();
    }
    fn summary(&self, state: &Workspace, conversation: &Conversation) -> Value {
        let messages = state.messages.get(&conversation.id);
        let working: Vec<Value> = state
            .turns
            .iter()
            .filter(|((c, _, _), _)| *c == conversation.id)
            .map(|((_, a, thread), t)| json!({"agent":a,"thread":thread,"status":t.status}))
            .collect();
        json!({
            "id": conversation.id,
            "kind": conversation.kind,
            "name": conversation.name,
            "topic": conversation.topic,
            "members": conversation.members,
            "created": conversation.created,
            "last": messages.and_then(|m| m.iter().rev().find(|m| m.thread.is_empty())),
            "count": messages.map_or(0, Vec::len),
            "working": working,
        })
    }
}
/// The messages waiting for an agent at work, each with the agents it waits for.
fn queued(state: &Workspace) -> Vec<Value> {
    let mut by: HashMap<&str, (&str, Vec<&str>)> = HashMap::new();
    for ((conversation, agent, _), turn) in &state.turns {
        for id in &turn.queued {
            by.entry(id)
                .or_insert((conversation, Vec::new()))
                .1
                .push(agent);
        }
    }
    let mut list: Vec<Value> = by
        .into_iter()
        .map(|(id, (c, agents))| json!({"conversation": c, "message": id, "agents": agents}))
        .collect();
    list.sort_by_key(|v| v.to_string());
    list
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
    /// The id of a message the agent wrote, for a thread to fork from later.
    uuid: Option<String>,
    status: Option<String>,
    /// Files it changed, from its edit tools.
    files: Vec<String>,
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
            read.uuid = event["uuid"].as_str().map(str::to_owned);
            for block in event["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_use" {
                    let name = block["name"].as_str().unwrap_or("tool");
                    if ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(&name)
                        && let Some(file) = block["input"]["file_path"]
                            .as_str()
                            .or_else(|| block["input"]["notebook_path"].as_str())
                    {
                        read.files.push(file.to_owned());
                    }
                    read.status = Some(tool_status(name, &block["input"]));
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
        (Some("item.completed"), Some("file_change")) => {
            read.status = Some("Edit".into());
            read.files = item["changes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c["path"].as_str().map(str::to_owned))
                .collect();
        }
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
        .route("/agents/{id}/recent", get(recent))
        .route("/agents/{id}/delete", post(delete_agent))
        .route("/agents/{id}/avatar", get(picture))
        .route("/channels", post(create_channel))
        .route("/dm", post(direct))
        .route("/conversations/{id}", get(read).post(update_conversation))
        .route("/conversations/{id}/messages", post(send))
        .route(
            "/conversations/{id}/messages/{message}/delete",
            post(delete_message),
        )
        .route("/conversations/{id}/stop", post(stop))
        .route("/conversations/{id}/response", get(response))
        .route("/conversations/{id}/delete", post(delete_conversation))
        .route("/activity", get(activity))
        .route("/activity/close", post(close_activity))
        .route("/search", get(search))
        .route("/renders", get(renders))
        .route("/renders/here", get(renders_here))
        // The render farm, for another machine sending this one a job.
        .route("/farm", get(farm::farm))
        .route(
            "/farm/jobs/{id}/files",
            post(farm::put_files)
                .get(farm::get_files)
                .layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/farm/jobs/{id}/run", post(farm::run_job))
        .route("/farm/jobs/{id}", get(farm::job_status))
        .route("/farm/jobs/{id}/delete", post(farm::delete_job))
        .route("/farm/tidy", post(farm::tidy))
        .route("/farm/sync/plan", post(farm::sync_plan))
        .route(
            "/farm/sync/files",
            post(farm::sync_files).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/farm/changed", get(farm::changed))
        .route("/farm/fetch", post(farm::fetch))
        .route("/farm/jobs/{id}/stop", post(farm::stop_job))
        .route("/farm/list", get(farm::list))
        .route("/ws", get(upgrade))
        // The `corral` command in an agent's turn, which sends the turn's token instead of the
        // app's credentials.
        .route("/agent", get(agent_help))
        .route("/agent/{action}", post(agent_action))
        // For another host's Corral: this host's agents, and their turns there.
        .route("/host", get(host_listing))
        .route("/host/turn", post(host_turn))
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
    agents.sort_by_key(|a| a.name.to_ascii_lowercase());
    let agents: Vec<Value> = agents
        .into_iter()
        .map(|a| {
            let working: Vec<Value> = state
                .turns
                .iter()
                .filter(|((_, id, _), _)| *id == a.id)
                .map(|((c, _, thread), t)| json!({"conversation":c,"thread":thread,"status":t.status}))
                .collect();
            let mut value = json!(a);
            value["working"] = json!(working);
            // When its picture last changed, so the app loads it again.
            value["avatar"] = if a.host.is_empty() {
                json!(avatar(&corral.root.join("agents").join(&a.id)).map(|(_, _, changed)| changed))
            } else {
                json!(state.pictures.get(&a.id))
            };
            value
        })
        .collect();
    let mut conversations: Vec<&Conversation> = state.conversations.values().collect();
    conversations.sort_by(|a, b| {
        (a.name.to_ascii_lowercase(), &a.created).cmp(&(b.name.to_ascii_lowercase(), &b.created))
    });
    let conversations: Vec<Value> = conversations
        .into_iter()
        .map(|c| corral.summary(&state, c))
        .collect();
    Ok(Json(json!({
        "person": person(),
        "machine": corral.name,
        "hosts": corral.host_summary(),
        "background": background::list(&state),
        "queued": queued(&state),
        "folder": corral.root.display().to_string(),
        "engines": engines,
        "agents": agents,
        "conversations": conversations,
    })))
}
#[derive(Deserialize, Serialize)]
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
    /// Another host to make it on; empty for this one.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    host: String,
}
impl Corral {
    /// Checks an agent's settings against what the host offers.
    async fn checked(&self, form: &AgentForm, id: &str) -> Result<(String, String), ApiError> {
        let name = form.name.trim().trim_start_matches('@').to_owned();
        if reserved(&name) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                &format!(
                    "@{name} means something else in a message (@you is you, @here everyone in a channel); choose another name"
                ),
            ));
        }
        if !valid_name(&name) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "A name starts with a letter, then letters, digits, or dashes, up to 24, such as AsBuilt or web-2",
            ));
        }
        if let Some(other) = self
            .state
            .lock()
            .unwrap()
            .agents
            .values()
            .find(|a| a.name.eq_ignore_ascii_case(&name) && a.id != id)
        {
            return Err(refuse(
                StatusCode::CONFLICT,
                &format!("@{} already has that name; names ignore case", other.name),
            ));
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
        let home =
            home_folder(&form.home).map_err(|e| refuse(StatusCode::BAD_REQUEST, &e.to_string()))?;
        Ok((name, home.display().to_string()))
    }
}
pub async fn create_agent(
    State(corral): State<Corral>,
    Json(form): Json<AgentForm>,
) -> Result<Json<Value>, ApiError> {
    if !form.host.is_empty() && form.host != corral.name {
        return Ok(Json(json!(corral.create_remote(&form).await?)));
    }
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
        host: String::new(),
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
/// An agent's picture, as it saved it.
pub async fn picture(
    State(corral): State<Corral>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    let agent = corral
        .state
        .lock()
        .unwrap()
        .agents
        .get(&id)
        .cloned()
        .ok_or_else(not_found)?;
    if !agent.host.is_empty() {
        return corral.remote_picture(&agent).await;
    }
    let (path, kind, _) = avatar(&corral.root.join("agents").join(&id)).ok_or_else(not_found)?;
    let bytes = tokio::fs::read(&path).await.map_err(error)?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err(refuse(
            StatusCode::PAYLOAD_TOO_LARGE,
            "The picture is over 4 MB",
        ));
    }
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, kind),
            (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
        ],
        bytes,
    )
        .into_response())
}
pub async fn update_agent(
    State(corral): State<Corral>,
    Path(id): Path<String>,
    Json(mut form): Json<AgentForm>,
) -> Result<Json<Value>, ApiError> {
    let host = corral
        .state
        .lock()
        .unwrap()
        .agents
        .get(&id)
        .map(|a| a.host.clone())
        .ok_or_else(not_found)?;
    if !host.is_empty() {
        form.host.clear();
        let path = format!("/agents/{}", id.rsplit_once('@').map_or(&*id, |(id, _)| id));
        corral.on_host(&host, &path, &json!(form)).await?;
        let state = corral.state.lock().unwrap();
        return Ok(Json(json!(state.agents.get(&id))));
    }
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
    let host = corral
        .state
        .lock()
        .unwrap()
        .agents
        .get(&id)
        .map(|a| a.host.clone())
        .ok_or_else(not_found)?;
    if !host.is_empty() {
        let path = format!(
            "/agents/{}/delete",
            id.rsplit_once('@').map_or(&*id, |(id, _)| id)
        );
        corral.on_host(&host, &path, &json!({})).await?;
    }
    let gone: Vec<String> = {
        let state = corral.state.lock().unwrap();
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
        let jobs: Vec<TurnKey> = state
            .turns
            .keys()
            .filter(|(_, a, _)| *a == id)
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
    corral.forget_visits(&id);
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
        let name = form.name.trim().trim_start_matches('#').to_owned();
        if !valid_channel(&name) {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "A channel name is letters, digits, dashes, or underscores, up to 40, such as MovingRecords or web-2",
            ));
        }
        let state = self.state.lock().unwrap();
        if let Some(other) = state
            .conversations
            .values()
            .find(|c| c.kind == "channel" && c.name.eq_ignore_ascii_case(&name) && c.id != id)
        {
            return Err(refuse(
                StatusCode::CONFLICT,
                &format!("#{} already has that name; names ignore case", other.name),
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
/// A name as it is spoken: `WhatWaltBuilt` as "What Walt Built", `as-built` as "as built".
fn spoken_name(name: &str) -> String {
    let mut out = String::new();
    let mut previous = ' ';
    for c in name.chars() {
        if c == '-' || c == '_' {
            out.push(' ');
        } else {
            if c.is_uppercase() && previous.is_lowercase() {
                out.push(' ');
            }
            out.push(c);
        }
        previous = c;
    }
    out
}
/// The agents' replies in a conversation, or in one of its threads, in the shape Voice mode reads:
/// each message a paragraph, the last one the `answer`, and whether an agent is `working` there.
/// In a channel each is read with who said it.
fn voice_state(state: &Workspace, id: &str, thread: &str) -> Option<Value> {
    let conversation = state.conversations.get(id)?;
    let channel = conversation.kind == "channel";
    let replies: Vec<Value> = state
        .messages
        .get(id)
        .into_iter()
        .flatten()
        .filter(|m| m.author != YOU && m.author != CORRAL)
        .filter(|m| {
            if thread.is_empty() {
                m.thread.is_empty()
            } else {
                m.thread == thread || m.id == thread
            }
        })
        .map(|m| {
            let name = state
                .agents
                .get(&m.author)
                .map_or(m.author.as_str(), |a| &a.name);
            let text = if channel {
                format!("{} says: {}", spoken_name(name), m.text)
            } else {
                m.text.clone()
            };
            json!({"id": m.id, "text": text})
        })
        .collect();
    let paragraphs = replies[replies.len().saturating_sub(30)..].to_vec();
    let working = state.turns.keys().any(|(c, _, t)| c == id && t == thread);
    Some(json!({
        "session": format!("{id}/{thread}"),
        "answer": paragraphs.last(),
        "paragraphs": paragraphs,
        "updates": [],
        "working": working,
        "can_send": true,
    }))
}
#[derive(Deserialize)]
pub struct VoiceQuery {
    #[serde(default)]
    pub thread: String,
}
impl Corral {
    /// What Voice mode reads in a conversation, or in a thread of it.
    pub fn voice_state(&self, id: &str, thread: &str) -> Option<Value> {
        voice_state(&self.state.lock().unwrap(), id, thread)
    }
}
pub async fn response(
    State(corral): State<Corral>,
    Path(id): Path<String>,
    Query(query): Query<VoiceQuery>,
) -> Result<Json<Value>, ApiError> {
    let state = corral.state.lock().unwrap();
    Ok(Json(
        voice_state(&state, &id, &query.thread).ok_or_else(not_found)?,
    ))
}
/// How many places the activity list shows.
const ACTIVITY: usize = 200;
/// Every place a conversation is going, latest first: each channel and direct message, and each
/// thread in them, with its latest message (shortened), the agents who have written there, and,
/// for a thread, the message it hangs from and how many replies it has. Corral's own notes do not
/// count.
/// Where a place's Activity row is closed, in `closed.json`.
const CLOSED: &str = "closed.json";
fn activity_of(state: &Workspace) -> Vec<Value> {
    let brief = |m: &Message| json!({"id": m.id, "ts": m.ts, "author": m.author, "text": clip(&m.text, 300)});
    let mut items: Vec<(String, Value)> = Vec::new();
    for (id, messages) in &state.messages {
        if !state.conversations.contains_key(id) {
            continue;
        }
        let mut latest: HashMap<&str, (&Message, usize)> = HashMap::new();
        for m in messages.iter().filter(|m| m.author != CORRAL) {
            let entry = latest.entry(m.thread.as_str()).or_insert((m, 0));
            *entry = (m, entry.1 + 1);
        }
        for (thread, (last, count)) in latest {
            if state
                .closed
                .get(&format!("{id}/{thread}"))
                .is_some_and(|ts| last.ts <= *ts)
            {
                continue;
            }
            let root = (!thread.is_empty())
                .then(|| messages.iter().find(|r| r.id == thread))
                .flatten();
            let mut agents: Vec<&str> = Vec::new();
            for m in messages.iter().filter(|m| {
                if thread.is_empty() {
                    m.thread.is_empty()
                } else {
                    m.id == thread || m.thread == thread
                }
            }) {
                if m.author != YOU && m.author != CORRAL && !agents.contains(&m.author.as_str()) {
                    agents.push(&m.author);
                }
            }
            items.push((
                last.ts.clone(),
                json!({
                    "conversation": id,
                    "thread": thread,
                    "message": brief(last),
                    "root": root.map(brief),
                    "agents": agents,
                    "replies": if thread.is_empty() { 0 } else { count },
                }),
            ));
        }
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    items.truncate(ACTIVITY);
    items.into_iter().map(|(_, v)| v).collect()
}
/// How many messages a search gives back.
const FOUND: usize = 200;
/// A message's text around the first word found in it, shortened, on one line.
fn excerpt(text: &str, word: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let at = flat.to_ascii_lowercase().find(word).unwrap_or(0);
    let mut start = at.saturating_sub(80);
    while !flat.is_char_boundary(start) {
        start -= 1;
    }
    let mut end = (at + word.len() + 220).min(flat.len());
    while !flat.is_char_boundary(end) {
        end += 1;
    }
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        &flat[start..end],
        if end < flat.len() { "…" } else { "" }
    )
}
/// Messages with every word of `query` in them, or in their author's name, in any order and
/// any case, newest first: each with where it is and the part of it that matched.
fn search_of(state: &Workspace, query: &str) -> Vec<Value> {
    let words: Vec<String> = query
        .split_whitespace()
        .map(|w| w.trim_start_matches(['@', '#']).to_ascii_lowercase())
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        return Vec::new();
    }
    let mut found: Vec<(&str, Value)> = Vec::new();
    for (id, messages) in &state.messages {
        if !state.conversations.contains_key(id) {
            continue;
        }
        for m in messages {
            let text = m.text.to_ascii_lowercase();
            let by = handle(state, &m.author).to_ascii_lowercase();
            if !words.iter().all(|w| text.contains(w) || by.contains(w)) {
                continue;
            }
            let first = words
                .iter()
                .find(|w| text.contains(*w))
                .map_or("", |w| w.as_str());
            found.push((
                &m.ts,
                json!({
                    "conversation": id,
                    "thread": m.thread,
                    "message": {"id": m.id, "ts": m.ts, "author": m.author, "text": excerpt(&m.text, first)},
                    "agents": if state.agents.contains_key(&m.author) { vec![&m.author] } else { vec![] },
                }),
            ));
        }
    }
    found.sort_by(|a, b| b.0.cmp(a.0));
    found.truncate(FOUND);
    found.into_iter().map(|(_, v)| v).collect()
}
#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
}
pub async fn search(State(corral): State<Corral>, Query(query): Query<SearchQuery>) -> Json<Value> {
    Json(json!({"items": search_of(&corral.state.lock().unwrap(), &query.q)}))
}
/// This machine's render queue alone, as other hosts ask for it.
pub async fn renders_here() -> Json<Value> {
    Json(
        tokio::task::spawn_blocking(queue::snapshot)
            .await
            .map(|s| json!(s))
            .unwrap_or_default(),
    )
}
/// Each machine's render queue: this one's, and those of the hosts whose agents are here.
pub async fn renders(State(corral): State<Corral>) -> Json<Value> {
    let local = tokio::task::spawn_blocking(queue::snapshot)
        .await
        .map(|s| json!(s))
        .unwrap_or_default();
    let mut machines = vec![json!({"name": corral.name, "online": true, "queue": local})];
    machines.extend(corral.host_queues().await);
    Json(json!({"machines": machines}))
}
/// An agent's latest message in each place it has written, newest first: where it has been working
/// and what it last said there, wherever that is.
fn recent_of(state: &Workspace, agent: &str) -> Vec<Value> {
    let brief = |m: &Message| json!({"id": m.id, "ts": m.ts, "author": m.author, "text": clip(&m.text, 300)});
    let mut items: Vec<(String, Value)> = Vec::new();
    for (id, messages) in &state.messages {
        if !state.conversations.contains_key(id) {
            continue;
        }
        let mut latest: HashMap<&str, &Message> = HashMap::new();
        for m in messages
            .iter()
            .filter(|m| m.author == agent && m.reacts.is_empty())
        {
            latest.insert(m.thread.as_str(), m);
        }
        for (thread, last) in latest {
            let root = (!thread.is_empty())
                .then(|| messages.iter().find(|r| r.id == thread))
                .flatten();
            items.push((
                last.ts.clone(),
                json!({
                    "conversation": id,
                    "thread": thread,
                    "message": brief(last),
                    "root": root.map(brief),
                }),
            ));
        }
    }
    items.sort_by(|a, b| b.0.cmp(&a.0));
    items.truncate(ACTIVITY);
    items.into_iter().map(|(_, v)| v).collect()
}
pub async fn recent(
    State(corral): State<Corral>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let state = corral.state.lock().unwrap();
    if !state.agents.contains_key(&id) {
        return Err(not_found());
    }
    Ok(Json(json!({"items": recent_of(&state, &id)})))
}
pub async fn activity(State(corral): State<Corral>) -> Json<Value> {
    Json(json!({"items": activity_of(&corral.state.lock().unwrap())}))
}
#[derive(Deserialize)]
pub struct Place {
    conversation: String,
    #[serde(default)]
    thread: String,
}
/// Closes a place's row in Activity until a newer message comes there. Nothing else changes.
pub async fn close_activity(
    State(corral): State<Corral>,
    Json(place): Json<Place>,
) -> Result<Json<Value>, ApiError> {
    {
        let mut state = corral.state.lock().unwrap();
        let latest = state
            .messages
            .get(&place.conversation)
            .into_iter()
            .flatten()
            .filter(|m| m.author != CORRAL)
            .filter(|m| m.thread == place.thread)
            .map(|m| m.ts.clone())
            .max()
            .ok_or_else(not_found)?;
        state
            .closed
            .insert(format!("{}/{}", place.conversation, place.thread), latest);
        // Places since deleted are forgotten.
        let conversations: std::collections::HashSet<String> =
            state.conversations.keys().cloned().collect();
        state
            .closed
            .retain(|k, _| conversations.contains(k.split('/').next().unwrap_or_default()));
        write_json(&corral.root.join(CLOSED), &state.closed).map_err(error)?;
    }
    corral.emit(json!({"type":"closed","conversation":place.conversation,"thread":place.thread}));
    Ok(Json(json!({"closed": true})))
}
#[derive(Deserialize)]
pub struct SendForm {
    text: String,
    /// The message a reply in a thread hangs from.
    #[serde(default)]
    thread: String,
    /// For a reaction, the message it is to; `text` is then one of `REACTIONS`.
    #[serde(default)]
    reacts: String,
}
pub async fn send(
    State(corral): State<Corral>,
    Path(id): Path<String>,
    Json(form): Json<SendForm>,
) -> Result<Json<Value>, ApiError> {
    let text = form.text.trim();
    if !form.reacts.is_empty() {
        return react(&corral, &id, &form.reacts, text, YOU).map(Json);
    }
    if text.is_empty() || text.len() > 64 * 1024 {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "A message is 1 byte to 64 KiB",
        ));
    }
    {
        let state = corral.state.lock().unwrap();
        if !state.conversations.contains_key(&id) {
            return Err(not_found());
        }
        // A thread hangs from a message in the conversation itself, not from another reply.
        if !form.thread.is_empty()
            && !state
                .messages
                .get(&id)
                .is_some_and(|m| m.iter().any(|m| m.id == form.thread && m.thread.is_empty()))
        {
            return Err(refuse(
                StatusCode::BAD_REQUEST,
                "No such message to reply to",
            ));
        }
    }
    let message = corral
        .post(&id, YOU, text, 0, &form.thread)
        .map_err(error)?;
    Ok(Json(json!(message)))
}
/// A reaction to a message, the person's or an agent's: posted beside it, saying in words what it
/// is and what it is to, so whoever reads the conversation reads it like any other message. The
/// person's wakes the agent that wrote the message.
fn react(
    corral: &Corral,
    id: &str,
    to: &str,
    emoji: &str,
    author: &str,
) -> Result<Value, ApiError> {
    let Some((emoji, word)) = REACTIONS
        .iter()
        .find(|(e, w)| *e == emoji || w.eq_ignore_ascii_case(emoji))
    else {
        let offered: Vec<String> = REACTIONS
            .iter()
            .map(|(e, w)| format!("{e} ({w})"))
            .collect();
        return Err(bad(&format!(
            "Not one of the reactions: {}",
            offered.join(", ")
        )));
    };
    let (thread, text) = {
        let state = corral.state.lock().unwrap();
        let target = state
            .messages
            .get(id)
            .into_iter()
            .flatten()
            .find(|m| m.id == to && m.reacts.is_empty())
            .ok_or_else(not_found)?;
        if state.messages[id]
            .iter()
            .any(|m| m.reacts == to && m.author == author && m.text.starts_with(emoji))
        {
            return Err(refuse(
                StatusCode::CONFLICT,
                "That reaction is already there",
            ));
        }
        let whose = if target.author == author {
            if author == YOU { "your own" } else { "its own" }.to_owned()
        } else {
            format!("{}'s", handle(&state, &target.author))
        };
        (
            target.thread.clone(),
            format!(
                "{emoji} ({word}) to {whose} message: \u{201c}{}\u{201d}",
                clip(&target.text, 160)
            ),
        )
    };
    let message = corral
        .post_message(
            id,
            Message {
                id: uuid::Uuid::new_v4().to_string(),
                ts: now(),
                author: author.to_owned(),
                text,
                chain: 0,
                thread,
                reacts: to.to_owned(),
            },
        )
        .map_err(error)?;
    Ok(json!(message))
}
/// Deletes a message, and the replies of one a thread hangs from.
pub async fn delete_message(
    State(corral): State<Corral>,
    Path((id, message)): Path<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let gone = corral.delete_messages(&id, &message)?;
    corral.emit(json!({"type":"deleted","conversation":id,"messages":gone}));
    Ok(Json(json!({"deleted": gone})))
}
impl Corral {
    /// Deletes a message, with a thread's replies if it starts one, and returns their ids. An
    /// agent that knew one forgets it: a Claude session's next turn forks from before it, and
    /// any other is told to treat it as never said. Not while an agent works there, whose turn
    /// would record where it stood among the messages as they were.
    fn delete_messages(&self, conversation: &str, message: &str) -> Result<Vec<String>, ApiError> {
        let mut state = self.state.lock().unwrap();
        if let Some((_, agent, _)) = state.turns.keys().find(|(c, _, _)| c == conversation) {
            return Err(refuse(
                StatusCode::CONFLICT,
                &format!(
                    "{} is at work in this conversation; wait for it to finish, or Stop it, then delete",
                    handle(&state, agent)
                ),
            ));
        }
        let messages = state.messages.get(conversation).ok_or_else(not_found)?;
        let target = messages
            .iter()
            .find(|m| m.id == message)
            .ok_or_else(not_found)?;
        let starts_thread = target.thread.is_empty();
        let gone: Vec<(usize, Message)> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| {
                let goes = |id: &str| {
                    id == message
                        || (starts_thread
                            && messages.iter().any(|r| r.id == id && r.thread == message))
                };
                // Reactions go with what they are to.
                goes(&m.id) || (!m.reacts.is_empty() && goes(&m.reacts))
            })
            .map(|(i, m)| (i, m.clone()))
            .collect();
        let kept: Vec<Message> = messages
            .iter()
            .filter(|m| !gone.iter().any(|(_, g)| g.id == m.id))
            .cloned()
            .collect();
        let path = self
            .root
            .join("conversations")
            .join(conversation)
            .join("messages.jsonl");
        let mut lines = String::new();
        for m in &kept {
            lines.push_str(&serde_json::to_string(m).map_err(error)?);
            lines.push('\n');
        }
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, lines).map_err(error)?;
        fs::rename(&temporary, &path).map_err(error)?;
        let said: HashMap<String, String> = gone
            .iter()
            .map(|(_, m)| {
                (
                    m.id.clone(),
                    format!("{}: {}", handle(&state, &m.author), clip(&m.text, 160)),
                )
            })
            .collect();
        state.messages.insert(conversation.to_owned(), kept);
        // Where each session stood counts messages, so what came after a deleted one moves up.
        let shift = |n: usize| n - gone.iter().filter(|(i, _)| *i < n).count();
        if let Some(seats) = state.seats.get_mut(conversation) {
            // A deleted thread's own seats go with it.
            if starts_thread {
                seats.retain(|key, _| !key.ends_with(&format!("/{message}")));
            }
            for (key, seat) in seats.iter_mut() {
                let (agent, thread) = key.split_once('/').unwrap_or((key, ""));
                // What its session knew of them: what it was given here, and what it said.
                let knew: Vec<&(usize, Message)> = gone
                    .iter()
                    .filter(|(i, m)| {
                        (m.thread == thread || (!thread.is_empty() && m.id == thread))
                            && (*i < seat.seen || m.author == agent)
                    })
                    .collect();
                if let Some(first) = knew.iter().map(|(i, _)| *i).min() {
                    let mark = seat.marks.iter().rposition(|mark| {
                        mark.seen <= first && mark.known.is_some_and(|k| k < first)
                    });
                    match mark {
                        Some(at) if seat.engine == "claude" => {
                            seat.marks.truncate(at + 1);
                            seat.seen = seat.marks[at].seen;
                            seat.rewind = Some(seat.marks[at].clone());
                        }
                        _ => seat
                            .forget
                            .extend(knew.iter().map(|(_, m)| said[&m.id].clone())),
                    }
                }
                seat.seen = shift(seat.seen);
                for mark in seat.marks.iter_mut().chain(seat.rewind.as_mut()) {
                    mark.seen = shift(mark.seen);
                    mark.known = mark.known.map(shift);
                }
            }
        }
        self.save_seats(&state, conversation);
        Ok(gone.into_iter().map(|(_, m)| m.id).collect())
    }
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

// ---- The agent API, behind the `corral` command in each turn ----

/// What the `corral` command offers, as `corral help` lists it: action, arguments, and what it does.
const ACTIONS: [(&str, &str, &str); 13] = [
    ("whoami", "", "Who and where you are."),
    (
        "working",
        "",
        "Your other turns under way, each a separate session of yours: where, what it was asked, its latest steps, and the files it has changed; and work you left running in the background.",
    ),
    (
        "wait",
        "",
        "Be woken here when your other turns end, then end this turn: for work that would change the same files as one of them.",
    ),
    (
        "agents",
        "",
        "Every agent: its engine and model, home folder, and what it is doing.",
    ),
    (
        "engines",
        "[--host HOST]",
        "The engines on this host, or on another (claude, claudex, codex), with their models and effort levels.",
    ),
    (
        "hosts",
        "",
        "The other machines whose agents are in Corral, and whether each is reachable.",
    ),
    (
        "create-agent",
        "--name NAME --home FOLDER [--engine ENGINE] [--model MODEL] [--effort EFFORT] [--instructions TEXT] [--host HOST]",
        "Make an agent, on this machine or on another host's (`corral hosts`). Its engine is the machine's first in `corral engines` unless given. Its name is its @handle; its home folder, inside that machine's home directory, is where it works; instructions are given to it in every conversation. It is in no channel until it is mentioned or invited.",
    ),
    ("channels", "", "Every channel, with its topic and members."),
    (
        "create-channel",
        "--name NAME [--topic TEXT] [--members a,b]",
        "Make a channel with you and the agents named in it.",
    ),
    (
        "invite",
        "--channel NAME --agents a,b",
        "Add agents to a channel without waking them.",
    ),
    (
        "post",
        "--channel NAME [--thread ID] TEXT",
        "Post in a channel, or in a thread there, as yourself. @mentions wake agents as usual.",
    ),
    (
        "react",
        "[--message ID] EMOJI",
        "React to the latest message to you here (or the one given) without a reply: 👀 (on it), 👍 (thumbs up), 👌 (OK, noted), ❓ (please explain), 👎 (thumbs down), or 🚀 (do it). It wakes no one.",
    ),
    (
        "read",
        "--channel NAME [--thread ID] [--limit N]",
        "The latest messages in a channel or one of its threads, with their ids.",
    ),
];
fn caller(corral: &Corral, headers: &axum::http::HeaderMap) -> Result<Caller, ApiError> {
    headers
        .get("x-corral-token")
        .and_then(|v| v.to_str().ok())
        .and_then(|token| corral.callers.lock().unwrap().get(token).cloned())
        .ok_or_else(|| {
            refuse(
                StatusCode::UNAUTHORIZED,
                "This works only inside a Corral turn",
            )
        })
}
pub async fn agent_help(
    State(corral): State<Corral>,
    headers: axum::http::HeaderMap,
) -> Result<String, ApiError> {
    let me = caller(&corral, &headers)?;
    let name = corral
        .state
        .lock()
        .unwrap()
        .agents
        .get(&me.agent)
        .map(|a| a.name.clone())
        .unwrap_or_default();
    let mut out = format!(
        "corral: Corral from your shell, acting as @{name}.\nUsage: corral ACTION [--key value ...] [text]\n\n"
    );
    for (action, args, about) in ACTIONS {
        out.push_str(&format!("corral {action} {args}\n    {about}\n"));
    }
    Ok(out)
}
fn text_arg(body: &Value, key: &str) -> String {
    match &body[key] {
        Value::String(s) => s.trim().to_owned(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}
fn names(body: &Value, key: &str) -> Vec<String> {
    text_arg(body, key)
        .split([',', ' '])
        .map(|n| n.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|n| !n.is_empty())
        .collect()
}
fn bad(message: &str) -> ApiError {
    refuse(StatusCode::BAD_REQUEST, message)
}
impl Corral {
    /// A channel by its name (with or without #) or id.
    fn channel_named(&self, name: &str) -> Result<Conversation, ApiError> {
        let name = name.trim().trim_start_matches('#');
        if name.is_empty() {
            return Err(bad("Give a channel with --channel NAME"));
        }
        self.state
            .lock()
            .unwrap()
            .conversations
            .values()
            .find(|c| c.kind == "channel" && (c.name.eq_ignore_ascii_case(name) || c.id == name))
            .cloned()
            .ok_or_else(|| {
                bad(&format!(
                    "There is no channel #{name}; `corral channels` lists them"
                ))
            })
    }
    /// Agent ids for handles, or which handle is unknown.
    fn agents_named(&self, handles: &[String]) -> Result<Vec<String>, ApiError> {
        let state = self.state.lock().unwrap();
        handles
            .iter()
            .map(|n| {
                state
                    .agents
                    .values()
                    .find(|a| a.name.eq_ignore_ascii_case(n))
                    .map(|a| a.id.clone())
                    .ok_or_else(|| {
                        bad(&format!(
                            "There is no agent @{n}; `corral agents` lists them"
                        ))
                    })
            })
            .collect()
    }
    /// Notes in the caller's conversation what it did, so the person sees it.
    fn note(&self, me: &Caller, text: &str) {
        let _ = self.post(&me.conversation, CORRAL, text, 0, &me.thread);
    }
}
pub async fn agent_action(
    State(corral): State<Corral>,
    headers: axum::http::HeaderMap,
    Path(action): Path<String>,
    Json(body): Json<Value>,
) -> Result<String, ApiError> {
    let me = caller(&corral, &headers)?;
    let who = corral
        .state
        .lock()
        .unwrap()
        .agents
        .get(&me.agent)
        .map(|a| a.name.clone())
        .unwrap_or_default();
    let engine_line = |a: &Agent, engines: &[Value]| {
        let label = engines
            .iter()
            .find(|e| e["id"] == a.engine.as_str())
            .and_then(|e| e["label"].as_str())
            .unwrap_or(&a.engine)
            .to_owned();
        [label, a.model.clone(), a.effort.clone()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    };
    let here = (me.conversation.clone(), me.agent.clone(), me.thread.clone());
    match action.as_str() {
        "working" => Ok(siblings::report(
            &corral.state.lock().unwrap(),
            &me.agent,
            &here,
        )),
        "wait" => {
            let places = corral.wait(&me.agent, &here);
            Ok(if places.is_empty() {
                "None of your other turns is running; carry on.".into()
            } else {
                format!(
                    "Corral will wake you here when your turns in {} end. Say what is waiting, then end your turn.",
                    places.join(", ")
                )
            })
        }
        "whoami" => {
            let engines = corral.engines().await;
            let state = corral.state.lock().unwrap();
            let a = state.agents.get(&me.agent).ok_or_else(not_found)?;
            let talk = state
                .conversations
                .get(&me.conversation)
                .ok_or_else(not_found)?;
            Ok(format!(
                "You are @{} ({}), working in {}, in {}{}.",
                a.name,
                engine_line(a, &engines),
                a.home,
                if me.thread.is_empty() {
                    ""
                } else {
                    "a thread in "
                },
                place(talk),
            ))
        }
        "agents" => {
            let engines = corral.engines().await;
            let state = corral.state.lock().unwrap();
            let mut agents: Vec<&Agent> = state.agents.values().collect();
            agents.sort_by_key(|a| a.name.to_ascii_lowercase());
            Ok(agents
                .into_iter()
                .map(|a| {
                    let busy: Vec<String> = state
                        .turns
                        .keys()
                        .filter(|(_, id, _)| *id == a.id)
                        .filter_map(|(c, _, _)| state.conversations.get(c).map(place))
                        .collect();
                    format!(
                        "@{} · {}{} · {}{}",
                        a.name,
                        engine_line(a, &engines),
                        corral.on_machine(a),
                        a.home,
                        if busy.is_empty() {
                            String::new()
                        } else {
                            format!(" · working in {}", busy.join(", "))
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "hosts" => {
            let hosts = corral.host_summary();
            if hosts.is_empty() {
                return Ok(format!("Corral runs only on {}.", corral.name));
            }
            Ok(std::iter::once(format!("{} (this machine)", corral.name))
                .chain(hosts.iter().map(|h| {
                    format!(
                        "{}{}",
                        h["name"].as_str().unwrap_or_default(),
                        if h["online"] == true {
                            String::new()
                        } else {
                            format!(
                                " · not reachable: {}",
                                h["error"].as_str().unwrap_or_default()
                            )
                        }
                    )
                }))
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "engines" => Ok(match text_arg(&body, "host") {
            h if h.is_empty() || h == corral.name => corral.engines().await,
            h => corral.host_engines(&h),
        }
        .iter()
        .map(|e| {
            let models: Vec<&str> = e["models"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|m| m["id"].as_str())
                .collect();
            let efforts: Vec<&str> = e["efforts"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            format!(
                "{} ({}): models {}; efforts {}",
                e["id"].as_str().unwrap_or_default(),
                e["label"].as_str().unwrap_or_default(),
                if models.is_empty() {
                    "its own default".into()
                } else {
                    models.join(", ")
                },
                efforts.join(", ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")),
        "create-agent" => {
            if corral.state.lock().unwrap().agents.len() >= MAX_AGENTS {
                return Err(bad(&format!(
                    "Corral holds {MAX_AGENTS} agents; ask the person to remove some"
                )));
            }
            let host = text_arg(&body, "host");
            let mut engine = text_arg(&body, "engine");
            if engine.is_empty() {
                let offered = if host.is_empty() || host == corral.name {
                    corral.engines().await
                } else {
                    corral.host_engines(&host)
                };
                engine = offered
                    .first()
                    .and_then(|e| e["id"].as_str())
                    .unwrap_or_default()
                    .to_owned();
            }
            let form = AgentForm {
                name: text_arg(&body, "name"),
                engine,
                model: text_arg(&body, "model"),
                effort: text_arg(&body, "effort"),
                home: text_arg(&body, "home"),
                instructions: text_arg(&body, "instructions"),
                host,
            };
            let (agent, engines) = if !form.host.is_empty() && form.host != corral.name {
                let agent = corral.create_remote(&form).await?;
                (agent, corral.host_engines(&form.host))
            } else {
                let (name, home) = corral.checked(&form, "").await?;
                let agent = Agent {
                    id: uuid::Uuid::new_v4().to_string(),
                    name,
                    engine: form.engine,
                    model: form.model,
                    effort: form.effort,
                    home,
                    instructions: form.instructions,
                    created: now(),
                    host: String::new(),
                };
                corral.save_agent(&agent).map_err(error)?;
                corral
                    .state
                    .lock()
                    .unwrap()
                    .agents
                    .insert(agent.id.clone(), agent.clone());
                corral.emit(json!({"type":"agents"}));
                (agent, corral.engines().await)
            };
            let line = engine_line(&agent, &engines) + &corral.on_machine(&agent);
            corral.note(
                &me,
                &format!(
                    "@{who} made @{} ({line}, in {})",
                    agent.name,
                    tilde(&agent.home)
                ),
            );
            Ok(format!(
                "Made @{} ({line}) in {}. Mention @{} in a channel to bring it in, or `corral invite`.",
                agent.name,
                tilde(&agent.home),
                agent.name
            ))
        }
        "channels" => {
            let state = corral.state.lock().unwrap();
            let mut channels: Vec<&Conversation> = state
                .conversations
                .values()
                .filter(|c| c.kind == "channel")
                .collect();
            channels.sort_by_key(|c| c.name.to_ascii_lowercase());
            Ok(channels
                .into_iter()
                .map(|c| {
                    let members: Vec<String> =
                        c.members.iter().map(|id| handle(&state, id)).collect();
                    format!(
                        "#{}{} · {}",
                        c.name,
                        if c.topic.is_empty() {
                            String::new()
                        } else {
                            format!(" · {}", c.topic)
                        },
                        if members.is_empty() {
                            "no agents".into()
                        } else {
                            members.join(", ")
                        }
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        "create-channel" => {
            let mut members = corral.agents_named(&names(&body, "members"))?;
            if !members.contains(&me.agent) {
                members.insert(0, me.agent.clone());
            }
            let form = ChannelForm {
                name: text_arg(&body, "name"),
                topic: text_arg(&body, "topic"),
                members,
            };
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
            corral
                .state
                .lock()
                .unwrap()
                .conversations
                .insert(conversation.id.clone(), conversation.clone());
            corral.emit(json!({"type":"conversation","conversation":conversation}));
            corral.note(&me, &format!("@{who} made #{}", conversation.name));
            Ok(format!("Made #{}.", conversation.name))
        }
        "invite" => {
            let channel = corral.channel_named(&text_arg(&body, "channel"))?;
            let handles = names(&body, "agents");
            if handles.is_empty() {
                return Err(bad("Name the agents with --agents a,b"));
            }
            let ids = corral.agents_named(&handles)?;
            let updated = {
                let mut state = corral.state.lock().unwrap();
                let c = state
                    .conversations
                    .get_mut(&channel.id)
                    .ok_or_else(not_found)?;
                for id in ids {
                    if !c.members.contains(&id) {
                        c.members.push(id);
                    }
                }
                c.clone()
            };
            corral.save_conversation(&updated).map_err(error)?;
            corral.emit(json!({"type":"conversation","conversation":updated}));
            let list = handles
                .iter()
                .map(|n| format!("@{n}"))
                .collect::<Vec<_>>()
                .join(", ");
            let _ = corral.post(&channel.id, CORRAL, &format!("@{who} added {list}"), 0, "");
            Ok(format!("Added {list} to #{}.", channel.name))
        }
        "post" => {
            let channel = corral.channel_named(&text_arg(&body, "channel"))?;
            let text = text_arg(&body, "text");
            if text.is_empty() || text.len() > 64 * 1024 {
                return Err(bad("Give the message as text after the arguments"));
            }
            let thread = text_arg(&body, "thread");
            if !thread.is_empty()
                && !corral
                    .state
                    .lock()
                    .unwrap()
                    .messages
                    .get(&channel.id)
                    .is_some_and(|m| m.iter().any(|m| m.id == thread && m.thread.is_empty()))
            {
                return Err(bad("No such message to reply to in that channel"));
            }
            let message = corral
                .post(&channel.id, &me.agent, &text, me.chain, &thread)
                .map_err(error)?;
            Ok(format!("Posted in #{} ({}).", channel.name, message.id))
        }
        "react" => {
            let emoji = text_arg(&body, "text");
            let given = text_arg(&body, "message");
            // By default, the latest message here that is not its own or Corral's.
            let to = {
                let state = corral.state.lock().unwrap();
                state
                    .messages
                    .get(&me.conversation)
                    .into_iter()
                    .flatten()
                    .rev()
                    .filter(|m| m.reacts.is_empty())
                    .find(|m| {
                        if !given.is_empty() {
                            return m.id == given;
                        }
                        let here = if me.thread.is_empty() {
                            m.thread.is_empty()
                        } else {
                            m.id == me.thread || m.thread == me.thread
                        };
                        here && m.author != me.agent && m.author != CORRAL
                    })
                    .map(|m| (m.id.clone(), handle(&state, &m.author)))
            };
            let Some((to, by)) = to else {
                return Err(bad(if given.is_empty() {
                    "There is no message here to react to"
                } else {
                    "No such message here; `corral read` gives ids"
                }));
            };
            let posted = react(&corral, &me.conversation, &to, &emoji, &me.agent)?;
            let text = posted["text"].as_str().unwrap_or_default();
            Ok(format!(
                "Reacted {} to {by}'s message.",
                text.split(" to ").next().unwrap_or_default()
            ))
        }
        "read" => {
            let channel = corral.channel_named(&text_arg(&body, "channel"))?;
            let thread = text_arg(&body, "thread");
            let limit: usize = text_arg(&body, "limit").parse().unwrap_or(30).clamp(1, 100);
            let state = corral.state.lock().unwrap();
            let shown: Vec<&Message> = state
                .messages
                .get(&channel.id)
                .into_iter()
                .flatten()
                .filter(|m| {
                    if thread.is_empty() {
                        m.thread.is_empty()
                    } else {
                        m.id == thread || m.thread == thread
                    }
                })
                .collect();
            Ok(shown
                .iter()
                .skip(shown.len().saturating_sub(limit))
                .map(|m| {
                    format!(
                        "[{}] {} {}: {}",
                        m.id,
                        m.ts.get(..16).unwrap_or(&m.ts).replace('T', " "),
                        handle(&state, &m.author),
                        m.text.trim()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"))
        }
        other => Err(bad(&format!(
            "There is no `corral {other}`; `corral help` lists the actions"
        ))),
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
            thread: String::new(),
            reacts: String::new(),
        }
    }
    fn reply(author: &str, text: &str, thread: &str) -> Message {
        Message {
            thread: thread.into(),
            ..message(author, text, 0)
        }
    }

    #[test]
    fn mentions_are_handles_not_emails_or_paths() {
        assert_eq!(
            mentions("@Alex can you ask @sam? cc @alex, mail me@example.com, see ./@scoped/pkg"),
            ["alex", "sam"]
        );
        assert!(valid_name("alex-2") && !valid_name("2alex") && !valid_name("here"));
        // Names keep their case; reserved words are reserved in any case; Corral is a fine name.
        assert!(valid_name("AsBuilt") && valid_name("corral") && !valid_name("Here"));
        assert!(
            valid_channel("infra_ops") && valid_channel("MovingRecords") && !valid_channel("-x")
        );
        assert_eq!(
            gemini_label("gemini-3.8-flash-high"),
            "Gemini 3.8 Flash High"
        );
        assert_eq!(now().len(), 24);
    }

    #[test]
    fn names_keep_their_case_and_mentions_ignore_it() {
        let (corral, root) = corral();
        let built = agent(&corral, "AsBuilt");
        let talk = channel(&corral, "films", vec![]);
        let mut state = corral.state.lock().unwrap();
        let (wake, _, _) =
            corral.targets(&mut state, &talk, &message(YOU, "@asbuilt where are we", 0));
        assert_eq!(wake, std::slice::from_ref(&built.id));
        assert_eq!(handle(&state, &built.id), "@AsBuilt");
        drop(state);
        fs::remove_dir_all(root).unwrap();
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
        let text = context(&state, &root, &alex, &infra, "", None);
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
        let brief = brief(&alex, "Justin", &root, "linuxbox", None);
        assert!(brief.starts_with("You are @alex, one of Justin's agents in Corral"));
        // It answers like a person in a chat, not with a report.
        assert!(brief.contains("one to three short sentences, under about 50 words"));
        assert!(brief.contains("No headings, bold labels, bullet points, or numbered lists."));
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_thread_starts_from_the_conversation_as_it_stood_at_its_message() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let infra = channel(&corral, "infra", vec![alex.id.clone()]);
        let messages = vec![
            message(YOU, "@alex check the certs", 0),
            message(&alex.id, "Certs are fine.", 1),
            message(YOU, "@alex and the backups?", 0),
            message(&alex.id, "Backups ran at 3am.", 1),
            message(YOU, "@alex what about disk space", 0),
            message(&alex.id, "Disk is 40% full.", 1),
        ];
        let (backups, later) = (messages[3].id.clone(), messages[4].id.clone());
        {
            let mut state = corral.state.lock().unwrap();
            let mut all = messages.clone();
            all.push(reply(YOU, "were they the full backups?", &backups));
            state.messages.insert(infra.id.clone(), all);
            let mark = |seen: usize, uuid: &str| Mark {
                seen,
                session: "s1".into(),
                uuid: uuid.into(),
                known: None,
            };
            state.seats.entry(infra.id.clone()).or_default().insert(
                alex.id.clone(),
                Seat {
                    session: "s1".into(),
                    engine: "claude".into(),
                    seen: 5,
                    marks: vec![mark(0, "u0"), mark(2, "u2"), mark(4, "u4")],
                    ..Seat::default()
                },
            );
        }
        let state = corral.state.lock().unwrap();
        let seat = &state.seats[&infra.id][&alex.id];
        // The fork is the latest point at or before the thread's message: after "Certs are
        // fine", before the backups question.
        let at = state.messages[&infra.id]
            .iter()
            .position(|m| m.id == backups)
            .unwrap();
        let fork = seat.marks.iter().rfind(|m| m.seen <= at).unwrap();
        assert_eq!(fork.uuid, "u2");
        let text = context(&state, &root, &alex, &infra, &backups, Some(fork));
        assert!(text.starts_with("<corral>\nYou are @alex in a thread in #infra"));
        assert!(text.contains("before the message this thread replies to:\n"));
        assert!(text.contains("@you: @alex and the backups?\n"));
        assert!(text.contains("The thread replies to this message:\n"));
        assert!(text.contains("@alex: Backups ran at 3am.\n"));
        assert!(text.contains("@you: were they the full backups?\n"));
        // Nothing said after the thread's message.
        assert!(!text.contains("disk space") && !text.contains("Disk is"));
        assert!(text.contains("Reply in the thread in #infra"));
        drop(state);
        // In the thread, a reply that mentions no one wakes the agent it hangs from.
        let mut state = corral.state.lock().unwrap();
        let talk = state.conversations[&infra.id].clone();
        let (wake, _, _) = corral.targets(
            &mut state,
            &talk,
            &reply(YOU, "and last night's?", &backups),
        );
        assert_eq!(wake, std::slice::from_ref(&alex.id));
        // In the conversation itself, the same words wake no one.
        let (wake, _, _) = corral.targets(&mut state, &talk, &message(YOU, "and last night's?", 0));
        assert!(wake.is_empty());
        // A thread on the person's own message wakes the agents it mentioned.
        let (wake, _, _) = corral.targets(&mut state, &talk, &reply(YOU, "hm", &later));
        assert_eq!(wake, std::slice::from_ref(&alex.id));
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_agents_corral_command_acts_for_it_while_its_turn_runs() {
        let (corral, root) = corral();
        let (maker, helper) = (agent(&corral, "maker"), agent(&corral, "helper"));
        let infra = channel(&corral, "infra", vec![maker.id.clone()]);
        let token = "t0k3n";
        corral.callers.lock().unwrap().insert(
            token.into(),
            Caller {
                agent: maker.id.clone(),
                conversation: infra.id.clone(),
                thread: String::new(),
                chain: 1,
            },
        );
        let headers = |t: &str| {
            let mut h = axum::http::HeaderMap::new();
            h.insert("x-corral-token", t.parse().unwrap());
            h
        };
        let run = |action: &str, body: Value| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(agent_action(
                    State(corral.clone()),
                    headers(token),
                    Path(action.into()),
                    Json(body),
                ))
        };
        // Only a turn's own token works.
        let refused = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(agent_help(State(corral.clone()), headers("nope")));
        assert_eq!(refused.unwrap_err().0, StatusCode::UNAUTHORIZED);
        let help = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(agent_help(State(corral.clone()), headers(token)))
            .unwrap();
        assert!(help.starts_with("corral: Corral from your shell, acting as @maker."));
        assert!(help.contains("corral create-agent --name NAME --home FOLDER [--engine ENGINE]"));
        // A channel it makes includes it, and the person hears about it where it is.
        assert_eq!(
            run("create-channel", json!({"name":"#docs","topic":"Writing"})).unwrap(),
            "Made #docs."
        );
        assert_eq!(
            run("invite", json!({"channel":"docs","agents":"@helper"})).unwrap(),
            "Added @helper to #docs."
        );
        let channels = run("channels", json!({})).unwrap();
        assert!(channels.contains("#docs · Writing · @maker, @helper"));
        // It posts as itself, and reads back with ids.
        assert!(
            run("post", json!({"channel":"docs","text":"hello docs"}))
                .unwrap()
                .starts_with("Posted in #docs")
        );
        // Channels are found whatever the case.
        let read = run("read", json!({"channel":"DOCS"})).unwrap();
        assert!(read.contains("@maker: hello docs"));
        // It reacts to the latest message to it where its turn is, not to Corral's notes.
        let asked = message(YOU, "can you look at the logs", 0);
        corral
            .state
            .lock()
            .unwrap()
            .messages
            .get_mut(&infra.id)
            .unwrap()
            .insert(0, asked.clone());
        assert_eq!(
            run("react", json!({"text":"👀"})).unwrap(),
            "Reacted 👀 (on it) to @you's message."
        );
        assert!(run("react", json!({"text":"on it"})).is_err());
        assert!(run("react", json!({"text":"🎉"})).is_err());
        let reacted = corral.state.lock().unwrap().messages[&infra.id]
            .iter()
            .find(|m| m.reacts == asked.id)
            .cloned()
            .unwrap();
        assert_eq!(
            reacted.text,
            "👀 (on it) to @you's message: \u{201c}can you look at the logs\u{201d}"
        );
        corral
            .state
            .lock()
            .unwrap()
            .messages
            .get_mut(&infra.id)
            .unwrap()
            .retain(|m| m.id != asked.id && m.reacts != asked.id);
        let state = corral.state.lock().unwrap();
        let notes: Vec<&str> = state.messages[&infra.id]
            .iter()
            .map(|m| m.text.as_str())
            .collect();
        assert_eq!(notes, ["@maker made #docs"]);
        drop(state);
        // Mistakes say what to do.
        let unknown = run("invite", json!({"channel":"docs","agents":"ghost"})).unwrap_err();
        assert!(
            unknown.1["error"]
                .as_str()
                .unwrap()
                .contains("`corral agents`")
        );
        assert!(
            run("dance", json!({})).unwrap_err().1["error"]
                .as_str()
                .unwrap()
                .contains("corral help")
        );
        let _ = helper;
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_prompt_file_changes_what_agents_are_told_from_the_next_turn() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        // Each start shows the built-in prompt beside where an edited one goes.
        assert_eq!(
            fs::read_to_string(root.join("prompt.default.md")).unwrap(),
            PROMPT
        );
        assert!(
            brief(&alex, "Justin", &root, "linuxbox", None)
                .starts_with("You are @alex, one of Justin's")
        );
        fs::write(
            root.join("prompt.md"),
            "You are @{name} on {machine}; ask {person}. Keep {braces} and {",
        )
        .unwrap();
        assert_eq!(
            brief(&alex, "Justin", &root, "linuxbox", None),
            "You are @alex on linuxbox; ask Justin. Keep {braces} and {"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_agent_sets_its_picture_with_an_avatar_file() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let folder = root.join("agents").join(&alex.id);
        assert!(avatar(&folder).is_none());
        fs::write(folder.join("avatar.png"), b"png").unwrap();
        let (path, kind, first) = avatar(&folder).unwrap();
        assert_eq!(
            (path.file_name().unwrap().to_str().unwrap(), kind),
            ("avatar.png", "image/png")
        );
        // A newer picture of another type replaces it.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(folder.join("avatar.svg"), b"<svg/>").unwrap();
        let (_, kind, changed) = avatar(&folder).unwrap();
        assert_eq!(kind, "image/svg+xml");
        assert!(changed > first);
        // The agent is told where it goes.
        assert!(
            brief(&alex, "Justin", &root, "linuxbox", None)
                .contains(&format!("{}/avatar.png", folder.display()))
        );
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
            read_claude(&json!({"type":"assistant","uuid":"u9","parent_tool_use_id":null,"message":{"content":[]}})).uuid,
            Some("u9".into())
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
    #[test]
    fn voice_reads_the_agents_replies_in_the_open_view() {
        let (corral, root) = corral();
        let walt = agent(&corral, "WhatWaltBuilt");
        let talk = channel(&corral, "MovingRecords", vec![walt.id.clone()]);
        let asked = message(YOU, "@WhatWaltBuilt status?", 0);
        let answered = message(&walt.id, "All green.", 0);
        let threaded = reply(&walt.id, "Details here.", &asked.id);
        corral.state.lock().unwrap().messages.insert(
            talk.id.clone(),
            vec![
                asked.clone(),
                message(CORRAL, "WhatWaltBuilt joined", 0),
                answered.clone(),
                threaded.clone(),
            ],
        );
        let state = corral.state.lock().unwrap();
        // The conversation: replies outside threads, each with who said it.
        let main = voice_state(&state, &talk.id, "").unwrap();
        assert_eq!(main["paragraphs"].as_array().unwrap().len(), 1);
        assert_eq!(main["answer"]["id"], json!(answered.id));
        assert_eq!(main["answer"]["text"], "What Walt Built says: All green.");
        assert_eq!(main["working"], false);
        // A thread: its replies, and a session of its own.
        let thread = voice_state(&state, &talk.id, &asked.id).unwrap();
        assert_eq!(thread["answer"]["id"], json!(threaded.id));
        assert_ne!(thread["session"], main["session"]);
        assert!(voice_state(&state, "missing", "").is_none());
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn another_hosts_agents_join_under_ids_of_their_own() {
        let (corral, root) = corral();
        agent(&corral, "Fixer");
        let seen = json!({"agents": [
            {"id": "g1", "name": "Winny", "engine": "claude", "home": "C:\\Users\\Justin", "created": "", "avatar": 7},
            {"id": "g2", "name": "fixer", "engine": "claude", "home": "C:\\", "created": ""},
            {"id": "g3", "name": "here", "engine": "claude", "home": "C:\\", "created": ""},
        ]});
        assert!(corral.merge("winbox", &seen));
        assert!(!corral.merge("winbox", &seen));
        let state = corral.state.lock().unwrap();
        let winny = &state.agents["g1@winbox"];
        assert_eq!(
            (winny.name.as_str(), winny.host.as_str()),
            ("Winny", "winbox")
        );
        assert_eq!(state.pictures["g1@winbox"], 7);
        // A name this host has is told apart by its host; a reserved one is left out.
        assert_eq!(state.agents["g2@winbox"].name, "fixer-winbox");
        assert!(!state.agents.contains_key("g3@winbox"));
        drop(state);
        // A name like this host's own is found by mentions, as any other.
        assert!(mentions("ask @fixer-winbox").contains(&"fixer-winbox".to_owned()));
        assert!(corral.merge("winbox", &json!({"agents": []})));
        assert!(
            corral
                .state
                .lock()
                .unwrap()
                .agents
                .values()
                .all(|a| a.host.is_empty())
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn activity_lists_each_place_by_its_latest_message() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let talk = channel(&corral, "infra", vec![alex.id.clone()]);
        let mut asked = message(YOU, "@alex certs?", 0);
        asked.ts = "2026-10-29T10:00:00.000Z".into();
        let mut answered = message(&alex.id, "Renewed.", 1);
        answered.ts = "2026-10-29T10:01:00.000Z".into();
        let mut threaded = reply(&alex.id, "Details: all three.", &asked.id);
        threaded.ts = "2026-10-29T10:05:00.000Z".into();
        let mut note = message(CORRAL, "@alex joined", 0);
        note.ts = "2026-10-29T10:09:00.000Z".into();
        corral.state.lock().unwrap().messages.insert(
            talk.id.clone(),
            vec![asked.clone(), answered.clone(), threaded.clone(), note],
        );
        let items = activity_of(&corral.state.lock().unwrap());
        // The thread's reply is newest; Corral's note does not count.
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["thread"], json!(asked.id));
        assert_eq!(items[0]["message"]["text"], "Details: all three.");
        assert_eq!(items[0]["root"]["text"], "@alex certs?");
        assert_eq!(items[0]["replies"], 1);
        assert_eq!(items[0]["agents"], json!([alex.id]));
        assert_eq!(items[1]["thread"], "");
        assert_eq!(items[1]["message"]["id"], json!(answered.id));
        assert!(items[1]["root"].is_null());
        // A closed row stays gone until a newer message comes there, and for good.
        let close = |thread: &str| {
            tokio::runtime::Runtime::new()
                .unwrap()
                .block_on(close_activity(
                    State(corral.clone()),
                    Json(Place {
                        conversation: talk.id.clone(),
                        thread: thread.into(),
                    }),
                ))
                .unwrap()
        };
        let _ = close(&asked.id);
        let items = activity_of(&corral.state.lock().unwrap());
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["thread"], "");
        assert_eq!(
            Corral::load(root.clone())
                .state
                .lock()
                .unwrap()
                .closed
                .len(),
            1
        );
        let mut again = reply(YOU, "and the fourth?", &asked.id);
        again.ts = "2026-10-29T11:00:00.000Z".into();
        corral
            .state
            .lock()
            .unwrap()
            .messages
            .get_mut(&talk.id)
            .unwrap()
            .push(again);
        let items = activity_of(&corral.state.lock().unwrap());
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["message"]["text"], "and the fourth?");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn an_agents_recent_work_is_its_latest_message_in_each_place() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let sam = agent(&corral, "sam");
        let talk = channel(&corral, "infra", vec![alex.id.clone(), sam.id.clone()]);
        let mut asked = message(YOU, "@alex certs?", 0);
        asked.ts = "2026-10-29T10:00:00.000Z".into();
        let mut first = message(&alex.id, "Looking.", 1);
        first.ts = "2026-10-29T10:01:00.000Z".into();
        let mut answered = message(&alex.id, "Renewed.", 1);
        answered.ts = "2026-10-29T10:02:00.000Z".into();
        let mut threaded = reply(&alex.id, "Details: all three.", &asked.id);
        threaded.ts = "2026-10-29T10:05:00.000Z".into();
        let mut later = reply(&sam.id, "Thanks.", &asked.id);
        later.ts = "2026-10-29T10:06:00.000Z".into();
        let mut eyes = message(&alex.id, "👀 (on it)", 0);
        eyes.reacts = asked.id.clone();
        eyes.ts = "2026-10-29T10:07:00.000Z".into();
        corral.state.lock().unwrap().messages.insert(
            talk.id.clone(),
            vec![
                asked.clone(),
                first,
                answered.clone(),
                threaded,
                later,
                eyes,
            ],
        );
        let items = recent_of(&corral.state.lock().unwrap(), &alex.id);
        // Its own latest in each place, not others' after it, and not its reactions.
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["thread"], json!(asked.id));
        assert_eq!(items[0]["message"]["text"], "Details: all three.");
        assert_eq!(items[0]["root"]["text"], "@alex certs?");
        assert_eq!(items[1]["message"]["id"], json!(answered.id));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_turns_edits_name_the_files_it_changed() {
        let edit = json!({"type":"assistant","parent_tool_use_id":null,"uuid":"u1","message":{"content":[
            {"type":"tool_use","name":"Edit","input":{"file_path":"/w/tools/edit.py"}},
        ]}});
        let read = read_claude(&edit);
        assert_eq!(read.files, ["/w/tools/edit.py"]);
        assert_eq!(read.status.as_deref(), Some("Edit · /w/tools/edit.py"));
        let looked = json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[
            {"type":"tool_use","name":"Read","input":{"file_path":"/w/README.md"}},
        ]}});
        assert!(read_claude(&looked).files.is_empty());
        let codex = json!({"type":"item.completed","item":{"type":"file_change","changes":[
            {"path":"/w/a.rs","kind":"update"},{"path":"/w/b.rs","kind":"add"},
        ]}});
        assert_eq!(read_codex(&codex).files, ["/w/a.rs", "/w/b.rs"]);
    }
    #[test]
    fn a_message_for_an_agent_at_work_waits_for_its_next_turn() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let talk = channel(&corral, "infra", vec![alex.id.clone()]);
        let key = (talk.id.clone(), alex.id.clone(), String::new());
        corral
            .state
            .lock()
            .unwrap()
            .turns
            .insert(key.clone(), Turn::default());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let later = runtime.block_on(async {
            let later = corral
                .post(&talk.id, YOU, "@alex and the web certs?", 0, "")
                .unwrap();
            corral
                .post(&talk.id, YOU, "no mention, so nothing waits", 0, "")
                .unwrap();
            later
        });
        let state = corral.state.lock().unwrap();
        assert_eq!(state.turns[&key].again, Some(1));
        assert_eq!(
            queued(&state),
            vec![json!({"conversation": talk.id, "message": later.id, "agents": [alex.id]})]
        );
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn deleting_a_message_rewinds_the_agents_that_knew_it() {
        let (corral, root) = corral();
        let alex = agent(&corral, "alex");
        let codex = agent(&corral, "cody");
        let talk = channel(&corral, "infra", vec![alex.id.clone(), codex.id.clone()]);
        let asked = message(YOU, "@alex certs?", 0);
        let answered = message(&alex.id, "Renewed.", 1);
        let again = message(YOU, "@alex and web?", 0);
        let wrong = message(&alex.id, "Web is down.", 1);
        let threaded = reply(YOU, "in a thread", &asked.id);
        let mark = |seen, known, uuid: &str| Mark {
            seen,
            session: "s1".into(),
            uuid: uuid.into(),
            known: Some(known),
        };
        {
            let mut state = corral.state.lock().unwrap();
            state.messages.insert(
                talk.id.clone(),
                vec![asked.clone(), answered, again, wrong.clone(), threaded],
            );
            let seats = state.seats.entry(talk.id.clone()).or_default();
            seats.insert(
                alex.id.clone(),
                Seat {
                    session: "s1".into(),
                    engine: "claude".into(),
                    seen: 3,
                    marks: vec![mark(1, 1, "u1"), mark(3, 3, "u2")],
                    ..Seat::default()
                },
            );
            seats.insert(
                codex.id.clone(),
                Seat {
                    session: "c1".into(),
                    engine: "codex".into(),
                    seen: 5,
                    ..Seat::default()
                },
            );
            seats.insert(seat_key(&alex.id, &asked.id), Seat::default());
        }
        // alex's wrong reply: its session forks from before it, so the question is asked again.
        assert_eq!(
            corral.delete_messages(&talk.id, &wrong.id).unwrap(),
            std::slice::from_ref(&wrong.id)
        );
        let state = corral.state.lock().unwrap();
        let seat = &state.seats[&talk.id][&alex.id];
        assert_eq!(seat.rewind.as_ref().map(|m| m.uuid.as_str()), Some("u1"));
        assert_eq!((seat.seen, seat.marks.len()), (1, 1));
        // Codex cannot be rewound, so it is told; it had been given everything.
        assert_eq!(
            state.seats[&talk.id][&codex.id].forget,
            ["@alex: Web is down."]
        );
        assert_eq!(state.seats[&talk.id][&codex.id].seen, 4);
        assert_eq!(state.messages[&talk.id].len(), 4);
        drop(state);
        // A message a thread hangs from goes with its replies and the thread's seats.
        assert_eq!(
            corral.delete_messages(&talk.id, &asked.id).unwrap().len(),
            2
        );
        let state = corral.state.lock().unwrap();
        assert_eq!(state.messages[&talk.id].len(), 2);
        assert!(!state.seats[&talk.id].contains_key(&seat_key(&alex.id, &asked.id)));
        let saved = fs::read_to_string(
            root.join("conversations")
                .join(&talk.id)
                .join("messages.jsonl"),
        )
        .unwrap();
        assert_eq!(saved.lines().count(), 2);
        drop(state);
        // Not while an agent works there.
        corral.state.lock().unwrap().turns.insert(
            (talk.id.clone(), alex.id.clone(), String::new()),
            Turn::default(),
        );
        let first = corral.state.lock().unwrap().messages[&talk.id][0]
            .id
            .clone();
        assert_eq!(
            corral.delete_messages(&talk.id, &first).unwrap_err().0,
            StatusCode::CONFLICT
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_thread_wakes_only_whoever_it_is_with() {
        let (corral, root) = corral();
        let trail = agent(&corral, "PaperTrail");
        let (asbuilt, walt) = (agent(&corral, "AsBuilt"), agent(&corral, "Walt"));
        let talk = channel(&corral, "PlainSight", vec![trail.id.clone()]);
        let started = message(&trail.id, "Draft is up.", 1);
        let told = reply(
            &trail.id,
            "@AsBuilt @Walt heads up on the house rules.",
            &started.id,
        );
        let asked = message(YOU, "no mention here", 0);
        corral.state.lock().unwrap().messages.insert(
            talk.id.clone(),
            vec![
                started.clone(),
                told,
                reply(&asbuilt.id, "Thanks.", &started.id),
                reply(&walt.id, "Got it.", &started.id),
                asked.clone(),
                reply(YOU, "nobody", &asked.id),
            ],
        );
        let mut state = corral.state.lock().unwrap();
        // Agents mentioned in the thread, who replied there, are not woken by the person's reply.
        let (wake, _, _) = corral.targets(
            &mut state,
            &talk,
            &reply(YOU, "and the intro?", &started.id),
        );
        assert_eq!(wake, std::slice::from_ref(&trail.id));
        // A mention still brings one in.
        let (wake, _, _) =
            corral.targets(&mut state, &talk, &reply(YOU, "@Walt you too", &started.id));
        assert_eq!(wake, std::slice::from_ref(&walt.id));
        // A thread on the person's message that mentioned no one wakes no one.
        let (wake, _, _) = corral.targets(&mut state, &talk, &reply(YOU, "hm", &asked.id));
        assert!(wake.is_empty());
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn a_reaction_wakes_only_whoever_wrote_the_message_and_says_what_it_is_to() {
        let (corral, root) = corral();
        let trail = agent(&corral, "PaperTrail");
        let walt = agent(&corral, "Walt");
        let talk = channel(
            &corral,
            "PlainSight",
            vec![trail.id.clone(), walt.id.clone()],
        );
        let started = message(&trail.id, "Draft is up.", 1);
        let answered = reply(&walt.id, "Rendered the intro.", &started.id);
        let mine = message(YOU, "Ship it on Friday.", 0);
        corral.state.lock().unwrap().messages.insert(
            talk.id.clone(),
            vec![started.clone(), answered.clone(), mine.clone()],
        );
        let reaction = |to: &Message| Message {
            reacts: to.id.clone(),
            thread: to.thread.clone(),
            ..message(YOU, "👍 (thumbs up)", 0)
        };
        {
            let mut state = corral.state.lock().unwrap();
            // In the channel, with no mention, it still wakes the message's author.
            let (wake, _, _) = corral.targets(&mut state, &talk, &reaction(&started));
            assert_eq!(wake, std::slice::from_ref(&trail.id));
            // In a thread, the reply's author, not whoever the thread is with.
            let (wake, _, _) = corral.targets(&mut state, &talk, &reaction(&answered));
            assert_eq!(wake, std::slice::from_ref(&walt.id));
            // On the person's own message, no one.
            let (wake, _, _) = corral.targets(&mut state, &talk, &reaction(&mine));
            assert!(wake.is_empty());
            // An agent's reaction, even to another agent's message, wakes no one.
            let (wake, _, _) = corral.targets(
                &mut state,
                &talk,
                &Message {
                    author: walt.id.clone(),
                    ..reaction(&started)
                },
            );
            assert!(wake.is_empty());
        }
        // It is told in words, where the message is.
        let posted = react(&corral, &talk.id, &mine.id, "🚀", YOU).unwrap();
        assert_eq!(posted["reacts"], mine.id.as_str());
        assert_eq!(
            posted["text"],
            "🚀 (do it) to your own message: \u{201c}Ship it on Friday.\u{201d}"
        );
        assert!(react(&corral, &talk.id, &mine.id, "🎉", YOU).is_err());
        assert!(react(&corral, &talk.id, "nope", "👍", YOU).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn search_finds_every_word_in_any_order_newest_first() {
        let (corral, root) = corral();
        let built = agent(&corral, "AsBuilt");
        let talk = channel(&corral, "MovingRecords", vec![built.id.clone()]);
        let mut older = message(
            &built.id,
            "The 4K render of the Epcot cut is on Jellyfin.",
            1,
        );
        older.ts = "2026-10-29T10:00:00.000Z".into();
        let mut newer = reply(YOU, "Can you RENDER it in 4k again?", &older.id);
        newer.ts = "2026-10-29T11:00:00.000Z".into();
        let other = message(YOU, "lunch?", 0);
        corral
            .state
            .lock()
            .unwrap()
            .messages
            .insert(talk.id.clone(), vec![older.clone(), newer.clone(), other]);
        let state = corral.state.lock().unwrap();
        let found = search_of(&state, "4k Render");
        assert_eq!(found.len(), 2);
        assert_eq!(found[0]["message"]["id"], json!(newer.id));
        assert_eq!(found[0]["thread"], json!(older.id));
        // An agent's name counts, and the message's own text is shown around the match.
        let found = search_of(&state, "@asbuilt jellyfin");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["agents"], json!([built.id]));
        assert!(search_of(&state, "  ").is_empty());
        assert_eq!(
            excerpt(&format!("{} needle here", "word ".repeat(40)), "needle"),
            format!("…{}needle here", &"word ".repeat(40)[200 - 80..])
        );
        drop(state);
        fs::remove_dir_all(root).unwrap();
    }
}
