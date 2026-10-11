//! Read assistant progress and completed answers and synthesize them on the host. No terminal scraping.
use crate::{ApiError, App, apps, dictation, error};
use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{LazyLock, Mutex},
    time::SystemTime,
};
use tokio::{io::AsyncReadExt, process::Command, sync::Semaphore};

const MAX_TEXT: usize = 64 * 1024;
const MAX_AUDIO: u64 = 32 * 1024 * 1024;
static JOBS: Semaphore = Semaphore::const_new(1);
static READS: LazyLock<Mutex<HashMap<PathBuf, Tail>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
// Bounded, process-local audio cache: no permanent copies of conversations on disk.
static AUDIO: LazyLock<Mutex<HashMap<String, Vec<u8>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}
fn root(agent: &str) -> PathBuf {
    if agent == "codex" {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".codex"))
            .join("sessions")
    } else {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".claude"))
            .join("projects")
    }
}
fn contained(path: &FsPath, root: &FsPath) -> bool {
    path.canonicalize()
        .ok()
        .zip(root.canonicalize().ok())
        .is_some_and(|(p, r)| p.starts_with(r) && p.is_file())
}
fn find_session(root: &FsPath, id: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "Invalid conversation identity"
    );
    let suffix = format!("{id}.jsonl");
    let paths: Vec<_> = walkdir::WalkDir::new(root)
        .max_depth(5)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file() && e.file_name().to_string_lossy().ends_with(&suffix))
        .map(|e| e.into_path())
        .filter(|p| contained(p, root))
        .collect();
    anyhow::ensure!(
        paths.len() == 1,
        "No unique conversation log for this agent"
    );
    Ok(paths[0].clone())
}
// Daemon-backed Codex TUIs no longer own rollout file descriptors. The title is
// supplied by that TUI; match its exact saved name and process cwd, never recency.
/// Whether a Codex conversation is one a person drives: started by the terminal UI (`cli`) or
/// through the Codex daemon, as `codex resume` does (`vscode`, which the daemon records for its
/// clients). Non-interactive `exec` runs and sub-agents are never a pane's conversation.
fn interactive(source: &Value) -> bool {
    source == "cli" || source == "vscode"
}
fn codex_named_session(base: &FsPath, cwd: &FsPath, title: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(
        !title.trim().is_empty(),
        "Codex has not reported a conversation name"
    );
    let home = base
        .parent()
        .ok_or_else(|| anyhow::anyhow!("No Codex home"))?;
    let database = fs::read_dir(home)?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_str()?;
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path)
        .ok_or_else(|| anyhow::anyhow!("No Codex session database"))?;
    anyhow::ensure!(
        contained(&database, home),
        "Codex session database is outside its home"
    );
    let connection = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    connection.busy_timeout(std::time::Duration::from_millis(250))?;
    let folder = cwd.file_name().unwrap_or_default().to_string_lossy();
    let suffix = format!(" | {folder}");
    let name = title.strip_suffix(&suffix).unwrap_or(title);
    // Codex titles a conversation that has no name yet with just its folder; then the folder's
    // only unnamed conversation is the one, and two or more are refused rather than guessed.
    let unnamed = name == folder;
    let mut statement = connection.prepare(
        "SELECT id, rollout_path FROM threads WHERE source IN ('cli', 'vscode') AND archived = 0 AND cwd = ?1
         AND COALESCE(NULLIF(name, ''), title) IN (?2, ?3) LIMIT 2",
    )?;
    let (title, name) = if unnamed { ("", "") } else { (title, name) };
    let matches = statement
        .query_map(
            rusqlite::params![cwd.to_string_lossy(), title, name],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    PathBuf::from(row.get::<_, String>(1)?),
                ))
            },
        )?
        .collect::<Result<Vec<_>, _>>()?;
    anyhow::ensure!(
        matches.len() == 1,
        "No unique named Codex conversation in this pane's directory"
    );
    let (id, path) = &matches[0];
    uuid::Uuid::parse_str(id)?;
    anyhow::ensure!(
        contained(path, base),
        "Conversation log is outside the Codex sessions directory"
    );
    use std::io::BufRead;
    let mut head = String::new();
    std::io::BufReader::new(fs::File::open(path)?.take(65536)).read_line(&mut head)?;
    let meta: Value = serde_json::from_str(&head)?;
    anyhow::ensure!(
        meta["type"] == "session_meta"
            && interactive(&meta["payload"]["source"])
            && meta["payload"]["id"] == *id,
        "Codex conversation metadata does not match its session record"
    );
    Ok(path.clone())
}
fn resolve(agent: &str, info: &Value, reported: &Value) -> anyhow::Result<PathBuf> {
    let base = root(agent);
    if let Some(id) = reported["agent_session"]["value"].as_str() {
        return find_session(&base, id);
    }
    let processes = info["foreground_processes"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("No agent process"))?;
    let mut paths = Vec::new();
    let mut codex_directories = Vec::new();
    for process in processes {
        if !process["name"].as_str().unwrap_or_default().contains(agent) {
            continue;
        }
        let Some(pid) = process["pid"].as_u64() else {
            continue;
        };
        if agent == "claude" {
            let record = base
                .parent()
                .unwrap()
                .join("sessions")
                .join(format!("{pid}.json"));
            if let Ok(bytes) = fs::read(record) {
                let value: Value = serde_json::from_slice(&bytes)?;
                // Check the process start time to reject a stale PID record after PID reuse.
                let stat = fs::read_to_string(format!("/proc/{pid}/stat"))?;
                let start = stat
                    .rsplit_once(") ")
                    .and_then(|(_, s)| s.split_whitespace().nth(19));
                if value["procStart"].as_str() != start {
                    continue;
                }
                if let Some(id) = value["sessionId"].as_str() {
                    paths.push(find_session(&base, id)?);
                }
            }
        } else {
            if let Ok(cwd) = fs::read_link(format!("/proc/{pid}/cwd")) {
                codex_directories.push(cwd);
            }
            for fd in fs::read_dir(format!("/proc/{pid}/fd"))?.flatten() {
                let Ok(path) = fs::read_link(fd.path()) else {
                    continue;
                };
                if path.extension().is_none_or(|x| x != "jsonl") || !contained(&path, &base) {
                    continue;
                }
                // Worker rollouts share the process; only the interactive CLI session belongs to this pane.
                let file = fs::File::open(&path)?;
                let mut head = String::new();
                use std::io::BufRead;
                std::io::BufReader::new(file.take(65536)).read_line(&mut head)?;
                if let Ok(meta) = serde_json::from_str::<Value>(&head)
                    && meta["type"] == "session_meta"
                    && interactive(&meta["payload"]["source"])
                {
                    paths.push(path);
                }
            }
        }
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty()
        && agent == "codex"
        && let Some(title) = reported["terminal_title_stripped"].as_str()
    {
        for cwd in codex_directories {
            if let Ok(path) = codex_named_session(&base, &cwd, title) {
                paths.push(path);
            }
        }
        paths.sort();
        paths.dedup();
    }
    anyhow::ensure!(
        paths.len() == 1,
        "Cannot identify this pane's conversation. Voice supports local Codex and Claude sessions with a unique session identity."
    );
    Ok(paths.remove(0))
}
fn blocks(value: &Value) -> String {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .filter(|v| v["type"] == "text" || v["type"] == "output_text")
                .filter_map(|v| v["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n\n")
        })
        .unwrap_or_default()
}

// Stable paragraph identities survive a growing message and its final record.
// Only persisted assistant prose is eligible; an incomplete trailing paragraph waits.
#[derive(Default)]
struct Paragraphs(Vec<(String, String, bool)>);
impl Paragraphs {
    fn put(&mut self, key: String, text: String, complete: bool) {
        if text.trim().is_empty() {
            return;
        }
        if let Some((_, previous, finished)) = self.0.iter_mut().find(|(k, _, _)| *k == key) {
            let same_prefix = !*finished
                && previous
                    .rsplit_once("\n\n")
                    .is_some_and(|(prefix, _)| text.starts_with(prefix));
            if text.starts_with(previous.as_str()) || same_prefix {
                *previous = text;
            } else if !previous.ends_with(&text) {
                previous.push_str("\n\n");
                previous.push_str(&text);
            }
            *finished |= complete;
        } else {
            self.0.push((key, text, complete));
        }
    }
    /// The turn's prose as written, with its Markdown and code, for showing rather than speaking.
    fn text(&self) -> String {
        self.0
            .iter()
            .map(|(_, text, _)| text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
    fn values(&self) -> Vec<Value> {
        let mut values = Vec::new();
        for (key, text, complete) in &self.0 {
            // Sanitize the entire message before splitting so fenced code cannot
            // turn into speech when it contains blank lines.
            let text = spoken(text);
            let mut parts: Vec<_> = text.split("\n\n").collect();
            if !complete {
                parts.pop();
            }
            for (index, part) in parts.into_iter().enumerate() {
                if !part.trim().is_empty() {
                    values
                        .push(json!({"key":format!("paragraph:{key}:{index}"),"text":part.trim()}));
                }
            }
        }
        values
    }
}
/// Assistant prose of a transcript, fed one line at a time so polling reads only what was appended.
#[derive(Default)]
struct Transcript {
    answer: Value,
    updates: Vec<Value>,
    turn: Value,
    active: bool,
    candidate: String,
    candidate_id: String,
    paragraphs: Paragraphs,
    line: usize,
    /// Background commands and agents not yet finished, as `{id, description, started}`.
    background: Vec<Value>,
    /// What each background tool call is for, until its result names the task.
    launches: HashMap<String, String>,
    /// The person's latest message, the session's title (Claude's own, or a Codex goal), and
    /// when the log last recorded anything.
    prompt: String,
    title: String,
    updated: Value,
    /// How many messages the person has sent, counting `prompt`.
    prompts: usize,
    /// Whether `answer` replies to `prompt`, rather than to a message before it.
    answered: bool,
    /// The current turn as a person follows it: each piece of the agent's text, with a summary
    /// of the work between pieces in place of the tool calls and their output.
    parts: Vec<Value>,
    work: Work,
    /// Why the latest turn failed, such as a usage limit, as `{message, kind}`; null otherwise.
    failure: Value,
}
/// The readable part of an agent's error message. Codex sometimes passes the API's JSON error
/// through as its message.
fn failure_message(message: &str) -> String {
    serde_json::from_str::<Value>(message)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or(v["message"].as_str())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| message.trim().to_owned())
}
/// The work since the agent last wrote: when it began, and the tool calls, changed files and
/// thinking since.
#[derive(Default)]
struct Work {
    since: Option<String>,
    tools: u32,
    files: Vec<String>,
    thought: bool,
}
impl Work {
    fn json(&self, until: Option<&str>) -> Value {
        let seconds = self
            .since
            .as_deref()
            .and_then(epoch)
            .zip(until.and_then(epoch))
            .map(|(from, to)| (to - from).max(0.0).round());
        json!({"seconds":seconds,"tools":self.tools,"files":self.files.len(),"thought":self.thought})
    }
}
/// Files a tool call edits: Claude's edit tools name one; a Codex patch names each it touches.
fn edited_files(name: &str, input: &Value) -> Vec<String> {
    if ["Edit", "Write", "MultiEdit", "NotebookEdit"].contains(&name) {
        return ["file_path", "notebook_path"]
            .iter()
            .find_map(|key| input[*key].as_str())
            .map(|path| vec![path.to_owned()])
            .unwrap_or_default();
    }
    let patch = input
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| input.to_string());
    let files = regex::Regex::new(r#"\*\*\* (?:Add|Update|Delete) File: ([^\n\\"]+)"#).unwrap();
    files
        .captures_iter(&patch)
        .map(|c| c[1].trim().to_owned())
        .collect()
}
/// Tags agents wrap around text they add to the person's side of a conversation, such as a
/// background task's notification or a reminder.
const INJECTED: [&str; 16] = [
    "task-notification",
    "system-reminder",
    "local-command-caveat",
    "local-command-stdout",
    "local-command-stderr",
    "command-name",
    "command-message",
    "command-args",
    "environment_context",
    "codex_internal_context",
    "image",
    "user_instructions",
    "user-prompt-submit-hook",
    "bash-input",
    "bash-stdout",
    "bash-stderr",
];
fn injected(text: &str) -> bool {
    text.trim_start()
        .strip_prefix('<')
        .map(|rest| rest.trim_start_matches('/'))
        .and_then(|rest| rest.split(['>', ' ', '\n']).next())
        .is_some_and(|tag| INJECTED.contains(&tag))
}
/// What a person typed: plain text, or the text blocks of a message. Text the agent adds, such as
/// `<system-reminder>` or `<environment_context>`, is skipped; pasted text keeps its words without
/// the `<pasted_content>` wrapper.
fn typed(content: &Value) -> Option<String> {
    let text = match content.as_str() {
        Some(text) => text.to_owned(),
        None => content
            .as_array()?
            .iter()
            .filter(|b| b["type"] == "text" || b["type"] == "input_text")
            .filter_map(|b| b["text"].as_str())
            .filter(|t| !injected(t))
            .collect::<Vec<_>>()
            .join("\n\n"),
    };
    if injected(&text) || text.trim_start().starts_with("[Request interrupted") {
        return None;
    }
    let pasted = regex::Regex::new(r"</?pasted_content[^>]*>").unwrap();
    let text = pasted.replace_all(&text, "");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}
impl Transcript {
    /// A new turn, starting at `at`, the time of the person's message.
    fn start_parts(&mut self, at: &Value) {
        self.parts.clear();
        self.work = Work {
            since: at.as_str().map(str::to_owned),
            ..Work::default()
        };
    }
    fn tool(&mut self, name: &str, input: &Value) {
        self.work.tools += 1;
        for file in edited_files(name, input) {
            if !self.work.files.contains(&file) {
                self.work.files.push(file);
            }
        }
    }
    /// The agent wrote `text` as part of message `id` at `at`. Work since its last text that
    /// used tools, thought, or took ten seconds or more is noted before it.
    fn text(&mut self, id: &str, text: &str, at: &Value) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let work = self.work.json(at.as_str());
        let long = work["seconds"].as_f64().is_some_and(|s| s >= 10.0);
        if self.work.tools > 0 || self.work.thought || long {
            self.parts.push(json!({"work": work}));
        }
        match self.parts.last_mut() {
            Some(last) if last["id"] == id && last["text"].is_string() => {
                let joined = format!("{}\n\n{text}", last["text"].as_str().unwrap_or_default());
                last["text"] = json!(joined);
            }
            _ => self.parts.push(json!({"id": id, "text": text})),
        }
        self.work = Work {
            since: at.as_str().map(str::to_owned).or(self.work.since.take()),
            ..Work::default()
        };
    }
    /// The turn's parts, ending with the work in progress while the agent works.
    fn turn_parts(&self) -> Value {
        let mut parts = self.parts.clone();
        if self.active && (self.work.since.is_some() || self.work.tools > 0) {
            let mut work = self.work.json(None);
            work["since"] = json!(self.work.since);
            work["ongoing"] = json!(true);
            parts.push(json!({ "work": work }));
        }
        json!(parts)
    }
    fn feed(&mut self, agent: &str, line: &str) {
        self.line += 1;
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if v["timestamp"].is_string() {
            self.updated = v["timestamp"].clone();
        }
        if agent == "codex" {
            let p = &v["payload"];
            if v["type"] == "response_item" {
                match p["type"].as_str().unwrap_or_default() {
                    "message" if p["role"] == "assistant" => {
                        let id = p["id"]
                            .as_str()
                            .map_or_else(|| self.line.to_string(), str::to_owned);
                        self.text(&id, &blocks(&p["content"]), &v["timestamp"]);
                    }
                    "function_call" | "custom_tool_call" | "local_shell_call" => {
                        let input = p
                            .get("input")
                            .or(p.get("arguments"))
                            .cloned()
                            .unwrap_or_default();
                        self.tool(p["name"].as_str().unwrap_or_default(), &input);
                    }
                    "reasoning" => self.work.thought = true,
                    _ => {}
                }
            }
            if v["type"] == "response_item"
                && p["type"] == "message"
                && p["role"] == "user"
                && let Some(text) = typed(&p["content"])
            {
                self.prompt = text;
                self.prompts += 1;
                self.answered = false;
            }
            if p["type"] == "thread_goal_updated"
                && let Some(goal) = p["goal"]["objective"].as_str()
            {
                self.title = goal.to_owned();
            }
            if v["type"] == "response_item"
                && p["role"] == "assistant"
                && p["phase"] == "final_answer"
            {
                self.candidate = blocks(&p["content"]);
                if self.active {
                    self.paragraphs.put(
                        format!("{}:final", self.turn),
                        self.candidate.clone(),
                        true,
                    );
                }
            }
            if self.active
                && !self.turn.is_null()
                && v["type"] == "response_item"
                && p["role"] == "assistant"
                && p["phase"] == "commentary"
            {
                let text = blocks(&p["content"]);
                if !text.trim().is_empty() {
                    let key = format!("update:{}:{}", self.turn, self.updates.len());
                    self.paragraphs.put(key.clone(), text.clone(), true);
                    self.updates.push(json!({"key":key,"text":text}));
                }
            }
            if v["type"] != "event_msg" {
                return;
            }
            match p["type"].as_str().unwrap_or_default() {
                "task_started" => {
                    self.turn = p
                        .get("turn_id")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .or_else(|| v.get("timestamp").cloned())
                        .unwrap_or(json!(self.line));
                    self.updates.clear();
                    self.paragraphs.0.clear();
                    self.start_parts(&v["timestamp"]);
                    self.failure = Value::Null;
                    self.active = true;
                    self.candidate.clear();
                }
                "turn_aborted" => {
                    self.updates.clear();
                    self.paragraphs.0.clear();
                    self.parts.clear();
                    self.turn = Value::Null;
                    self.active = false;
                    self.candidate.clear();
                }
                "task_complete" => {
                    self.active = false;
                    if let Some(message) = p["error"]["message"].as_str() {
                        self.failure =
                            json!({"message": failure_message(message), "kind": "error"});
                    }
                    let text = p["last_agent_message"].as_str().unwrap_or(&self.candidate);
                    if !text.trim().is_empty() {
                        self.paragraphs
                            .put(format!("{}:final", self.turn), text.to_owned(), true);
                        self.answer = json!({"key":p["turn_id"],"text":text});
                        self.answered = true;
                        self.failure = Value::Null;
                    }
                    self.candidate.clear();
                }
                _ => {}
            }
        } else if v["isSidechain"] != true {
            if v["type"] == "ai-title"
                && let Some(title) = v["aiTitle"].as_str()
            {
                self.title = title.to_owned();
            }
            self.track_background(&v);
            let m = &v["message"];
            let local = m["content"].as_str().is_some_and(|s| {
                [
                    "<local-command-caveat>",
                    "<local-command-stdout>",
                    "<command-name>",
                ]
                .iter()
                .any(|prefix| s.trim_start().starts_with(prefix))
            });
            if v["isMeta"] == true || local {
                return;
            }
            if v["type"] == "user" {
                // Tool results are user-role records too; they continue the same turn.
                let tool_result = m["content"]
                    .as_array()
                    .is_some_and(|blocks| blocks.iter().any(|b| b["type"] == "tool_result"));
                // Only the person's own message starts a turn. A background task's notification or
                // a compaction summary continues the one in progress.
                let person = typed(&m["content"]).filter(|_| v["isCompactSummary"] != true);
                if let Some(text) = person.filter(|_| !tool_result) {
                    self.prompt = text;
                    self.prompts += 1;
                    self.answered = false;
                    self.failure = Value::Null;
                    self.start_parts(&v["timestamp"]);
                    self.turn = v.get("uuid").cloned().unwrap_or(json!(self.line));
                    self.updates.clear();
                    self.paragraphs.0.clear();
                } else if !tool_result && self.turn.is_null() {
                    self.turn = v.get("uuid").cloned().unwrap_or(json!(self.line));
                }
                self.active = true;
                self.candidate.clear();
                self.candidate_id.clear();
            }
            if v["type"] != "assistant" {
                return;
            }
            // Claude Code records an API failure (a usage limit, a server error) as a synthetic
            // reply; it ends the turn and is not the agent's prose.
            if v["isApiErrorMessage"] == true {
                self.failure = json!({"message": blocks(&m["content"]), "kind": v["error"]});
                self.active = false;
                return;
            }
            self.active = true;
            let id = m["id"].as_str().unwrap_or_default().to_owned();
            for block in m["content"].as_array().into_iter().flatten() {
                match block["type"].as_str().unwrap_or_default() {
                    "text" => self.text(
                        &id,
                        block["text"].as_str().unwrap_or_default(),
                        &v["timestamp"],
                    ),
                    "tool_use" => {
                        self.tool(block["name"].as_str().unwrap_or_default(), &block["input"])
                    }
                    "thinking" | "redacted_thinking" => self.work.thought = true,
                    _ => {}
                }
            }
            if !self.turn.is_null() {
                let message = m
                    .get("id")
                    .or_else(|| v.get("uuid"))
                    .cloned()
                    .unwrap_or(json!(self.line));
                self.paragraphs.put(
                    format!("{}:{message}", self.turn),
                    blocks(&m["content"]),
                    m["stop_reason"] == "end_turn" || m["stop_reason"] == "tool_use",
                );
            }
            // These are persisted assistant text blocks, not streaming deltas or thinking.
            if !self.turn.is_null() && m["stop_reason"] == "tool_use" {
                let text = blocks(&m["content"]);
                let key = format!(
                    "update:{}:{}",
                    self.turn,
                    v.get("uuid").cloned().unwrap_or(json!(self.line))
                );
                if !text.trim().is_empty() && !self.updates.iter().any(|u| u["key"] == key) {
                    self.updates.push(json!({"key":key,"text":text}));
                }
            }
            if m["stop_reason"] != "end_turn" {
                self.candidate.clear();
                self.candidate_id.clear();
                return;
            }
            let text = blocks(&m["content"]);
            if text.is_empty() {
                return;
            }
            let id = m["id"].as_str().unwrap_or_default();
            if self.candidate_id != id {
                self.candidate.clear();
                self.candidate_id = id.to_owned();
            }
            if !self.candidate.is_empty() {
                self.candidate.push_str("\n\n");
            }
            self.candidate.push_str(&text);
            self.answer = json!({"key":id,"text":self.candidate});
            self.answered = true;
            self.failure = Value::Null;
            self.active = false;
        }
    }
    fn value(&self) -> Value {
        json!({"answer":self.answer,"updates":self.updates,"paragraphs":self.paragraphs.values(),"working":self.active,"background":self.background,"prompt":self.prompt,"title":self.title,"updated":self.updated,"prompts":self.prompts,"answered":self.answered,"turn_text":self.paragraphs.text(),"turn_parts":self.turn_parts(),"failure":self.failure})
    }
    /// A background task starts when a tool result names it: a background command's
    /// `backgroundTaskId`, a Monitor's `taskId`, or a background agent's `agentId`. It ends with
    /// a `<task-notification>` Claude Code queues for the session that carries a `<status>` (a
    /// Monitor's other notifications are events while it keeps running) or reports the Monitor
    /// expired, or with a kill. Only those records count, never text that quotes a notification.
    fn track_background(&mut self, v: &Value) {
        let m = &v["message"];
        let remove = |background: &mut Vec<Value>, id: &str| background.retain(|t| t["id"] != id);
        if v["type"] == "assistant" {
            for block in m["content"].as_array().into_iter().flatten() {
                if block["type"] != "tool_use" {
                    continue;
                }
                let input = &block["input"];
                if input["run_in_background"] == true || block["name"] == "Monitor" {
                    let what = ["description", "command", "prompt"]
                        .iter()
                        .find_map(|key| input[*key].as_str())
                        .unwrap_or("background task");
                    if self.launches.len() >= 256 {
                        self.launches.clear();
                    }
                    let what = what.lines().next().unwrap_or_default();
                    self.launches.insert(
                        block["id"].as_str().unwrap_or_default().to_owned(),
                        what.chars().take(120).collect(),
                    );
                }
                if ["KillShell", "KillBash", "TaskStop"]
                    .contains(&block["name"].as_str().unwrap_or_default())
                    && let Some(id) = ["shell_id", "task_id", "bash_id"]
                        .iter()
                        .find_map(|key| input[*key].as_str())
                {
                    remove(&mut self.background, id);
                }
            }
        }
        let result = &v["toolUseResult"];
        let tool = m["content"]
            .as_array()
            .and_then(|blocks| blocks.iter().find_map(|b| b["tool_use_id"].as_str()))
            .unwrap_or_default();
        let started = result["backgroundTaskId"]
            .as_str()
            .or_else(|| {
                result["agentId"]
                    .as_str()
                    .filter(|_| result["isAsync"] == true)
            })
            .or_else(|| {
                result["taskId"]
                    .as_str()
                    .filter(|_| self.launches.contains_key(tool))
            });
        if v["type"] == "user"
            && let Some(id) = started
        {
            let description = self
                .launches
                .remove(tool)
                .unwrap_or_else(|| "background task".into());
            remove(&mut self.background, id);
            self.background
                .push(json!({"id":id,"description":description,"started":v["timestamp"]}));
        }
        let notice = match v["type"].as_str() {
            Some("queue-operation") => v["content"].as_str(),
            Some("attachment") => v["attachment"]["prompt"].as_str(),
            Some("user") => m["content"]
                .as_str()
                .or_else(|| m["content"][0]["text"].as_str()),
            _ => None,
        };
        if let Some(text) = notice.filter(|t| t.trim_start().starts_with("<task-notification>"))
            && (text.contains("<status>") || text.contains("[Monitor expired"))
        {
            // One notification can end several tasks.
            for id in text
                .split("<task-id>")
                .skip(1)
                .filter_map(|rest| rest.split("</task-id>").next())
            {
                remove(&mut self.background, id.trim());
            }
        }
    }
}
#[cfg(test)]
fn parse(agent: &str, log: &str) -> Value {
    let mut transcript = Transcript::default();
    for line in log.lines() {
        transcript.feed(agent, line);
    }
    transcript.value()
}
const WINDOW: u64 = 16 * 1024 * 1024;
/// Where reading stopped: `offset` is just past the last complete line fed to `transcript`.
struct Tail {
    len: u64,
    modified: SystemTime,
    offset: u64,
    transcript: Transcript,
    value: Value,
}
/// Feeds the complete lines of `bytes` and returns how many bytes they used.
fn feed_lines(transcript: &mut Transcript, agent: &str, bytes: &[u8]) -> u64 {
    let Some(end) = bytes.iter().rposition(|b| *b == b'\n') else {
        return 0;
    };
    for line in bytes[..end].split(|b| *b == b'\n') {
        transcript.feed(agent, &String::from_utf8_lossy(line));
    }
    end as u64 + 1
}
fn read_answer(agent: &str, path: &FsPath) -> anyhow::Result<Value> {
    let meta = fs::metadata(path)?;
    let (len, modified) = (meta.len(), meta.modified()?);
    let cached = READS.lock().unwrap().remove(path);
    let mut file = fs::File::open(path)?;
    // Logs only grow; anything else (a shorter file, a large jump, a misaligned line) starts over.
    let tail = match cached {
        Some(tail) if tail.len == len && tail.modified == modified => Some(tail),
        Some(mut tail) if tail.offset > 0 && len >= tail.offset && len - tail.offset <= WINDOW => {
            let mut bytes = Vec::new();
            file.seek(SeekFrom::Start(tail.offset - 1))?;
            (&mut file)
                .take(len - tail.offset + 1)
                .read_to_end(&mut bytes)?;
            if bytes.first() == Some(&b'\n') {
                tail.offset += feed_lines(&mut tail.transcript, agent, &bytes[1..]);
                tail.value = Value::Null;
                Some(tail)
            } else {
                None
            }
        }
        _ => None,
    };
    let mut tail = match tail {
        Some(tail) => tail,
        None => {
            let start = len.saturating_sub(WINDOW);
            let mut bytes = Vec::new();
            file.seek(SeekFrom::Start(start))?;
            file.take(len - start).read_to_end(&mut bytes)?;
            // A window that starts mid-file begins after its first, partial line.
            let skip = if start > 0 {
                bytes
                    .iter()
                    .position(|b| *b == b'\n')
                    .map_or(bytes.len(), |i| i + 1)
            } else {
                0
            };
            let mut transcript = Transcript::default();
            let used = feed_lines(&mut transcript, agent, &bytes[skip..]);
            Tail {
                len,
                modified,
                offset: start + skip as u64 + used,
                transcript,
                value: Value::Null,
            }
        }
    };
    tail.len = len;
    tail.modified = modified;
    if tail.value.is_null() {
        tail.value = identified(tail.transcript.value(), path);
    }
    let value = tail.value.clone();
    let mut cache = READS.lock().unwrap();
    if cache.len() >= 32 {
        cache.clear();
    }
    cache.insert(path.to_owned(), tail);
    Ok(value)
}
fn identified(mut value: Value, path: &FsPath) -> Value {
    let session = path.file_stem().unwrap_or_default().to_string_lossy();
    value["session"] = json!(session);
    if !value["answer"].is_null() {
        identify(&mut value["answer"], &session);
    }
    for list in ["updates", "paragraphs"] {
        if let Some(messages) = value[list].as_array_mut() {
            for message in messages {
                identify(message, &session);
            }
        }
    }
    value
}
fn identify(message: &mut Value, session: &str) {
    let key = format!("{}:{}:{}", session, message["key"], message["text"]);
    message["id"] = json!(format!("{:x}", Sha256::digest(key.as_bytes())));
}
fn speech_message<'a>(value: &'a Value, id: &str) -> Option<&'a Value> {
    std::iter::once(&value["answer"])
        .chain(value["updates"].as_array().into_iter().flatten())
        .chain(value["paragraphs"].as_array().into_iter().flatten())
        .find(|message| message["id"].as_str() == Some(id))
}
async fn latest(app: &App, pane: &str) -> anyhow::Result<Value> {
    let snapshot = app.herdr.call("session.snapshot", json!({})).await?;
    let agent = snapshot["snapshot"]["agents"]
        .as_array()
        .and_then(|a| a.iter().find(|p| p["pane_id"] == pane))
        .ok_or_else(|| anyhow::anyhow!("No supported agent in this pane"))?
        .clone();
    let name = agent["agent"].as_str().unwrap_or_default().to_owned();
    anyhow::ensure!(
        name == "codex" || name == "claude",
        "Voice currently supports Codex and Claude"
    );
    let info = app
        .herdr
        .call("pane.process_info", json!({"pane_id":pane}))
        .await?;
    tokio::task::spawn_blocking(move || {
        let path = resolve(&name, &info["process_info"], &agent)?;
        let mut value = read_answer(&name, &path)?;
        // Supported agents accept input while working, just like the normal Send button.
        value["can_send"] = json!(true);
        // A live working state suppresses premature playback even if a transcript block looks final.
        if agent["agent_status"] == "working" {
            value["working"] = json!(true);
        }
        Ok(value)
    })
    .await?
}
/// Seconds since 1970 for an RFC 3339 UTC timestamp such as `2026-09-15T13:10:22.935Z`.
fn epoch(time: &str) -> Option<f64> {
    let (date, clock) = time.strip_suffix('Z')?.split_once('T')?;
    let mut date = date.split('-').map(|n| n.parse::<i64>());
    let (year, month, day) = (date.next()?.ok()?, date.next()?.ok()?, date.next()?.ok()?);
    let mut clock = clock.split(':');
    let (hour, minute) = (
        clock.next()?.parse::<i64>().ok()?,
        clock.next()?.parse::<i64>().ok()?,
    );
    let second: f64 = clock.next()?.parse().ok()?;
    // Days from the civil date (Howard Hinnant's days_from_civil).
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    Some((days * 86_400 + hour * 3600 + minute * 60) as f64 + second)
}
/// When a process started, in seconds since 1970.
fn process_started(pid: u64) -> Option<f64> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let ticks: f64 = stat
        .rsplit_once(") ")?
        .1
        .split_whitespace()
        .nth(19)?
        .parse()
        .ok()?;
    let boot: f64 = fs::read_to_string("/proc/stat")
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("btime "))?
        .trim()
        .parse()
        .ok()?;
    let hertz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
    Some(boot + ticks / hertz)
}
/// Tasks the running agent still owns: ones begun before it started belonged to an earlier
/// process, whose background work ended with it.
fn current_tasks(tasks: &Value, started: Option<f64>) -> Vec<Value> {
    tasks
        .as_array()
        .into_iter()
        .flatten()
        .filter(
            |task| match (started, task["started"].as_str().and_then(epoch)) {
                (Some(process), Some(task)) => task + 2.0 >= process,
                _ => true,
            },
        )
        .map(|task| json!({"description":task["description"],"started":task["started"]}))
        .collect()
}
type BackgroundCache = HashMap<String, (std::time::Instant, Vec<Value>)>;
static BACKGROUND: LazyLock<Mutex<BackgroundCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// Adds `background` to each Claude pane in a Herdr snapshot: the background commands and agents
/// it waits on, so an idle agent that is still waiting is not mistaken for a finished one. Kept
/// for a few seconds, as every client asks for snapshots.
pub async fn annotate(herdr: &crate::herdr::Herdr, snapshot: &mut Value) {
    let agents: Vec<Value> = snapshot["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|agent| agent["agent"] == "claude")
        .cloned()
        .collect();
    for agent in agents {
        let Some(pane) = agent["pane_id"].as_str().map(str::to_owned) else {
            continue;
        };
        let key = format!("{pane}:{}", agent["terminal_id"]);
        let cached = BACKGROUND
            .lock()
            .unwrap()
            .get(&key)
            .filter(|(at, _)| at.elapsed() < std::time::Duration::from_secs(4))
            .map(|(_, tasks)| tasks.clone());
        let tasks = match cached {
            Some(tasks) => tasks,
            None => {
                let tasks = background_of(herdr, &pane, agent).await.unwrap_or_default();
                let mut cache = BACKGROUND.lock().unwrap();
                if cache.len() >= 256 {
                    cache.clear();
                }
                cache.insert(key, (std::time::Instant::now(), tasks.clone()));
                tasks
            }
        };
        if tasks.is_empty() {
            continue;
        }
        for entry in snapshot["panes"].as_array_mut().into_iter().flatten() {
            if entry["pane_id"] == pane.as_str() {
                entry["background"] = json!(tasks);
            }
        }
    }
}
async fn background_of(
    herdr: &crate::herdr::Herdr,
    pane: &str,
    agent: Value,
) -> anyhow::Result<Vec<Value>> {
    let value = thread(herdr, pane, agent).await?;
    Ok(value["background"].as_array().cloned().unwrap_or_default())
}
/// What a Claude or Codex pane's conversation shows: its latest prose, the person's last message,
/// its title, when it was last active, and the background work it still waits on.
/// A Claude or Codex pane's conversation log, and which agent wrote it.
pub async fn session_log(
    herdr: &crate::herdr::Herdr,
    pane: &str,
    agent: &Value,
) -> anyhow::Result<(String, PathBuf, Value)> {
    let name = agent["agent"].as_str().unwrap_or_default().to_owned();
    anyhow::ensure!(
        name == "codex" || name == "claude",
        "Only Codex and Claude conversations can be read"
    );
    let info = herdr
        .call("pane.process_info", json!({"pane_id":pane}))
        .await?;
    let reported = agent.clone();
    let lookup = name.clone();
    let path = tokio::task::spawn_blocking(move || {
        resolve(&lookup, &info["process_info"], &reported).map(|path| (path, info))
    })
    .await??;
    Ok((name, path.0, path.1))
}
/// What a Claude or Codex pane's conversation shows: its latest prose, the person's last message,
/// its title, when it was last active, and the background work it still waits on.
pub async fn thread(
    herdr: &crate::herdr::Herdr,
    pane: &str,
    agent: Value,
) -> anyhow::Result<Value> {
    let (name, path, info) = session_log(herdr, pane, &agent).await?;
    tokio::task::spawn_blocking(move || {
        let mut value = read_answer(&name, &path)?;
        // Tasks from before this process started ended with the previous one.
        let started = info["process_info"]["foreground_processes"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["name"].as_str().unwrap_or_default().contains(&name))
            .and_then(|p| p["pid"].as_u64())
            .and_then(process_started);
        value["background"] = json!(current_tasks(&value["background"], started));
        Ok(value)
    })
    .await?
}
/// The conversation as the person and the agent wrote it, oldest first: `(true, text)` for the
/// person's messages and `(false, text)` for the agent's prose, without tool calls, their output,
/// thinking, or side conversations. Reads at most the log's last `WINDOW` bytes.
pub fn exchanges(agent: &str, path: &FsPath) -> anyhow::Result<Vec<(bool, String)>> {
    let mut file = fs::File::open(path)?;
    let len = file.metadata()?.len();
    let start = len.saturating_sub(WINDOW);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.take(len - start).read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.lines();
    if start > 0 {
        lines.next();
    }
    Ok(exchanges_of(agent, lines))
}
fn exchanges_of<'a>(agent: &str, lines: impl Iterator<Item = &'a str>) -> Vec<(bool, String)> {
    let mut out: Vec<(bool, String)> = Vec::new();
    let mut push = |person: bool, text: String| {
        let text = text.trim().to_owned();
        if text.is_empty() {
            return;
        }
        // An agent's consecutive text blocks are one reply.
        match out.last_mut() {
            Some((false, previous)) if !person => {
                previous.push_str("\n\n");
                previous.push_str(&text);
            }
            _ => out.push((person, text)),
        }
    };
    for line in lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if agent == "codex" {
            let p = &v["payload"];
            if v["type"] != "response_item" || p["type"] != "message" {
                continue;
            }
            if p["role"] == "user" {
                if let Some(text) = typed(&p["content"]) {
                    push(true, text);
                }
            } else if p["role"] == "assistant" {
                push(false, blocks(&p["content"]));
            }
        } else {
            if v["isSidechain"] == true || v["isMeta"] == true {
                continue;
            }
            let m = &v["message"];
            if v["type"] == "user" {
                if let Some(text) = typed(&m["content"]) {
                    push(true, text);
                }
            } else if v["type"] == "assistant" {
                push(false, blocks(&m["content"]));
            }
        }
    }
    out
}
pub async fn response(
    State(app): State<App>,
    Path(pane): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(latest(&app, &pane).await.map_err(error)?))
}
fn adapter() -> anyhow::Result<Vec<String>> {
    let args: Vec<String> = if let Ok(value) = std::env::var("OMARCHY_SPEECH_COMMAND") {
        serde_json::from_str(&value)?
    } else {
        let model = std::env::var("OMARCHY_SPEECH_MODEL").unwrap_or_else(|_| {
            home()
                .join(".local/share/omarchy-remote/voices/en_US-lessac-medium.onnx")
                .to_string_lossy()
                .into()
        });
        vec![
            "piper".into(),
            "--model".into(),
            model,
            "--input-file".into(),
            "{text}".into(),
            "--output-file".into(),
            "{audio}".into(),
        ]
    };
    anyhow::ensure!(
        !args.is_empty()
            && args.iter().skip(1).any(|x| x == "{text}")
            && args.iter().skip(1).any(|x| x == "{audio}"),
        "Speech command must contain {{text}} and {{audio}} arguments"
    );
    Ok(args)
}
pub async fn status() -> Json<Value> {
    let ready = adapter().is_ok_and(|a| {
        apps::resolve_program(&a[0]).is_ok()
            && (std::env::var_os("OMARCHY_SPEECH_COMMAND").is_some()
                || FsPath::new(&a[2]).is_file())
    });
    Json(
        json!({"available":ready,"provider":if std::env::var_os("OMARCHY_SPEECH_COMMAND").is_some() {"Custom command"} else {"Piper"},"message":if ready {"Ready"} else {"Install Piper and a voice model, or configure OMARCHY_SPEECH_COMMAND"}}),
    )
}
fn spoken(text: &str) -> String {
    let mut fence = None;
    let mut lines = Vec::new();
    for line in text.split('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = &trimmed[..3];
            if fence == Some(marker) {
                fence = None;
            } else if fence.is_none() {
                fence = Some(marker);
                lines.push("Code block omitted.");
            }
            continue;
        }
        if fence.is_none() {
            lines.push(line.trim_start_matches('#').trim());
        }
    }
    let text = lines.join("\n");
    let links = regex::Regex::new(r"\[([^\]]+)\]\([^\)]+\)").unwrap();
    links.replace_all(&text, "$1").replace(['*', '`'], "")
}
#[derive(Deserialize)]
pub struct SpeechRequest {
    response_id: String,
    #[serde(default)]
    response_ids: Vec<String>,
    #[serde(default)]
    stream: bool,
}
pub async fn audio(
    State(app): State<App>,
    Path(pane): Path<String>,
    Json(request): Json<SpeechRequest>,
) -> Result<Response, ApiError> {
    let value = latest(&app, &pane).await.map_err(error)?;
    speak(&value, request).await
}
/// A Claude Code session log's latest reply prose, for Chat's Voice mode.
pub fn claude_answer(path: &FsPath) -> anyhow::Result<Value> {
    read_answer("claude", path)
}
/// Speaks messages of `value`, a transcript's latest prose, by their ids.
pub async fn speak(value: &Value, request: SpeechRequest) -> Result<Response, ApiError> {
    let ids = if request.response_ids.is_empty() {
        vec![request.response_id]
    } else {
        request.response_ids
    };
    if ids.len() > 64 {
        return Err(error("Too many speech paragraphs"));
    }
    let mut messages = Vec::new();
    for id in &ids {
        let Some(message) = speech_message(value, id) else {
            return Err((
                StatusCode::CONFLICT,
                Json(json!({"error":"The response changed; read the latest answer"})),
            ));
        };
        messages.push(message["text"].as_str().unwrap_or_default());
    }
    let mut args = adapter().map_err(error)?;
    // A host adapter opts into PCM streaming with the {format} placeholder.
    // Old clients and adapters retain their complete-WAV contract.
    let streaming = request.stream && args.iter().any(|arg| arg == "{format}");
    let cache_key = format!("{ids:?}:{args:?}");
    if let Some(data) = AUDIO.lock().unwrap().get(&cache_key).cloned() {
        return Ok(wav(data));
    }
    let _permit = JOBS.try_acquire().map_err(|_| {
        (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"Speech is busy; try Replay shortly"})),
        )
    })?;
    let text = spoken(&messages.join("\n\n"));
    if text.is_empty() || text.len() > MAX_TEXT {
        return Err(error(
            "Response is empty or exceeds the 64 KiB speech limit",
        ));
    }
    let dir = dictation::AudioDir::new().map_err(error)?;
    let input = dir.0.join("response.txt");
    let output = dir.0.join("response.wav");
    tokio::fs::write(&input, text).await.map_err(error)?;
    for arg in args.iter_mut().skip(1) {
        if arg == "{text}" {
            *arg = input.to_string_lossy().into();
        } else if arg == "{audio}" {
            *arg = output.to_string_lossy().into();
        } else if arg == "{format}" {
            *arg = if streaming { "pcm-stream" } else { "wav" }.into();
        }
    }
    if streaming {
        return stream_audio(args, dir, _permit, cache_key).map_err(error);
    }
    dictation::execute(&args, 180)
        .await
        .map_err(|_| error("Speech generation failed or timed out; check the host provider"))?;
    let meta = tokio::fs::symlink_metadata(&output).await.map_err(error)?;
    if !meta.is_file() || meta.len() > MAX_AUDIO {
        return Err(error(
            "Speech audio exceeds 32 MiB or is not a regular file",
        ));
    }
    let data = tokio::fs::read(output).await.map_err(error)?;
    if !data.starts_with(b"RIFF") || data.get(8..12) != Some(b"WAVE") {
        return Err(error("Speech command must produce a WAV file"));
    }
    cache_audio(cache_key, data.clone());
    Ok(wav(data))
}
fn cache_audio(key: String, data: Vec<u8>) {
    let mut cache = AUDIO.lock().unwrap();
    if cache.values().map(Vec::len).sum::<usize>() + data.len() > 64 * 1024 * 1024 {
        cache.clear();
    }
    cache.insert(key, data);
}

// Framed mono 24 kHz PCM16. A zero frame is sent only after successful exit;
// truncated output, timeouts, and failed commands therefore cannot look complete.
const MAX_PCM_FRAME: usize = 2 * 1024 * 1024;
async fn pcm_frame<R: tokio::io::AsyncRead + Unpin>(
    reader: &mut R,
    total: &mut u64,
) -> anyhow::Result<Vec<u8>> {
    let size = reader.read_u32_le().await? as usize;
    anyhow::ensure!(
        size <= MAX_PCM_FRAME && size.is_multiple_of(2),
        "Invalid PCM frame"
    );
    *total += size as u64;
    anyhow::ensure!(*total <= MAX_AUDIO, "Speech audio exceeds 32 MiB");
    let mut frame = vec![0; size + 4];
    frame[..4].copy_from_slice(&(size as u32).to_le_bytes());
    reader.read_exact(&mut frame[4..]).await?;
    Ok(frame)
}

fn stream_audio(
    args: Vec<String>,
    dir: dictation::AudioDir,
    permit: tokio::sync::SemaphorePermit<'static>,
    cache_key: String,
) -> anyhow::Result<Response> {
    let executable = apps::resolve_program(&args[0])?;
    let mut child = Command::new(executable)
        .args(&args[1..])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()?;
    let group = dictation::ProcessGroup(
        child
            .id()
            .ok_or_else(|| anyhow::anyhow!("Speech did not start"))?,
    );
    let stdout = child.stdout.take().unwrap();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(180);
    let body = futures_util::stream::try_unfold(
        (
            child,
            stdout,
            dir,
            permit,
            group,
            0_u64,
            Vec::new(),
            cache_key,
            false,
        ),
        move |(mut child, mut pipe, dir, permit, group, mut total, mut pcm, key, ended)| async move {
            if ended {
                return Ok::<_, std::io::Error>(None);
            }
            let frame = tokio::time::timeout_at(deadline, async {
                let frame = pcm_frame(&mut pipe, &mut total).await?;
                if frame.len() == 4 {
                    anyhow::ensure!(total > 0, "Speech stream is empty");
                    let mut extra = [0];
                    anyhow::ensure!(pipe.read(&mut extra).await? == 0, "Trailing PCM data");
                    anyhow::ensure!(child.wait().await?.success(), "Speech command failed");
                }
                Ok::<_, anyhow::Error>(frame)
            })
            .await
            .map_err(std::io::Error::other)?
            .map_err(|_| std::io::Error::other("Speech stream failed"))?;
            let ended = frame.len() == 4;
            if ended {
                cache_audio(key.clone(), pcm_wav(&pcm));
                pcm.clear();
            } else {
                pcm.extend_from_slice(&frame[4..]);
            }
            Ok(Some((
                Bytes::from(frame),
                (child, pipe, dir, permit, group, total, pcm, key, ended),
            )))
        },
    );
    Ok((
        [
            (header::CONTENT_TYPE, "application/vnd.omarchy.pcm-stream"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        Body::from_stream(body),
    )
        .into_response())
}
fn pcm_wav(pcm: &[u8]) -> Vec<u8> {
    let mut wav = Vec::with_capacity(pcm.len() + 44);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(pcm.len() as u32 + 36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes());
    wav.extend_from_slice(&24000_u32.to_le_bytes());
    wav.extend_from_slice(&48000_u32.to_le_bytes());
    wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(pcm.len() as u32).to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}
fn wav(data: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, "audio/wav"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        data,
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct VoiceInput {
    session: String,
    text: String,
}
pub async fn send(
    State(app): State<App>,
    Path(pane): Path<String>,
    Json(input): Json<VoiceInput>,
) -> Result<Json<Value>, ApiError> {
    if input.text.trim().is_empty() || input.text.len() > 16384 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Voice message is empty or too long"})),
        ));
    }
    let latest = latest(&app, &pane).await.map_err(error)?;
    if latest["session"] != input.session {
        return Err((
            StatusCode::CONFLICT,
            Json(json!({"error":"Conversation changed; draft kept"})),
        ));
    }
    Ok(Json(
        app.herdr
            .input(&pane, &input.text, &["Enter".into()], false)
            .await
            .map_err(error)?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[tokio::test]
    async fn stream_delivers_early_and_cancellation_cleans_up() {
        static TEST_JOBS: Semaphore = Semaphore::const_new(1);
        let dir = dictation::AudioDir::new().unwrap();
        let path = dir.0.clone();
        let response = stream_audio(
            vec![
                "sh".into(),
                "-c".into(),
                "printf '\\002\\000\\000\\000\\001\\000'; sleep 30".into(),
            ],
            dir,
            TEST_JOBS.acquire().await.unwrap(),
            "stream-cancel-test".into(),
        )
        .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/vnd.omarchy.pcm-stream"
        );
        let mut body = response.into_body().into_data_stream();
        let first = tokio::time::timeout(std::time::Duration::from_secs(2), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(first.as_ref(), &[2, 0, 0, 0, 1, 0]);
        assert_eq!(TEST_JOBS.available_permits(), 0);
        drop(body);
        assert!(!path.exists());
        assert_eq!(TEST_JOBS.available_permits(), 1);
        assert!(!AUDIO.lock().unwrap().contains_key("stream-cancel-test"));
    }

    #[tokio::test]
    async fn stream_requires_success_and_caches_only_complete_audio() {
        static TEST_JOBS: Semaphore = Semaphore::const_new(1);
        for (name, script, success) in [
            (
                "complete",
                "printf '\\002\\000\\000\\000\\001\\000\\000\\000\\000\\000'",
                true,
            ),
            (
                "truncated",
                "printf '\\002\\000\\000\\000\\001\\000'",
                false,
            ),
            (
                "failed",
                "printf '\\002\\000\\000\\000\\001\\000\\000\\000\\000\\000'; exit 1",
                false,
            ),
            ("odd", "printf '\\003\\000\\000\\000'", false),
            ("huge", "printf '\\000\\000\\100\\000'", false),
            ("empty", "printf '\\000\\000\\000\\000'", false),
        ] {
            let key = format!("stream-test-{name}");
            let response = stream_audio(
                vec!["sh".into(), "-c".into(), script.into()],
                dictation::AudioDir::new().unwrap(),
                TEST_JOBS.acquire().await.unwrap(),
                key.clone(),
            )
            .unwrap();
            let result = axum::body::to_bytes(response.into_body(), 100).await;
            assert_eq!(result.is_ok(), success, "{name}");
            let mut cache = AUDIO.lock().unwrap();
            assert_eq!(cache.contains_key(&key), success, "{name}");
            if success {
                assert_eq!(cache.remove(&key).unwrap(), pcm_wav(&[1, 0]));
            }
        }
    }

    #[test]
    fn a_turn_notes_the_work_between_what_the_agent_wrote() {
        let at = |s: u32| format!("2026-10-07T10:{:02}:{:02}.000Z", s / 60, s % 60);
        let rows = [
            json!({"type":"user","timestamp":at(0),"message":{"role":"user","content":"Fix the build"}}),
            json!({"type":"assistant","timestamp":at(3),"message":{"id":"a","content":[{"type":"text","text":"Looking."}]}}),
            json!({"type":"assistant","timestamp":at(5),"message":{"id":"a","content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo build"}}]}}),
            json!({"type":"user","timestamp":at(40),"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"error"}]}}),
            json!({"type":"assistant","timestamp":at(42),"message":{"id":"b","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/src/a.rs"}}]}}),
            json!({"type":"assistant","timestamp":at(50),"message":{"id":"b","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/src/a.rs"}}]}}),
            json!({"type":"assistant","timestamp":at(60),"message":{"id":"b","content":[{"type":"tool_use","name":"Write","input":{"file_path":"/src/b.rs"}}]}}),
            json!({"type":"assistant","timestamp":at(95),"message":{"id":"c","content":[{"type":"text","text":"Fixed the missing import."}]}}),
            json!({"type":"assistant","timestamp":at(97),"message":{"id":"c","content":[{"type":"text","text":"Building again."}]}}),
            json!({"type":"assistant","timestamp":at(99),"message":{"id":"d","content":[{"type":"thinking","thinking":"hmm"}]}}),
            json!({"type":"assistant","timestamp":at(130),"message":{"id":"d","stop_reason":"end_turn","content":[{"type":"text","text":"All green."}]}}),
        ];
        let lines: Vec<String> = rows.iter().map(Value::to_string).collect();
        let done = parse("claude", &lines.join("\n"));
        assert_eq!(
            done["turn_parts"],
            json!([
                {"id":"a","text":"Looking."},
                {"work":{"seconds":92.0,"tools":4,"files":2,"thought":false}},
                {"id":"c","text":"Fixed the missing import.\n\nBuilding again."},
                {"work":{"seconds":33.0,"tools":0,"files":0,"thought":true}},
                {"id":"d","text":"All green."},
            ])
        );
        // While it works, the work since the last text closes the turn.
        let working = parse("claude", &lines[..5].join("\n"));
        let parts = working["turn_parts"].as_array().unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["work"]["ongoing"], true);
        assert_eq!(parts[1]["work"]["since"], at(3));
        assert_eq!(parts[1]["work"]["tools"], 2);
        assert_eq!(parts[1]["work"]["files"], 1);
        // Codex patches name the files they change.
        assert_eq!(
            edited_files(
                "exec",
                &json!(
                    "text(await tools.apply_patch(\"*** Begin Patch\\n*** Update File: /a/b.rs\\n@@\\n*** Add File: /a/c.rs\\n+x\"))"
                )
            ),
            vec!["/a/b.rs".to_owned(), "/a/c.rs".to_owned()]
        );
        assert!(edited_files("Bash", &json!({"command":"ls"})).is_empty());
    }

    #[test]
    fn a_failed_turn_says_why_until_the_next_reply() {
        let claude = [
            json!({"type":"user","message":{"role":"user","content":"Keep going"}}),
            json!({"type":"assistant","isApiErrorMessage":true,"error":"rate_limit","message":{"id":"x","model":"<synthetic>","stop_reason":"stop_sequence","content":[{"type":"text","text":"You've hit your session limit · resets 11:10pm"}]}}),
        ];
        let lines: Vec<String> = claude.iter().map(Value::to_string).collect();
        let value = parse("claude", &lines.join("\n"));
        assert_eq!(
            value["failure"]["message"],
            "You've hit your session limit · resets 11:10pm"
        );
        assert_eq!(value["failure"]["kind"], "rate_limit");
        assert_eq!(value["working"], false);
        // The failure is not the agent's prose or answer.
        assert_eq!(value["turn_text"], "");
        assert_eq!(value["answered"], false);
        let retried = format!(
            "{}\n{}",
            lines.join("\n"),
            json!({"type":"user","message":{"role":"user","content":"Try again"}})
        );
        assert_eq!(parse("claude", &retried)["failure"], Value::Null);
        let codex = [
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"t"}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"t","last_agent_message":null,"error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account.\"}}"}}}),
        ];
        let lines: Vec<String> = codex.iter().map(Value::to_string).collect();
        let value = parse("codex", &lines.join("\n"));
        assert_eq!(
            value["failure"]["message"],
            "The 'gpt-6-astra' model is not supported when using Codex with a ChatGPT account."
        );
        assert_eq!(
            failure_message("You've hit your usage limit."),
            "You've hit your usage limit."
        );
    }

    #[test]
    fn a_pasted_message_starts_a_turn_and_notifications_continue_it() {
        let rows = [
            json!({"type":"user","message":{"role":"user","content":"Yep, shorts look good now"}}),
            json!({"type":"assistant","message":{"id":"a","stop_reason":"end_turn","content":[{"type":"text","text":"Drafted the thumbnails."}]}}),
            json!({"type":"user","message":{"role":"user","content":"\n\n<pasted_content id=\"bf6a\">\nResearch the Mac mini for the video\n</pasted_content id=\"bf6a\">"}}),
            json!({"type":"assistant","message":{"id":"b","stop_reason":"tool_use","content":[{"type":"text","text":"Looking at **specs** first."}]}}),
            json!({"type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n</task-notification>"}}),
            json!({"type":"user","message":{"role":"user","content":"[Request interrupted by user]"}}),
            json!({"type":"user","isCompactSummary":true,"message":{"role":"user","content":"This session is being continued from a previous conversation."}}),
            json!({"type":"assistant","message":{"id":"c","stop_reason":"end_turn","content":[{"type":"text","text":"The M5 Mac mini is the one to cover."}]}}),
        ];
        let lines: Vec<String> = rows.iter().map(Value::to_string).collect();
        let value = parse("claude", &lines.join("\n"));
        assert_eq!(value["prompt"], "Research the Mac mini for the video");
        assert_eq!(value["prompts"], 2);
        assert_eq!(value["answered"], true);
        // Everything since the message, as written, survives the notification mid-turn.
        assert_eq!(
            value["turn_text"],
            "Looking at **specs** first.\n\nThe M5 Mac mini is the one to cover."
        );
        assert_eq!(
            value["answer"]["text"],
            "The M5 Mac mini is the one to cover."
        );
        // Mid-turn, before the reply, the notification has not cleared what was written.
        let value = parse("claude", &lines[..5].join("\n"));
        assert_eq!(value["answered"], false);
        assert_eq!(value["turn_text"], "Looking at **specs** first.");
        assert!(!injected("<pasted_content id=\"x\">hi"));
        assert!(injected("  <system-reminder>x</system-reminder>"));
    }

    #[test]
    fn exchanges_keep_only_what_the_person_and_agent_wrote() {
        let claude = [
            json!({"type":"user","message":{"role":"user","content":"Fix the login bug"}}),
            json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Looking at auth.rs."},{"type":"tool_use","name":"Read","input":{}}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"file text"}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Fixed the refresh."}]}}),
            json!({"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"Worker notes"}]}}),
            json!({"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat"}}),
            json!({"type":"user","message":{"role":"user","content":"Thanks, now add a test"}}),
        ];
        let lines: Vec<String> = claude.iter().map(Value::to_string).collect();
        assert_eq!(
            exchanges_of("claude", lines.iter().map(String::as_str)),
            vec![
                (true, "Fix the login bug".to_owned()),
                (
                    false,
                    "Looking at auth.rs.\n\nFixed the refresh.".to_owned()
                ),
                (true, "Thanks, now add a test".to_owned()),
            ]
        );
        let codex = [
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>x</environment_context>"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Make it faster"}]}}),
            json!({"type":"response_item","payload":{"type":"reasoning","summary":[]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Profiled; the renderer was the bottleneck."}]}}),
        ];
        let lines: Vec<String> = codex.iter().map(Value::to_string).collect();
        assert_eq!(
            exchanges_of("codex", lines.iter().map(String::as_str)),
            vec![
                (true, "Make it faster".to_owned()),
                (
                    false,
                    "Profiled; the renderer was the bottleneck.".to_owned()
                ),
            ]
        );
    }

    #[test]
    fn transcripts_name_the_last_prompt_the_title_and_the_last_activity() {
        let claude = [
            json!({"type":"user","timestamp":"2026-10-07T10:00:00Z","message":{"role":"user","content":"Fix the login bug"}}),
            json!({"type":"ai-title","aiTitle":"Login bug fix"}),
            // Notifications and reminders the agent receives are not the person's words.
            json!({"type":"user","timestamp":"2026-10-07T10:01:00Z","message":{"role":"user","content":"<task-notification><status>completed</status></task-notification>"}}),
            json!({"type":"user","timestamp":"2026-10-07T10:02:00Z","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>x</system-reminder>"},{"type":"text","text":"Also add a test"}]}}),
            json!({"type":"user","timestamp":"2026-10-07T10:03:00Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t","content":"ok"}]}}),
        ];
        let value = parse(
            "claude",
            &claude
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        assert_eq!(value["prompt"], "Also add a test");
        // No reply has come since the last message.
        assert_eq!(value["answered"], false);
        assert_eq!(value["title"], "Login bug fix");
        assert_eq!(value["updated"], "2026-10-07T10:03:00Z");
        let codex = [
            json!({"type":"response_item","timestamp":"2026-10-07T11:00:00Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}),
            json!({"type":"response_item","timestamp":"2026-10-07T11:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<image name=[Image #1]>"},{"type":"input_text","text":"</image>"},{"type":"input_text","text":"Make the taxi faster"}]}}),
            json!({"type":"response_item","timestamp":"2026-10-07T11:00:01Z","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<codex_internal_context source=\"goal\">Keep going</codex_internal_context>"}]}}),
            json!({"type":"event_msg","timestamp":"2026-10-07T11:00:02Z","payload":{"type":"thread_goal_updated","goal":{"objective":"Ship the driving game"}}}),
        ];
        let value = parse(
            "codex",
            &codex
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        assert_eq!(value["prompt"], "Make the taxi faster");
        assert_eq!(value["title"], "Ship the driving game");
        assert_eq!(value["updated"], "2026-10-07T11:00:02Z");
    }

    #[test]
    fn paragraphs_are_stable_as_partial_prose_finishes() {
        let mut prose = Paragraphs::default();
        prose.put(
            "turn:message".into(),
            "First paragraph.\n\nUnfinished".into(),
            false,
        );
        let first = prose.values();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["text"], "First paragraph.");
        prose.put(
            "turn:message".into(),
            "First paragraph.\n\nFinished paragraph.".into(),
            true,
        );
        let complete = prose.values();
        assert_eq!(complete.len(), 2);
        assert_eq!(complete[0], first[0]);
        prose.put(
            "turn:message".into(),
            "First paragraph.\n\nFinished paragraph.".into(),
            true,
        );
        assert_eq!(prose.values(), complete);
        let mut boundary = Paragraphs::default();
        boundary.put("boundary".into(), "Ready.\n\n".into(), false);
        assert_eq!(boundary.values()[0]["text"], "Ready.");
        boundary.put(
            "code".into(),
            "```\nsecret\n\nmore secret\n```\n\nSafe prose.".into(),
            true,
        );
        assert!(!format!("{:?}", boundary.values()).contains("secret"));
    }

    #[test]
    fn codex_final_paragraphs_are_available_before_task_complete_without_repeats() {
        let mut rows = vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"First.\n\nSecond."}]}}),
        ];
        let early = parse("codex", &log(&rows));
        assert!(early["answer"].is_null());
        assert_eq!(early["paragraphs"].as_array().unwrap().len(), 2);
        rows.push(json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one","last_agent_message":"First.\n\nSecond."}}));
        assert_eq!(
            parse("codex", &log(&rows))["paragraphs"],
            early["paragraphs"]
        );
    }

    #[test]
    fn claude_exposes_only_complete_persisted_paragraphs_before_stop() {
        let mut rows = vec![
            json!({"type":"user","uuid":"turn","message":{"content":"Request"}}),
            json!({"type":"assistant","message":{"id":"reply","stop_reason":null,"content":[{"type":"thinking","thinking":"secret"},{"type":"text","text":"First.\n\nSecond"}]}}),
        ];
        let early = parse("claude", &log(&rows));
        assert_eq!(early["paragraphs"].as_array().unwrap().len(), 1);
        assert_eq!(early["paragraphs"][0]["text"], "First.");
        rows.push(json!({"type":"assistant","message":{"id":"reply","stop_reason":"end_turn","content":[{"type":"text","text":"First.\n\nSecond."}]}}));
        let complete = parse("claude", &log(&rows));
        assert_eq!(complete["paragraphs"].as_array().unwrap().len(), 2);
        assert_eq!(complete["paragraphs"][0], early["paragraphs"][0]);
    }
    #[test]
    fn codex_keeps_progress_separate_from_completed_answers() {
        let log = [
            json!({"type":"event_msg","payload":{"type":"task_started"}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Working"}]}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"Complete answer"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert!(parse("codex", &log)["answer"].is_null());
        assert_eq!(parse("codex", &log)["updates"][0]["text"], "Working");
        let done = format!(
            "{log}\n{}",
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"1"}})
        );
        assert_eq!(parse("codex", &done)["answer"]["text"], "Complete answer");
        let working = format!(
            "{done}\n{}",
            json!({"type":"event_msg","payload":{"type":"task_started"}})
        );
        assert_eq!(parse("codex", &working)["working"], true);
        assert_eq!(parse("codex", &working)["answer"]["key"], "1");
        let abort = format!(
            "{working}\n{}",
            json!({"type":"event_msg","payload":{"type":"turn_aborted"}})
        );
        assert_eq!(parse("codex", &abort)["working"], false);
    }
    #[test]
    fn claude_skips_tools_thoughts_and_sidechains() {
        let log = [
            json!({"type":"assistant","message":{"id":"one","stop_reason":"tool_use","content":[{"type":"text","text":"Running a tool"}]}}),
            json!({"type":"assistant","message":{"id":"two","stop_reason":"end_turn","content":[{"type":"thinking","thinking":"Private"},{"type":"text","text":"First paragraph"}]}}),
            json!({"type":"assistant","message":{"id":"two","stop_reason":"end_turn","content":[{"type":"text","text":"Second paragraph"}]}}),
            json!({"type":"user","message":{"content":"<command-name>/exit</command-name>"}}),
            json!({"type":"user","isMeta":true,"message":{"content":"local metadata"}}),
            json!({"type":"assistant","isSidechain":true,"message":{"id":"worker","stop_reason":"end_turn","content":[{"type":"text","text":"Worker response"}]}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        assert_eq!(
            parse("claude", &log)["answer"]["text"],
            "First paragraph\n\nSecond paragraph"
        );
        assert_eq!(parse("claude", &log)["working"], false);
        // A new message makes that answer the previous one, until the next reply.
        let asked = format!(
            "{log}\n{}",
            json!({"type":"user","message":{"content":"And another thing"}})
        );
        assert_eq!(parse("claude", &asked)["answered"], false);
        assert_eq!(
            parse("claude", &asked)["answer"]["text"],
            "First paragraph\n\nSecond paragraph"
        );
        let replied = format!(
            "{asked}\n{}",
            json!({"type":"assistant","message":{"id":"three","stop_reason":"end_turn","content":[{"type":"text","text":"Done"}]}})
        );
        assert_eq!(parse("claude", &replied)["answered"], true);
        assert_eq!(parse("claude", &replied)["answer"]["text"], "Done");
    }
    fn log(rows: &[Value]) -> String {
        rows.iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
    }
    #[test]
    fn codex_progress_is_ordered_and_stops_at_turn_boundaries() {
        let rows = vec![
            json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"one"}}),
            json!({"type":"response_item","payload":{"type":"function_call","arguments":"do not speak tools"}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"analysis","content":[{"type":"output_text","text":"private"}]}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"I will check."}]}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"I will check."}}),
            json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Found the problem."}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":"one","last_agent_message":"Fixed."}}),
        ];
        let result = parse("codex", &log(&rows));
        assert_eq!(result["updates"].as_array().unwrap().len(), 2);
        assert_eq!(result["updates"][0]["text"], "I will check.");
        assert_eq!(result["updates"][1]["text"], "Found the problem.");
        assert_eq!(result["answer"]["text"], "Fixed.");
        let mut next = rows;
        next.push(json!({"type":"event_msg","payload":{"type":"task_started","turn_id":"two"}}));
        assert_eq!(parse("codex", &log(&next))["updates"], json!([]));
        next.push(json!({"type":"response_item","payload":{"role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"Next task."}]}}));
        next.push(json!({"type":"event_msg","payload":{"type":"turn_aborted"}}));
        assert_eq!(parse("codex", &log(&next))["updates"], json!([]));
    }
    #[test]
    fn claude_progress_excludes_tools_reasoning_and_workers() {
        let rows = vec![
            json!({"type":"user","uuid":"turn-one","message":{"content":"Request"}}),
            json!({"type":"assistant","uuid":"thinking","message":{"stop_reason":"tool_use","content":[{"type":"thinking","thinking":"private"}]}}),
            json!({"type":"assistant","uuid":"first","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Checking."},{"type":"tool_use","input":{"secret":"tool"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"private result"}]}}),
            json!({"type":"assistant","uuid":"worker","isSidechain":true,"message":{"stop_reason":"tool_use","content":[{"type":"text","text":"worker"}]}}),
            json!({"type":"assistant","uuid":"second","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Testing the fix."}]}}),
            json!({"type":"assistant","uuid":"incomplete","message":{"stop_reason":null,"content":[{"type":"text","text":"unfinished"}]}}),
            json!({"type":"assistant","message":{"id":"final","stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}),
        ];
        let result = parse("claude", &log(&rows));
        assert_eq!(result["updates"].as_array().unwrap().len(), 2);
        assert_eq!(result["updates"][0]["text"], "Checking.");
        assert_eq!(result["updates"][1]["text"], "Testing the fix.");
        assert_eq!(result["answer"]["text"], "Done.");
        let mut next = rows;
        next.push(json!({"type":"user","uuid":"turn-two","message":{"content":"Next"}}));
        assert_eq!(parse("claude", &log(&next))["updates"], json!([]));
    }
    #[test]
    fn appended_lines_are_read_incrementally_and_rewrites_start_over() {
        let dir = dictation::AudioDir::new().unwrap();
        let path = dir.0.join("session.jsonl");
        let rows = [
            json!({"type":"user","uuid":"turn","message":{"content":"Request"}}),
            json!({"type":"assistant","uuid":"a","message":{"stop_reason":"tool_use","content":[{"type":"text","text":"Checking."}]}}),
            json!({"type":"assistant","message":{"id":"final","stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}),
        ];
        let line = |row: &Value| format!("{row}\n");
        let full = |text: &str| identified(parse("claude", text), &path);
        fs::write(&path, line(&rows[0])).unwrap();
        assert_eq!(read_answer("claude", &path).unwrap()["working"], true);
        // A half-written line waits until it is complete.
        let partial = format!("{}{}", line(&rows[0]), &line(&rows[1])[..20]);
        fs::write(&path, &partial).unwrap();
        assert_eq!(read_answer("claude", &path).unwrap()["updates"], json!([]));
        let text: String = rows.iter().map(line).collect();
        fs::write(&path, &text).unwrap();
        let offset = READS.lock().unwrap()[&path].offset;
        assert_eq!(offset, line(&rows[0]).len() as u64);
        assert_eq!(read_answer("claude", &path).unwrap(), full(&text));
        assert_eq!(READS.lock().unwrap()[&path].offset, text.len() as u64);
        // A rewritten log of a different shape is read again from its start.
        let rewritten = line(&json!({"type":"user","uuid":"other","message":{"content":"New"}}));
        fs::write(&path, &rewritten).unwrap();
        assert_eq!(read_answer("claude", &path).unwrap(), full(&rewritten));
        READS.lock().unwrap().remove(&path);
    }
    #[test]
    fn background_tasks_run_until_their_notification_and_quotes_do_not_count() {
        let start = |tool: &str, id: &str, at: &str| {
            [
                json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":tool,"name":"Bash","input":{"command":"npm test","description":"Run the tests\nsecond line","run_in_background":true}}]}}),
                json!({"type":"user","timestamp":at,"toolUseResult":{"backgroundTaskId":id},"message":{"content":[{"type":"tool_result","tool_use_id":tool,"content":"Command running in background with ID: x"}]}}),
            ]
        };
        let notify = |id: &str| {
            format!("<task-notification> <task-id>{id}</task-id> <status>completed</status>")
        };
        let mut rows: Vec<Value> = start("t1", "aaa", "2026-10-05T10:00:00Z").into();
        rows.extend(start("t2", "bbb", "2026-10-05T10:01:00Z"));
        let result = parse("claude", &log(&rows));
        assert_eq!(result["background"].as_array().unwrap().len(), 2);
        assert_eq!(result["background"][0]["description"], "Run the tests");
        // Output that merely quotes a notification is not one.
        rows.push(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t9","content":notify("aaa")}]}}));
        rows.push(json!({"type":"assistant","message":{"content":[{"type":"text","text":notify("aaa")}]}}));
        assert_eq!(
            parse("claude", &log(&rows))["background"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        // Claude Code's queued notification ends the task, as does a kill.
        rows.push(json!({"type":"queue-operation","operation":"enqueue","content":notify("aaa")}));
        let left = parse("claude", &log(&rows))["background"].clone();
        assert_eq!(left.as_array().unwrap().len(), 1);
        assert_eq!(left[0]["id"], "bbb");
        rows.push(json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"k","name":"KillShell","input":{"shell_id":"bbb"}}]}}));
        assert_eq!(parse("claude", &log(&rows))["background"], json!([]));
    }

    #[test]
    fn monitors_run_through_their_events_and_background_agents_count() {
        let rows = vec![
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"m","name":"Monitor","input":{"command":"watch.sh","description":"Watch the render jobs"}}]}}),
            json!({"type":"user","timestamp":"2026-10-05T10:00:00Z","toolUseResult":{"taskId":"mon","timeoutMs":1800000},"message":{"content":[{"type":"tool_result","tool_use_id":"m","content":"Monitor started"}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"g","name":"Agent","input":{"description":"Render the excerpt","prompt":"...","run_in_background":true}}]}}),
            json!({"type":"user","timestamp":"2026-10-05T10:01:00Z","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"agent1"},"message":{"content":[{"type":"tool_result","tool_use_id":"g","content":"launched"}]}}),
            // A tool result that merely has a taskId, from no Monitor, is not a background task.
            json!({"type":"user","toolUseResult":{"taskId":"todo"},"message":{"content":[{"type":"tool_result","tool_use_id":"other","content":"ok"}]}}),
        ];
        let names = |rows: &[Value]| -> Vec<String> {
            parse("claude", &log(rows))["background"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["description"].as_str().unwrap().to_owned())
                .collect()
        };
        assert_eq!(
            names(&rows),
            ["Watch the render jobs", "Render the excerpt"]
        );
        let queued =
            |text: &str| json!({"type":"queue-operation","operation":"enqueue","content":text});
        let mut rows = rows;
        // A Monitor event keeps it running; expiry ends it.
        rows.push(queued("<task-notification> <task-id>mon</task-id> <summary>Monitor event: \"jobs\"</summary> <event>job 3 done</event> </task-notification>"));
        assert_eq!(names(&rows).len(), 2);
        rows.push(queued("<task-notification> <task-id>mon</task-id> <summary>Monitor event</summary> <event>[Monitor expired after 30m with no events delivered.]</event>"));
        assert_eq!(names(&rows), ["Render the excerpt"]);
        // One notification can stop several tasks.
        rows.push(queued("<task-notification> <task-id>agent1</task-id> <task-id>other</task-id> <status>stopped</status>"));
        assert!(names(&rows).is_empty());
    }

    #[test]
    fn tasks_from_an_earlier_process_are_dropped() {
        assert_eq!(epoch("1970-01-01T00:00:00Z"), Some(0.0));
        assert_eq!(epoch("2023-10-03T12:00:00Z"), Some(1_696_334_400.0));
        assert_eq!(epoch("2000-02-29T00:00:01.5Z"), Some(951_782_401.5));
        assert_eq!(epoch("not a time"), None);
        let tasks = json!([
            {"id":"old","description":"Before a restart","started":"2026-10-05T09:00:00Z"},
            {"id":"new","description":"Still running","started":"2026-10-05T10:00:00Z"},
        ]);
        let restarted = epoch("2026-10-05T09:30:00Z");
        let current = current_tasks(&tasks, restarted);
        assert_eq!(current.len(), 1);
        assert_eq!(current[0]["description"], "Still running");
        assert_eq!(current_tasks(&tasks, None).len(), 2);
    }

    #[test]
    fn speech_ids_accept_only_current_progress_or_completed_answer() {
        let mut value = json!({"answer":{"key":"final","text":"Done"},"updates":[{"key":"update:one","text":"Checking"}]});
        identify(&mut value["answer"], "session");
        identify(&mut value["updates"][0], "session");
        let id = value["updates"][0]["id"].as_str().unwrap().to_owned();
        assert_eq!(speech_message(&value, &id).unwrap()["text"], "Checking");
        assert!(speech_message(&value, "arbitrary text").is_none());
        let mut other = value["updates"][0].clone();
        identify(&mut other, "other-session");
        assert_ne!(other["id"], id);
        value["updates"] = json!([]);
        assert!(speech_message(&value, &id).is_none());
    }
    #[test]
    fn spoken_prose_keeps_paragraphs_and_omits_code() {
        assert_eq!(
            spoken(
                "## Result\n\n**Done** [details](https://example.test)\n```rust\nsecret code\n```\nNext paragraph."
            ),
            "Result\n\nDone details\nCode block omitted.\nNext paragraph."
        );
    }
    #[test]
    fn daemon_codex_resolves_exact_named_thread_without_an_open_rollout() {
        let dir = dictation::AudioDir::new().unwrap();
        let base = dir.0.join("sessions");
        fs::create_dir(&base).unwrap();
        let cwd = dir.0.join("project");
        let id = uuid::Uuid::new_v4().to_string();
        let path = base.join(format!("rollout-{id}.jsonl"));
        fs::write(
            &path,
            json!({"type":"session_meta","payload":{"id":id,"source":"cli"}}).to_string(),
        )
        .unwrap();
        let db = rusqlite::Connection::open(dir.0.join("state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads(id TEXT, rollout_path TEXT, cwd TEXT, name TEXT, title TEXT, source TEXT, archived INTEGER)").unwrap();
        db.execute("INSERT INTO threads VALUES (?1, ?2, ?3, 'My conversation', 'Original prompt', 'cli', 0)",
            rusqlite::params![id, path.to_string_lossy(), cwd.to_string_lossy()]).unwrap();
        assert_eq!(
            codex_named_session(&base, &cwd, "My conversation | project").unwrap(),
            path
        );
        assert_eq!(
            codex_named_session(&base, &cwd, "My conversation").unwrap(),
            path
        );
        assert!(codex_named_session(&base, &cwd, "Some other conversation | project").is_err());
        assert!(codex_named_session(&base, &dir.0.join("other"), "My conversation").is_err());
        // A worker or a newer thread in the same folder is never a recency fallback.
        db.execute("UPDATE threads SET source = 'subagent'", [])
            .unwrap();
        assert!(codex_named_session(&base, &cwd, "My conversation").is_err());
        db.execute("UPDATE threads SET source = 'exec'", [])
            .unwrap();
        assert!(codex_named_session(&base, &cwd, "My conversation").is_err());
        // A conversation resumed through the Codex daemon is recorded as `vscode`.
        db.execute("UPDATE threads SET source = 'vscode'", [])
            .unwrap();
        fs::write(
            &path,
            json!({"type":"session_meta","payload":{"id":id,"source":"vscode"}}).to_string(),
        )
        .unwrap();
        assert_eq!(
            codex_named_session(&base, &cwd, "My conversation | project").unwrap(),
            path
        );
        // An unnamed conversation is titled with its folder: the folder's only unnamed one is it.
        db.execute("UPDATE threads SET name = '', title = ''", [])
            .unwrap();
        assert_eq!(codex_named_session(&base, &cwd, "project").unwrap(), path);
        assert!(codex_named_session(&base, &cwd, "My conversation").is_err());
        db.execute(
            "UPDATE threads SET name = 'My conversation', title = 'Original prompt'",
            [],
        )
        .unwrap();
        assert!(codex_named_session(&base, &cwd, "project").is_err());
        db.execute("UPDATE threads SET source = 'cli'", []).unwrap();
        db.execute("INSERT INTO threads SELECT * FROM threads", [])
            .unwrap();
        assert!(codex_named_session(&base, &cwd, "My conversation").is_err());
        db.execute("DELETE FROM threads WHERE rowid = 2", [])
            .unwrap();
        db.execute(
            "UPDATE threads SET rollout_path = ?1",
            [dir.0.join("outside.jsonl").to_string_lossy()],
        )
        .unwrap();
        assert!(codex_named_session(&base, &cwd, "My conversation").is_err());
        db.execute(
            "UPDATE threads SET rollout_path = ?1",
            [path.to_string_lossy()],
        )
        .unwrap();
        fs::write(
            &path,
            json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4().to_string(),"source":"cli"}})
                .to_string(),
        )
        .unwrap();
        assert!(codex_named_session(&base, &cwd, "My conversation").is_err());
    }
    #[test]
    fn resolver_rejects_paths_and_ambiguous_logs() {
        let dir = dictation::AudioDir::new().unwrap();
        assert!(find_session(&dir.0, "../../outside").is_err());
        let id = uuid::Uuid::new_v4().to_string();
        assert!(find_session(&dir.0, &id).is_err());
        fs::write(dir.0.join(format!("{id}.jsonl")), "").unwrap();
        assert!(find_session(&dir.0, &id).is_ok());
        fs::write(dir.0.join(format!("rollout-{id}.jsonl")), "").unwrap();
        assert!(find_session(&dir.0, &id).is_err());
    }
}
