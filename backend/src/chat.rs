//! Chat: conversations with a local Claude Code agent, outside any project. Each conversation is a
//! folder in `~/Chats` holding `chat.md`, the app's own readable record (easy to back up with git),
//! and the agent runs in that folder, so files it makes stay with the conversation and the folder
//! can later become a project. Claude's session log is only used to resume.
use crate::{ApiError, App, apps, error};
use axum::{
    Json,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path as FsPath, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::broadcast,
};

const MAX_TEXT: usize = 64 * 1024;
/// A conversation's agent process exits after this long without a message.
const IDLE: Duration = Duration::from_secs(15 * 60);
const MARK: &str = "<!-- omarchy-chat:";

#[derive(Clone, Debug, Default, PartialEq)]
struct Entry {
    /// `user`, `assistant`, or `tool`.
    role: String,
    time: String,
    /// The tool's name; empty for messages.
    name: String,
    text: String,
    /// Files sent with a message, relative to the chat's folder, such as `attachments/photo.jpg`.
    attachments: Vec<String>,
}
impl Entry {
    fn new(role: &str, name: &str, text: &str) -> Self {
        Self {
            role: role.into(),
            time: now(),
            name: name.into(),
            text: text.into(),
            attachments: Vec::new(),
        }
    }
    fn json(&self) -> Value {
        json!({"role":self.role,"time":self.time,"name":self.name,"text":self.text,"attachments":self.attachments})
    }
}
/// An attachment written as a Markdown link (an image for pictures), so `chat.md` shows it.
fn attachment_link(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"]
        .iter()
        .any(|x| name.to_ascii_lowercase().ends_with(x));
    format!("{}[{name}](<{path}>)", if image { "!" } else { "" })
}
/// The attachment a line written by `attachment_link` names.
fn attachment_path(line: &str) -> Option<&str> {
    let rest = line.strip_prefix('!').unwrap_or(line).strip_prefix('[')?;
    let (_, target) = rest.split_once("](<")?;
    let path = target.strip_suffix(">)")?;
    (path.starts_with("attachments/") && !path.contains(['>', '\n'])).then_some(path)
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Conversation {
    id: String,
    agent: String,
    /// The agent's own session id, for resuming.
    session: String,
    /// Model alias and effort level for this chat; empty uses Claude's own setting.
    model: String,
    effort: String,
    title: String,
    created: String,
    updated: String,
    entries: Vec<Entry>,
}
impl Conversation {
    fn preview(&self) -> String {
        let last = self.entries.iter().rev().find(|e| e.role != "tool");
        let attached = last
            .filter(|e| e.text.is_empty())
            .and_then(|e| e.attachments.first())
            .map(|path| format!("📎 {}", path.rsplit('/').next().unwrap_or(path)));
        let text = attached
            .as_deref()
            .or(last.map(|e| e.text.as_str()))
            .unwrap_or_default();
        clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 160)
    }
    fn summary(&self) -> Value {
        json!({"id":self.id,"agent":self.agent,"model":self.model,"effort":self.effort,"title":self.title,"created":self.created,"updated":self.updated,"preview":self.preview()})
    }
    fn json(&self) -> Value {
        let mut value = self.summary();
        value["entries"] = self.entries.iter().map(Entry::json).collect();
        value
    }
    fn label(&self, role: &str) -> &'static str {
        match (role, self.agent.as_str()) {
            ("user", _) => "**You**",
            (_, "codex") => "**Codex**",
            _ => "**Claude**",
        }
    }
    /// Front matter (JSON strings are valid YAML) and one marked section per entry. The markers
    /// are HTML comments, so a rendered file reads as a plain conversation.
    fn to_markdown(&self) -> String {
        let mut out = String::from("---\n");
        for (key, value) in [
            ("id", &self.id),
            ("agent", &self.agent),
            ("session", &self.session),
            ("model", &self.model),
            ("effort", &self.effort),
            ("title", &self.title),
            ("created", &self.created),
            ("updated", &self.updated),
            ("preview", &self.preview()),
        ] {
            out.push_str(&format!("{key}: {}\n", json!(value)));
        }
        out.push_str("---\n");
        for entry in &self.entries {
            out.push('\n');
            if entry.role == "tool" {
                let name: String = entry
                    .name
                    .chars()
                    .map(|c| if c.is_whitespace() { '_' } else { c })
                    .collect();
                let summary = entry.text.split_whitespace().collect::<Vec<_>>().join(" ");
                out.push_str(&format!(
                    "{MARK}tool {} {name} -->\n> {summary}\n",
                    entry.time
                ));
                continue;
            }
            out.push_str(&format!(
                "{MARK}{} {} -->\n{}\n\n",
                entry.role,
                entry.time,
                self.label(&entry.role)
            ));
            for line in entry.text.lines() {
                // A line that looks like a marker gains one leading space; reading removes it.
                if line.trim_start().starts_with(MARK) {
                    out.push(' ');
                }
                out.push_str(line);
                out.push('\n');
            }
            if !entry.attachments.is_empty() {
                if !entry.text.is_empty() {
                    out.push('\n');
                }
                for path in &entry.attachments {
                    out.push_str(&attachment_link(path));
                    out.push('\n');
                }
            }
        }
        out
    }
    fn parse(text: &str) -> Option<Self> {
        let (fields, body) = front_matter(text)?;
        let field = |key: &str| fields.get(key).cloned().unwrap_or_default();
        let mut conversation = Self {
            id: field("id"),
            agent: field("agent"),
            session: field("session"),
            model: field("model"),
            effort: field("effort"),
            title: field("title"),
            created: field("created"),
            updated: field("updated"),
            entries: Vec::new(),
        };
        let mut current: Option<(Entry, Vec<&str>)> = None;
        let finish = |current: Option<(Entry, Vec<&str>)>, entries: &mut Vec<Entry>| {
            let Some((mut entry, mut lines)) = current else {
                return;
            };
            if entry.role == "tool" {
                entry.text = lines
                    .first()
                    .map(|l| l.strip_prefix("> ").unwrap_or(l).to_owned())
                    .unwrap_or_default();
            } else {
                if lines
                    .first()
                    .is_some_and(|l| ["**You**", "**Claude**", "**Codex**"].contains(l))
                {
                    lines.remove(0);
                    if lines.first() == Some(&"") {
                        lines.remove(0);
                    }
                }
                while lines.last() == Some(&"") {
                    lines.pop();
                }
                // A message's attachments are the links that end it.
                while let Some(path) = lines.last().and_then(|l| attachment_path(l)) {
                    entry.attachments.insert(0, path.to_owned());
                    lines.pop();
                }
                while lines.last() == Some(&"") {
                    lines.pop();
                }
                entry.text = lines
                    .iter()
                    .map(|l| {
                        if l.starts_with(' ') && l.trim_start().starts_with(MARK) {
                            &l[1..]
                        } else {
                            l
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
            }
            entries.push(entry);
        };
        for line in body.lines() {
            if let Some(marker) = line.strip_prefix(MARK).and_then(|m| m.strip_suffix(" -->")) {
                finish(current.take(), &mut conversation.entries);
                let mut parts = marker.splitn(3, ' ');
                let role = parts.next().unwrap_or_default();
                let time = parts.next().unwrap_or_default();
                let name = parts.next().unwrap_or_default();
                if ["user", "assistant", "tool"].contains(&role) {
                    current = Some((
                        Entry {
                            role: role.into(),
                            time: time.into(),
                            name: name.into(),
                            text: String::new(),
                            attachments: Vec::new(),
                        },
                        Vec::new(),
                    ));
                }
                continue;
            }
            if let Some((_, lines)) = current.as_mut() {
                lines.push(line);
            }
        }
        finish(current, &mut conversation.entries);
        uuid::Uuid::parse_str(&conversation.id).ok()?;
        Some(conversation)
    }
}
fn front_matter(text: &str) -> Option<(HashMap<String, String>, &str)> {
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    let mut fields = HashMap::new();
    for line in rest[..end].lines() {
        let (key, value) = line.split_once(": ")?;
        fields.insert(key.to_owned(), serde_json::from_str::<String>(value).ok()?);
    }
    Some((fields, &rest[end + 5..]))
}
fn clip(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let mut clipped: String = text.chars().take(limit - 1).collect();
    clipped.push('…');
    clipped
}
fn title(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("New chat");
    clip(&line.split_whitespace().collect::<Vec<_>>().join(" "), 60)
}
fn slug(title: &str) -> String {
    let words: Vec<String> = title
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .take(6)
        .map(str::to_ascii_lowercase)
        .collect();
    let slug = clip(&words.join("-"), 40).trim_end_matches('…').to_owned();
    if slug.is_empty() { "chat".into() } else { slug }
}
fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    timestamp(seconds)
}
/// RFC 3339 UTC, from days since 1970 (Howard Hinnant's civil-from-days).
fn timestamp(seconds: i64) -> String {
    let (days, rest) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

fn tilde(path: &FsPath) -> String {
    match apps::home()
        .ok()
        .and_then(|home| path.strip_prefix(home).ok().map(PathBuf::from))
    {
        Some(rest) => format!("~/{}", rest.display()),
        None => path.display().to_string(),
    }
}
const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_EFFORTS: [&str; 4] = ["low", "medium", "high", "xhigh"];
/// The agents a chat can run, as `(id, label, command)`: Claude Code; Claude X, Claude Code
/// through a local proxy to other accounts (`claudex`, where installed); and Codex. Only those
/// whose command is on the host are offered.
const AGENTS: [(&str, &str, &str); 3] = [
    ("claude", "Claude", "claude"),
    ("claudex", "Claude X", "claudex"),
    ("codex", "Codex", "codex"),
];
fn installed() -> Vec<(&'static str, &'static str, &'static str)> {
    AGENTS
        .into_iter()
        .filter(|(_, _, command)| apps::resolve_program(command).is_ok())
        .collect()
}
/// A chat's agent; chats saved before there was a choice ran Claude.
fn agent_of(conversation: &Conversation) -> &str {
    if conversation.agent.is_empty() {
        "claude"
    } else {
        &conversation.agent
    }
}
/// Claude and Claude X are the same program with the same sessions, so a chat moves between them.
fn claude_family(agent: &str) -> bool {
    agent == "claude" || agent == "claudex"
}
fn agent_models(agent: &str) -> Vec<(String, String)> {
    if claude_family(agent) {
        return models();
    }
    // Codex runs its configured model unless the backend offers choices.
    std::env::var("OMARCHY_CHAT_CODEX_MODELS")
        .ok()
        .and_then(|list| serde_json::from_str(&list).ok())
        .unwrap_or_default()
}
fn agent_efforts(agent: &str) -> &'static [&'static str] {
    if claude_family(agent) {
        &EFFORTS
    } else {
        &CODEX_EFFORTS
    }
}
/// The models offered, as `[alias, label]` pairs; `OMARCHY_CHAT_MODELS` replaces the list.
fn models() -> Vec<(String, String)> {
    std::env::var("OMARCHY_CHAT_MODELS")
        .ok()
        .and_then(|list| serde_json::from_str(&list).ok())
        .unwrap_or_else(|| {
            [
                ("fable", "Fable"),
                ("opus", "Opus"),
                ("sonnet", "Sonnet"),
                ("haiku", "Haiku"),
            ]
            .map(|(id, label)| (id.to_owned(), label.to_owned()))
            .into()
        })
}
/// Only offered models and effort levels reach an agent's command line; empty means its default.
fn valid_settings(agent: &str, model: &str, effort: &str) -> bool {
    (model.is_empty() || agent_models(agent).iter().any(|(id, _)| id == model))
        && (effort.is_empty() || agent_efforts(agent).contains(&effort))
}
/// Claude's own default model and effort, from its user settings.
/// What a chat left on Default runs with: `OMARCHY_CHAT_DEFAULT_MODEL` and
/// `OMARCHY_CHAT_DEFAULT_EFFORT` when set to offered values, otherwise Claude's own settings.
fn defaults() -> (String, String) {
    let (model, effort) = configured();
    let settings: Value = claude_config()
        .ok()
        .and_then(|config| fs::read(config.join("settings.json")).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let text = |key: &str| settings[key].as_str().unwrap_or_default().to_owned();
    (
        if model.is_empty() {
            text("model")
        } else {
            model
        },
        if effort.is_empty() {
            text("effortLevel")
        } else {
            effort
        },
    )
}
/// Chat's own defaults from the backend environment; empty leaves the choice to Claude.
fn configured() -> (String, String) {
    let read = |key: &str| std::env::var(key).unwrap_or_default().trim().to_owned();
    let (model, effort) = (
        read("OMARCHY_CHAT_DEFAULT_MODEL"),
        read("OMARCHY_CHAT_DEFAULT_EFFORT"),
    );
    (
        if valid_settings("claude", &model, "") {
            model
        } else {
            String::new()
        },
        if valid_settings("claude", "", &effort) {
            effort
        } else {
            String::new()
        },
    )
}
/// The `--model` and `--effort` a chat runs with: its own choice, or Chat's configured default.
fn effective(model: &str, effort: &str, configured: &(String, String)) -> (String, String) {
    let pick = |own: &str, fallback: &str| {
        if own.is_empty() {
            fallback.to_owned()
        } else {
            own.to_owned()
        }
    };
    (pick(model, &configured.0), pick(effort, &configured.1))
}
/// `~/Chats`, or `OMARCHY_CHAT_DIR` inside the home directory.
fn root() -> anyhow::Result<PathBuf> {
    let home = apps::home()?;
    let root = match std::env::var_os("OMARCHY_CHAT_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => home.join("Chats"),
    };
    anyhow::ensure!(
        root.is_absolute() && root.starts_with(&home) && root != home,
        "OMARCHY_CHAT_DIR must be a folder inside the home directory"
    );
    Ok(root)
}
/// A chat folder's conversation file.
const FILE: &str = "chat.md";
/// Creates `~/Chats` privately and converts chats saved before conversations had folders.
fn prepare(root: &FsPath) -> anyhow::Result<()> {
    private_dir(root)?;
    if let Ok(config) = claude_config() {
        migrate(&config, root);
    }
    Ok(())
}
fn private_dir(path: &FsPath) -> anyhow::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    Ok(())
}
/// A new folder named `name` inside `parent`, numbered if the name is taken.
fn new_dir(parent: &FsPath, name: &str) -> anyhow::Result<PathBuf> {
    private_dir(parent)?;
    let mut dir = parent.join(name);
    let mut copy = 2;
    while fs::symlink_metadata(&dir).is_ok() {
        dir = parent.join(format!("{name}-{copy}"));
        copy += 1;
    }
    fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(dir)
}
/// The chat folders directly inside `parent` (never `archives`), with their conversation files.
fn chat_files(parent: &FsPath) -> Vec<PathBuf> {
    fs::read_dir(parent)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name() != "archives")
        .map(|e| e.path().join(FILE))
        .filter(|path| path.is_file())
        .collect()
}
fn find(root: &FsPath, id: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(uuid::Uuid::parse_str(id).is_ok(), "Invalid chat");
    let suffix = format!("-{}", &id[..8]);
    chat_files(root)
        .into_iter()
        .find(|path| {
            path.parent()
                .and_then(FsPath::file_name)
                .is_some_and(|name| name.to_string_lossy().contains(&suffix))
                && head(path)
                    .is_some_and(|(fields, _)| fields.get("id").map(String::as_str) == Some(id))
        })
        .ok_or_else(|| anyhow::anyhow!("Chat not found"))
}
/// The front matter of a conversation file, read without the rest of it.
fn head(path: &FsPath) -> Option<(HashMap<String, String>, ())> {
    use std::io::Read;
    let mut bytes = Vec::new();
    fs::File::open(path)
        .ok()?
        .take(16 * 1024)
        .read_to_end(&mut bytes)
        .ok()?;
    let text = String::from_utf8_lossy(&bytes);
    front_matter(&text).map(|(fields, _)| (fields, ()))
}
fn load(path: &FsPath) -> anyhow::Result<Conversation> {
    Conversation::parse(&fs::read_to_string(path)?)
        .ok_or_else(|| anyhow::anyhow!("Unreadable chat file {}", path.display()))
}
/// Writes the whole file to a private temporary file, then renames it over the old one.
fn save(conversation: &Conversation, path: &FsPath) -> anyhow::Result<()> {
    let temporary = path.with_extension("md.tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(conversation.to_markdown().as_bytes())?;
    file.sync_all()?;
    fs::rename(temporary, path)?;
    Ok(())
}
fn list(root: &FsPath) -> Vec<Value> {
    let mut chats: Vec<Value> = chat_files(root)
        .into_iter()
        .filter_map(|path| {
            let (fields, _) = head(&path)?;
            uuid::Uuid::parse_str(fields.get("id")?).ok()?;
            let mut chat = json!(fields);
            chat["folder"] = json!(path.parent()?.to_string_lossy());
            Some(chat)
        })
        .collect();
    chats.sort_by(|a, b| b["updated"].as_str().cmp(&a["updated"].as_str()));
    chats
}

/// The state of a conversation whose agent is running.
struct Live {
    conversation: Conversation,
    path: PathBuf,
    busy: bool,
    /// Text of the assistant message being streamed, and how many deltas it has had.
    partial: String,
    seq: u64,
    /// The API message the last assistant entry came from, so its later blocks join it.
    message: String,
    used: Instant,
    /// Stop was requested, so the agent's exit ends the turn without an error.
    stopping: bool,
    /// Archived or deleted: nothing the agent does afterwards is saved.
    removed: bool,
    /// The model and effort the running agent was started with.
    started: (String, String),
    /// The last error Codex reported in this turn, for when the turn fails.
    failure: Option<String>,
}
impl Live {
    /// Applies one line of the agent's JSON output; returns the events to broadcast.
    fn apply(&mut self, line: &Value) -> Vec<Value> {
        if agent_of(&self.conversation) == "codex" {
            return self.apply_codex(line);
        }
        let id = self.conversation.id.clone();
        let mut events = Vec::new();
        match line["type"].as_str().unwrap_or_default() {
            "stream_event" => {
                let event = &line["event"];
                if event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta"
                {
                    let text = event["delta"]["text"].as_str().unwrap_or_default();
                    self.partial.push_str(text);
                    self.seq += 1;
                    events.push(json!({"type":"delta","id":id,"seq":self.seq,"text":text}));
                }
            }
            "assistant" if line["parent_tool_use_id"].is_null() => {
                let message = line["message"]["id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                for block in line["message"]["content"].as_array().into_iter().flatten() {
                    let entry = match block["type"].as_str() {
                        Some("text") => {
                            let text = block["text"].as_str().unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            self.partial.clear();
                            let index = self.conversation.entries.len().saturating_sub(1);
                            let last = self.conversation.entries.last_mut();
                            if let Some(last) = last
                                && last.role == "assistant"
                                && !message.is_empty()
                                && message == self.message
                            {
                                last.text.push_str("\n\n");
                                last.text.push_str(text);
                                events.push(json!({"type":"entry","id":id,"index":index,"entry":last.json()}));
                                continue;
                            }
                            Entry::new("assistant", "", text)
                        }
                        Some("tool_use") => Entry::new(
                            "tool",
                            block["name"].as_str().unwrap_or("tool"),
                            &tool_summary(&block["input"]),
                        ),
                        _ => continue,
                    };
                    self.message = message.clone();
                    events.push(json!({"type":"entry","id":id,"index":self.conversation.entries.len(),"entry":entry.json()}));
                    self.conversation.entries.push(entry);
                }
            }
            "result" => {
                self.busy = false;
                self.partial.clear();
                let failed = line["is_error"] == true || line["subtype"] != "success";
                let message = line["result"]
                    .as_str()
                    .or_else(|| line["errors"][0].as_str())
                    .unwrap_or("The agent stopped with an error");
                events.push(json!({"type":"done","id":id,"error":if failed {json!(message)} else {Value::Null}}));
            }
            _ => {}
        }
        if events.iter().any(|e| e["type"] != "delta") {
            self.conversation.updated = now();
        }
        events
    }
}
impl Live {
    /// Applies one event of `codex exec --json`: its session's id, the agent's messages and tool
    /// calls (commands, edits, searches), and the end of the turn.
    fn apply_codex(&mut self, line: &Value) -> Vec<Value> {
        let id = self.conversation.id.clone();
        let item = &line["item"];
        let mut entry = None;
        let mut events = Vec::new();
        match (
            line["type"].as_str().unwrap_or_default(),
            item["type"].as_str(),
        ) {
            ("thread.started", _) => {
                if let Some(thread) = line["thread_id"].as_str()
                    && self.conversation.session != thread
                {
                    self.conversation.session = thread.to_owned();
                    events.push(json!({"type":"session","id":id}));
                }
            }
            ("item.started", Some("command_execution")) => {
                entry = Some(Entry::new(
                    "tool",
                    "Shell",
                    &codex_command(item["command"].as_str().unwrap_or_default()),
                ));
            }
            ("item.completed", Some("agent_message")) => {
                let text = item["text"].as_str().unwrap_or_default().trim();
                if !text.is_empty() {
                    entry = Some(Entry::new("assistant", "", text));
                }
            }
            ("item.completed", Some("file_change")) => {
                let files: Vec<&str> = item["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c["path"].as_str())
                    .map(|p| p.rsplit('/').next().unwrap_or(p))
                    .collect();
                entry = Some(Entry::new("tool", "Edit", &files.join(", ")));
            }
            ("item.completed", Some("web_search")) => {
                entry = Some(Entry::new(
                    "tool",
                    "WebSearch",
                    item["query"].as_str().unwrap_or_default(),
                ));
            }
            ("item.completed", Some("mcp_tool_call")) => {
                let name = item["tool"].as_str().unwrap_or("tool");
                entry = Some(Entry::new(
                    "tool",
                    name,
                    item["server"].as_str().unwrap_or_default(),
                ));
            }
            ("error", _) => {
                self.failure = line["message"].as_str().map(str::to_owned);
            }
            ("turn.completed", _) | ("turn.failed", _) => {
                self.busy = false;
                let failed = line["type"] == "turn.failed";
                let message = line["error"]["message"]
                    .as_str()
                    .map(str::to_owned)
                    .or(self.failure.take())
                    .unwrap_or_else(|| "Codex stopped with an error".into());
                events.push(json!({"type":"done","id":id,"error":if failed {json!(message)} else {Value::Null}}));
            }
            _ => {}
        }
        if let Some(entry) = entry {
            events.push(json!({"type":"entry","id":id,"index":self.conversation.entries.len(),"entry":entry.json()}));
            self.conversation.entries.push(entry);
        }
        if !events.is_empty() {
            self.conversation.updated = now();
        }
        events
    }
}
/// A Codex command as typed: Codex runs each through `bash -lc '…'`.
fn codex_command(command: &str) -> String {
    let wrapped = regex::Regex::new(r"^\S*bash -lc '(.*)'$").unwrap();
    wrapped
        .captures(command.trim())
        .map(|c| c[1].replace("'\\''", "'"))
        .unwrap_or_else(|| command.trim().to_owned())
}
fn tool_summary(input: &Value) -> String {
    let text = [
        "description",
        "command",
        "query",
        "url",
        "file_path",
        "pattern",
        "prompt",
        "path",
    ]
    .iter()
    .find_map(|key| input[*key].as_str())
    .unwrap_or_default();
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), 200)
}

struct Running {
    /// Claude takes each message on its input; a Codex run closes it once it has the prompt.
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    child: tokio::sync::Mutex<Child>,
    live: Mutex<Live>,
}

#[derive(Clone)]
pub struct Chats {
    running: Arc<Mutex<HashMap<String, Arc<Running>>>>,
    events: broadcast::Sender<Value>,
    /// Numbers every event. A chat read reports the number its state includes, so a client
    /// applies only the events after it.
    counter: Arc<AtomicU64>,
}
pub fn start() -> Chats {
    let chats = Chats {
        running: Arc::new(Mutex::new(HashMap::new())),
        events: broadcast::channel(1024).0,
        counter: Arc::new(AtomicU64::new(0)),
    };
    let reaper = chats.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let idle: Vec<Arc<Running>> = reaper
                .running
                .lock()
                .unwrap()
                .values()
                .filter(|r| {
                    let live = r.live.lock().unwrap();
                    !live.busy && live.used.elapsed() > IDLE
                })
                .cloned()
                .collect();
            for running in idle {
                let _ = running.child.lock().await.start_kill();
            }
        }
    });
    chats
}
impl Chats {
    /// Numbers events while the conversation they change is still locked.
    fn stamp(&self, events: &mut [Value]) {
        for event in events {
            event["n"] = json!(self.counter.fetch_add(1, Ordering::SeqCst) + 1);
        }
    }
    fn emit(&self, events: Vec<Value>) {
        for event in events {
            let _ = self.events.send(event);
        }
    }
    fn get(&self, id: &str) -> Option<Arc<Running>> {
        self.running.lock().unwrap().get(id).cloned()
    }
    /// Starts the agent for a conversation: a new session, or a resumed one.
    fn spawn(&self, live: Live, resume: bool, root: &FsPath) -> anyhow::Result<Arc<Running>> {
        let mut args: Vec<String> = [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            // Nobody answers approval prompts yet: anything that would ask is denied, except
            // web search and fetching pages, which a chat needs and which change nothing here.
            "--permission-prompts",
            "none",
            "--allowedTools",
            "WebSearch,WebFetch",
        ]
        .map(String::from)
        .into();
        if let Ok(extra) = std::env::var("OMARCHY_CHAT_CLAUDE_ARGS") {
            args.extend(serde_json::from_str::<Vec<String>>(&extra)?);
        }
        let (model, effort) = (
            live.conversation.model.clone(),
            live.conversation.effort.clone(),
        );
        anyhow::ensure!(
            valid_settings(agent_of(&live.conversation), &model, &effort),
            "Unsupported model or effort"
        );
        // `started` keeps the chat's own choice, so Default never looks like a change.
        let (flag_model, flag_effort) = effective(&model, &effort, &configured());
        if !flag_model.is_empty() {
            args.extend(["--model".into(), flag_model]);
        }
        if !flag_effort.is_empty() {
            args.extend(["--effort".into(), flag_effort]);
        }
        let mut live = live;
        live.started = (model, effort);
        args.push(if resume { "--resume" } else { "--session-id" }.into());
        args.push(live.conversation.session.clone());
        let command = AGENTS
            .iter()
            .find(|(id, _, _)| *id == agent_of(&live.conversation))
            .map_or("claude", |(_, _, command)| *command);
        let mut child = Command::new(apps::resolve_program(command)?)
            .args(&args)
            .current_dir(live.path.parent().unwrap_or(root))
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let id = live.conversation.id.clone();
        let running = Arc::new(Running {
            stdin: tokio::sync::Mutex::new(child.stdin.take()),
            child: tokio::sync::Mutex::new(child),
            live: Mutex::new(live),
        });
        self.running
            .lock()
            .unwrap()
            .insert(id.clone(), running.clone());
        self.read(running.clone(), stdout, stderr);
        Ok(running)
    }
    /// Runs one Codex turn in the chat's folder: `codex exec --json`, resuming the chat's
    /// session once it has one, with the prompt on its input and pictures attached.
    fn spawn_codex(
        &self,
        mut live: Live,
        prompt: &str,
        images: &[PathBuf],
        root: &FsPath,
    ) -> anyhow::Result<Arc<Running>> {
        let mut args: Vec<String> = ["exec", "--json", "--skip-git-repo-check"]
            .map(String::from)
            .into();
        if let Ok(extra) = std::env::var("OMARCHY_CHAT_CODEX_ARGS") {
            args.extend(serde_json::from_str::<Vec<String>>(&extra)?);
        }
        let (model, effort) = (
            live.conversation.model.clone(),
            live.conversation.effort.clone(),
        );
        anyhow::ensure!(
            valid_settings("codex", &model, &effort),
            "Unsupported model or effort"
        );
        if !model.is_empty() {
            args.extend(["--model".into(), model.clone()]);
        }
        if !effort.is_empty() {
            args.extend([
                "--config".into(),
                format!("model_reasoning_effort=\"{effort}\""),
            ]);
        }
        for image in images {
            args.extend(["--image".into(), image.to_string_lossy().into_owned()]);
        }
        if !live.conversation.session.is_empty() {
            args.extend(["resume".into(), live.conversation.session.clone()]);
        }
        args.push("-".into());
        live.started = (model, effort);
        let mut child = Command::new(apps::resolve_program("codex")?)
            .args(&args)
            .current_dir(live.path.parent().unwrap_or(root))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()?;
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let mut stdin = child.stdin.take().unwrap();
        let id = live.conversation.id.clone();
        let running = Arc::new(Running {
            stdin: tokio::sync::Mutex::new(None),
            child: tokio::sync::Mutex::new(child),
            live: Mutex::new(live),
        });
        self.running.lock().unwrap().insert(id, running.clone());
        let prompt = prompt.to_owned();
        tokio::spawn(async move {
            // Closing the input tells Codex the prompt is complete.
            let _ = stdin.write_all(prompt.as_bytes()).await;
        });
        self.read(running.clone(), stdout, stderr);
        Ok(running)
    }
    /// Follows an agent's output until it exits: each event is applied, saved, and broadcast.
    fn read(
        &self,
        running: Arc<Running>,
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
    ) {
        let chats = self.clone();
        let reader = running;
        let id = reader.live.lock().unwrap().conversation.id.clone();
        tokio::spawn(async move {
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
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let events = {
                    let mut live = reader.live.lock().unwrap();
                    let mut events = live.apply(&value);
                    chats.stamp(&mut events);
                    if events.iter().any(|e| e["type"] != "delta")
                        && !live.removed
                        && let Err(e) = save(&live.conversation, &live.path)
                    {
                        eprintln!("chat: could not save {}: {e}", live.path.display());
                    }
                    events
                };
                chats.emit(events);
            }
            let _ = reader.child.lock().await.wait().await;
            let last = errors.await.unwrap_or_default();
            chats.finish(&id, &reader, &last);
        });
    }
    /// Stops a conversation's agent so it can start again with other settings; returns its state.
    async fn restart(&self, id: &str) -> Option<(Conversation, PathBuf)> {
        let running = self.running.lock().unwrap().remove(id)?;
        let state = {
            let live = running.live.lock().unwrap();
            (live.conversation.clone(), live.path.clone())
        };
        let mut child = running.child.lock().await;
        let _ = child.start_kill();
        // Both processes must never write the same session.
        let _ = child.wait().await;
        Some(state)
    }
    /// Stops a conversation's agent for good, before its file is archived or deleted.
    async fn retire(&self, id: &str) {
        let running = self.running.lock().unwrap().remove(id);
        if let Some(running) = running {
            running.live.lock().unwrap().removed = true;
            let _ = running.child.lock().await.start_kill();
        }
    }
    /// The agent exited: keep any streamed text, and end a turn it left unfinished.
    fn finish(&self, id: &str, running: &Arc<Running>, stderr: &str) {
        {
            let mut map = self.running.lock().unwrap();
            if map.get(id).is_some_and(|r| Arc::ptr_eq(r, running)) {
                map.remove(id);
            }
        }
        let mut live = running.live.lock().unwrap();
        let mut events = Vec::new();
        if !live.partial.trim().is_empty() {
            let entry = Entry::new("assistant", "", &live.partial);
            events.push(json!({"type":"entry","id":id,"index":live.conversation.entries.len(),"entry":entry.json()}));
            live.conversation.entries.push(entry);
            live.partial.clear();
            if !live.removed {
                let _ = save(&live.conversation, &live.path);
            }
        }
        if live.busy {
            live.busy = false;
            let message = if stderr.is_empty() {
                "The agent stopped"
            } else {
                stderr
            };
            let error = if live.stopping {
                Value::Null
            } else {
                json!(message)
            };
            events.push(json!({"type":"done","id":id,"error":error}));
        }
        self.stamp(&mut events);
        drop(live);
        self.emit(events);
    }
}

pub async fn status(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let root = root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let running = app.chats.running.lock().unwrap();
    let chats: Vec<Value> = list(&root)
        .into_iter()
        .map(|mut chat| {
            let id = chat["id"].as_str().unwrap_or_default();
            chat["busy"] = json!(running.get(id).is_some_and(|r| r.live.lock().unwrap().busy));
            chat
        })
        .collect();
    let agents = installed();
    let (model, effort) = defaults();
    let offered: Vec<Value> = agents
        .iter()
        .map(|(id, label, _)| {
            let (model, effort) = if claude_family(id) {
                (model.clone(), effort.clone())
            } else {
                Default::default()
            };
            json!({
                "id": id,
                "label": label,
                "models": agent_models(id).iter().map(|(id, label)| json!({"id":id,"label":label})).collect::<Vec<_>>(),
                "efforts": agent_efforts(id),
                "defaults": {"model": model, "effort": effort},
            })
        })
        .collect();
    Ok(Json(json!({
        "folder": tilde(&root),
        "available": !agents.is_empty(),
        "agent": agents.first().map(|(id, _, _)| *id),
        "agents": offered,
        "models": models().iter().map(|(id, label)| json!({"id":id,"label":label})).collect::<Vec<_>>(),
        "efforts": EFFORTS,
        "defaults": {"model": model, "effort": effort},
        "chats": chats,
    })))
}

pub async fn read(State(app): State<App>, Path(id): Path<String>) -> Result<Json<Value>, ApiError> {
    if let Some(running) = app.chats.get(&id) {
        let live = running.live.lock().unwrap();
        let mut value = live.conversation.json();
        value["busy"] = json!(live.busy);
        value["folder"] = json!(live.path.parent().map(|d| d.to_string_lossy()));
        value["partial"] = json!(live.partial);
        value["seq"] = json!(live.seq);
        value["n"] = json!(app.chats.counter.load(Ordering::SeqCst));
        return Ok(Json(value));
    }
    let root = root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let path = find(&root, &id)
        .map_err(|e| (StatusCode::NOT_FOUND, Json(json!({"error":e.to_string()}))))?;
    let mut value = load(&path).map_err(error)?.json();
    value["folder"] = json!(path.parent().map(|d| d.to_string_lossy()));
    value["busy"] = json!(false);
    value["partial"] = json!("");
    value["seq"] = json!(0);
    value["n"] = json!(app.chats.counter.load(Ordering::SeqCst));
    Ok(Json(value))
}

#[derive(Deserialize)]
pub struct Send {
    #[serde(default)]
    id: Option<String>,
    text: String,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    effort: Option<String>,
    /// The agent for a new chat, or another of the Claude family for an existing one.
    #[serde(default)]
    agent: Option<String>,
    /// Paths returned by `/api/uploads/files`, moved into the chat's folder when sent.
    #[serde(default)]
    attachments: Vec<String>,
}
pub async fn send(
    State(app): State<App>,
    Json(request): Json<Send>,
) -> Result<Json<Value>, ApiError> {
    let text = request.text.trim().to_owned();
    if (text.is_empty() && request.attachments.is_empty())
        || text.len() > MAX_TEXT
        || request.attachments.len() > 20
    {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(
                json!({"error":"The message is empty, longer than 64 KiB, or has more than 20 files"}),
            ),
        ));
    }
    // Only files uploaded through Omarchy Remote can be attached, never other host files.
    let uploads: Vec<PathBuf> = request
        .attachments
        .iter()
        .map(|path| uploaded(FsPath::new(path)))
        .collect::<anyhow::Result<_>>()
        .map_err(|e| {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":e.to_string()})),
            )
        })?;
    let chats = app.chats.clone();
    let root = root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let agents = installed();
    let offered = |agent: &str| agents.iter().any(|(id, _, _)| *id == agent);
    let refuse = |status: StatusCode, message: &str| (status, Json(json!({"error": message})));
    // The chat's agent so far: from its running agent, or its file.
    let current = match request.id.as_deref() {
        None => None,
        Some(id) => Some(match chats.get(id) {
            Some(running) => agent_of(&running.live.lock().unwrap().conversation).to_owned(),
            None => {
                let path =
                    find(&root, id).map_err(|e| refuse(StatusCode::NOT_FOUND, &e.to_string()))?;
                agent_of(&load(&path).map_err(error)?).to_owned()
            }
        }),
    };
    let agent = request
        .agent
        .clone()
        .or_else(|| current.clone())
        .or_else(|| agents.first().map(|(id, _, _)| (*id).to_owned()))
        .unwrap_or_else(|| "claude".into());
    if let Some(current) = &current
        && *current != agent
        && !(claude_family(current) && claude_family(&agent))
    {
        return Err(refuse(
            StatusCode::CONFLICT,
            "A chat keeps its agent; start a new chat to use another",
        ));
    }
    if !offered(&agent) {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "That agent is not installed on this host",
        ));
    }
    if !valid_settings(
        &agent,
        request.model.as_deref().unwrap_or_default(),
        request.effort.as_deref().unwrap_or_default(),
    ) {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "Unsupported model or effort",
        ));
    }
    // New settings, or the other agent of the Claude family, take effect by starting the agent
    // again; never in the middle of a reply. A Codex reply cannot take another message.
    let mut restarted = None;
    if let Some(running) = request.id.as_deref().and_then(|id| chats.get(id)) {
        let (busy, started) = {
            let live = running.live.lock().unwrap();
            (live.busy, live.started.clone())
        };
        if busy && agent == "codex" {
            return Err(refuse(
                StatusCode::CONFLICT,
                "Wait for Codex to finish its reply",
            ));
        }
        let wanted = (
            request.model.clone().unwrap_or_else(|| started.0.clone()),
            request.effort.clone().unwrap_or_else(|| started.1.clone()),
        );
        if wanted != started || current.as_deref() != Some(agent.as_str()) {
            if busy {
                return Err(refuse(
                    StatusCode::CONFLICT,
                    "Wait for the reply to finish before changing the agent, model or effort",
                ));
            }
            restarted = chats
                .restart(request.id.as_deref().unwrap_or_default())
                .await;
        }
    }
    let running = match request.id.as_deref().and_then(|id| chats.get(id)) {
        Some(running) => Some(running),
        None => {
            let (mut conversation, path, resume) = match (&request.id, restarted) {
                (Some(_), Some((conversation, path))) => (conversation, path, true),
                (Some(id), None) => {
                    let path = find(&root, id)
                        .map_err(|e| refuse(StatusCode::NOT_FOUND, &e.to_string()))?;
                    (load(&path).map_err(error)?, path, true)
                }
                (None, _) => {
                    let id = uuid::Uuid::new_v4().to_string();
                    let title = match (text.is_empty(), uploads.first()) {
                        (true, Some(upload)) => original_name(upload),
                        _ => title(&text),
                    };
                    let created = now();
                    let name = format!("{}-{}-{}", &created[..10], slug(&title), &id[..8]);
                    let path = new_dir(&root, &name).map_err(error)?.join(FILE);
                    let conversation = Conversation {
                        // Codex names its session once it starts.
                        session: if agent == "codex" {
                            String::new()
                        } else {
                            id.clone()
                        },
                        id,
                        agent: agent.clone(),
                        model: String::new(),
                        effort: String::new(),
                        title,
                        updated: created.clone(),
                        created,
                        entries: Vec::new(),
                    };
                    (conversation, path, false)
                }
            };
            conversation.agent = agent.clone();
            if let Some(model) = &request.model {
                conversation.model = model.clone();
            }
            if let Some(effort) = &request.effort {
                conversation.effort = effort.clone();
            }
            let mut live = Live {
                conversation,
                path,
                busy: false,
                partial: String::new(),
                seq: 0,
                message: String::new(),
                used: Instant::now(),
                stopping: false,
                removed: false,
                started: Default::default(),
                failure: None,
            };
            if agent == "codex" {
                // Each Codex turn is its own run, given the message as it starts.
                let (id, events, attachments) =
                    add_message(&chats, &mut live, &text, &uploads, &root).map_err(error)?;
                let folder = live.path.parent().unwrap_or(&root).to_owned();
                let (prompt, images) = codex_prompt(&text, &folder, &attachments);
                chats.emit(events);
                if let Err(e) = chats.spawn_codex(live, &prompt, &images, &root) {
                    return Err(error(format!("Codex could not start: {e}")));
                }
                return Ok(Json(json!({"id":id})));
            }
            Some(chats.spawn(live, resume, &root).map_err(error)?)
        }
    };
    let running = running.expect("a Claude agent is running");
    let (id, events, content) = {
        let mut live = running.live.lock().unwrap();
        let (id, events, attachments) =
            add_message(&chats, &mut live, &text, &uploads, &root).map_err(error)?;
        let folder = live.path.parent().unwrap_or(&root).to_owned();
        (id, events, message_content(&text, &folder, &attachments))
    };
    chats.emit(events);
    let line =
        json!({"type":"user","message":{"role":"user","content":content}}).to_string() + "\n";
    let mut stdin = running.stdin.lock().await;
    let written = match stdin.as_mut() {
        Some(stdin) => stdin.write_all(line.as_bytes()).await,
        None => Err(std::io::Error::other("closed")),
    };
    if let Err(e) = written {
        drop(stdin);
        let _ = running.child.lock().await.start_kill();
        return Err(error(format!("The agent is not running: {e}")));
    }
    Ok(Json(json!({"id":id})))
}

/// Adds the person's message to a chat, with its files moved into the chat's folder, and marks
/// the chat busy; returns the chat's id, the events to send, and the files' paths in the folder.
fn add_message(
    chats: &Chats,
    live: &mut Live,
    text: &str,
    uploads: &[PathBuf],
    root: &FsPath,
) -> anyhow::Result<(String, Vec<Value>, Vec<String>)> {
    let mut entry = Entry::new("user", "", text);
    let folder = live.path.parent().unwrap_or(root).to_owned();
    for upload in uploads {
        entry.attachments.push(attach(&folder, upload)?);
    }
    let attachments = entry.attachments.clone();
    let id = live.conversation.id.clone();
    let mut events = vec![
        json!({"type":"entry","id":id,"index":live.conversation.entries.len(),"entry":entry.json()}),
        json!({"type":"busy","id":id}),
    ];
    chats.stamp(&mut events);
    live.conversation.entries.push(entry);
    live.conversation.updated = now();
    live.busy = true;
    live.failure = None;
    live.used = Instant::now();
    save(&live.conversation, &live.path)?;
    Ok((id, events, attachments))
}
/// A Codex turn's prompt, naming the message's files, and the pictures to attach with `-i`.
fn codex_prompt(text: &str, folder: &FsPath, attachments: &[String]) -> (String, Vec<PathBuf>) {
    if attachments.is_empty() {
        return (text.to_owned(), Vec::new());
    }
    let images: Vec<PathBuf> = attachments
        .iter()
        .map(|path| folder.join(path))
        .filter(|path| {
            fs::read(path)
                .ok()
                .is_some_and(|bytes| image_media(&bytes).is_some())
        })
        .collect();
    let list: String = attachments
        .iter()
        .map(|path| format!("\n- {path}"))
        .collect();
    let note = format!("Attached files, in this chat's folder:{list}");
    let prompt = if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    };
    (prompt, images)
}

/// An upload's real path, which must be a file in the uploads folder.
fn uploaded(path: &FsPath) -> anyhow::Result<PathBuf> {
    uploaded_in(&crate::uploads::directory()?, path)
}
fn uploaded_in(uploads: &FsPath, path: &FsPath) -> anyhow::Result<PathBuf> {
    let uploads = uploads.canonicalize()?;
    let path = path
        .canonicalize()
        .map_err(|_| anyhow::anyhow!("An attachment is no longer on the host; attach it again"))?;
    anyhow::ensure!(
        path.starts_with(&uploads) && path.is_file(),
        "Only uploaded files can be attached"
    );
    Ok(path)
}
/// The name a file was uploaded with: uploads are stored as `<uuid>-<name>`.
fn original_name(upload: &FsPath) -> String {
    let name = upload.file_name().unwrap_or_default().to_string_lossy();
    match name.split_at_checked(37) {
        Some((id, rest)) if uuid::Uuid::parse_str(&id[..36]).is_ok() && id.ends_with('-') => {
            rest.to_owned()
        }
        _ => name.into_owned(),
    }
}
/// Moves an upload into the chat's `attachments` folder (numbered if the name is taken) and
/// returns its path relative to the chat folder.
fn attach(folder: &FsPath, upload: &FsPath) -> anyhow::Result<String> {
    let dir = folder.join("attachments");
    private_dir(&dir)?;
    let name = original_name(upload);
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem.to_owned(), format!(".{extension}")),
        _ => (name.clone(), String::new()),
    };
    let mut target = dir.join(&name);
    let mut copy = 2;
    while fs::symlink_metadata(&target).is_ok() {
        target = dir.join(format!("{stem}-{copy}{extension}"));
        copy += 1;
    }
    if fs::rename(upload, &target).is_err() {
        fs::copy(upload, &target)?;
        fs::remove_file(upload)?;
    }
    fs::set_permissions(&target, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    Ok(format!(
        "attachments/{}",
        target.file_name().unwrap_or_default().to_string_lossy()
    ))
}
/// The image formats Claude reads directly, by signature.
fn image_media(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, b)| n | u32::from(*b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                TABLE[(n >> (18 - 6 * i) & 63) as usize] as char
            } else {
                '='
            });
        }
    }
    out
}
/// Claude's message: images it can read go in as images (up to the API's 5 MB once encoded), and
/// every attachment is named by its path in the chat folder, where Claude runs.
fn message_content(text: &str, folder: &FsPath, attachments: &[String]) -> Value {
    if attachments.is_empty() {
        return json!(text);
    }
    let mut blocks = Vec::new();
    let mut list = String::new();
    for path in attachments {
        list.push_str("\n- ");
        list.push_str(path);
        let Ok(bytes) = fs::read(folder.join(path)) else {
            continue;
        };
        // Pictures the API accepts go inline, so Claude need not read them again.
        if let Some(media) = image_media(&bytes).filter(|_| bytes.len() <= 3_750_000) {
            blocks.push(json!({"type":"image","source":{"type":"base64","media_type":media,"data":base64(&bytes)}}));
            list.push_str(" (shown above)");
        }
    }
    let note = format!("Attached files, in this chat's folder:{list}");
    let text = if text.is_empty() {
        note
    } else {
        format!("{text}\n\n{note}")
    };
    blocks.push(json!({"type":"text","text":text}));
    json!(blocks)
}

/// Where a chat's Claude session log is, and whether a reply is in progress.
/// A chat's session: its agent, its id, Claude's log for it, and whether a reply is in progress.
/// Codex finds its own log by the id.
fn session_log(app: &App, id: &str) -> anyhow::Result<(String, String, Option<PathBuf>, bool)> {
    let (conversation, path, busy) = match app.chats.get(id) {
        Some(running) => {
            let live = running.live.lock().unwrap();
            (live.conversation.clone(), live.path.clone(), live.busy)
        }
        None => {
            let path = find(&root()?, id)?;
            (load(&path)?, path, false)
        }
    };
    let agent = agent_of(&conversation).to_owned();
    let session = conversation.session;
    let folder = path.parent().unwrap_or(&path);
    let log = if claude_family(&agent) {
        Some(claude_files(&claude_config()?, folder, &session)?.remove(0))
    } else {
        None
    };
    Ok((agent, session, log, busy))
}
/// The latest reply's prose in the shape Herdr's Voice mode reads: `session`, `answer`, its
/// `paragraphs` as they arrive, and whether Claude is `working`.
async fn voice_state(app: &App, id: &str) -> anyhow::Result<Value> {
    let (agent, session, log, busy) = session_log(app, id)?;
    let lookup = session.clone();
    let mut value = tokio::task::spawn_blocking(move || {
        let empty = || Ok(json!({"answer":null,"updates":[],"paragraphs":[],"working":false}));
        // A chat whose first reply has not started has no log yet.
        match log {
            Some(log) if log.is_file() => crate::voice::claude_answer(&log),
            _ if agent == "codex" && !lookup.is_empty() => {
                crate::voice::codex_answer(&lookup).or_else(|_| empty())
            }
            _ => empty(),
        }
    })
    .await??;
    value["session"] = json!(session);
    value["can_send"] = json!(true);
    if busy {
        value["working"] = json!(true);
    }
    Ok(value)
}
pub async fn response(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(voice_state(&app, &id).await.map_err(error)?))
}
pub async fn speech(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(request): Json<crate::voice::SpeechRequest>,
) -> Result<Response, ApiError> {
    let value = voice_state(&app, &id).await.map_err(error)?;
    crate::voice::speak(&value, request).await
}

/// A chat's attachment, for the app to show: `name` must be a file in its `attachments` folder.
pub async fn attachment(
    State(app): State<App>,
    Path((id, name)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    let missing = || {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"Attachment not found"})),
        )
    };
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(missing());
    }
    let path = match app.chats.get(&id) {
        Some(running) => running.live.lock().unwrap().path.clone(),
        None => {
            let root = root().map_err(error)?;
            find(&root, &id).map_err(|_| missing())?
        }
    };
    let file = path.with_file_name("attachments").join(&name);
    let meta = fs::symlink_metadata(&file).map_err(|_| missing())?;
    if !meta.is_file() {
        return Err(missing());
    }
    let bytes = tokio::fs::read(&file).await.map_err(error)?;
    let kind = image_media(&bytes).unwrap_or("application/octet-stream");
    Ok((
        [
            (axum::http::header::CONTENT_TYPE, kind),
            (axum::http::header::CACHE_CONTROL, "private, max-age=3600"),
        ],
        bytes,
    )
        .into_response())
}

/// Stops the agent mid-reply. Its session keeps everything up to the last complete message, and
/// the streamed text so far is kept in the conversation.
pub async fn stop(State(app): State<App>, Path(id): Path<String>) -> Json<Value> {
    if let Some(running) = app.chats.get(&id) {
        running.live.lock().unwrap().stopping = true;
        let _ = running.child.lock().await.start_kill();
    }
    Json(json!({"stopped":true}))
}

/// Claude files a session's log under a folder named after the working directory's path, with
/// every other character a dash.
fn claude_project(config: &FsPath, cwd: &FsPath) -> PathBuf {
    let project: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    config.join("projects").join(project)
}
/// Claude's own copy of a conversation: its session log and the session's other files.
fn claude_files(config: &FsPath, cwd: &FsPath, session: &str) -> anyhow::Result<Vec<PathBuf>> {
    anyhow::ensure!(uuid::Uuid::parse_str(session).is_ok(), "Invalid session");
    let project = claude_project(config, cwd);
    Ok(vec![
        project.join(format!("{session}.jsonl")),
        project.join(session),
        config.join("file-history").join(session),
        config.join("session-env").join(session),
    ])
}
/// Moves a session's log to the project folder of a chat's new location, so `claude --resume`
/// run there lists it. Claude also finds a session by id from anywhere, so a failure is harmless.
fn move_session(config: &FsPath, from: &FsPath, to: &FsPath, session: &str) {
    if uuid::Uuid::parse_str(session).is_err() {
        return;
    }
    let (old, new) = (claude_project(config, from), claude_project(config, to));
    for name in [format!("{session}.jsonl"), session.to_owned()] {
        let source = old.join(&name);
        if fs::symlink_metadata(&source).is_ok()
            && fs::create_dir_all(&new).is_ok()
            && let Err(e) = fs::rename(&source, new.join(&name))
        {
            eprintln!("chat: could not move {}: {e}", source.display());
        }
    }
}
/// Converts chats saved as single files (in `conversations` and `archives`) into folders.
fn migrate(config: &FsPath, root: &FsPath) {
    for (files, parent) in [
        (root.join("conversations"), root.to_owned()),
        (root.join("archives"), root.join("archives")),
    ] {
        let Ok(entries) = fs::read_dir(&files) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !entry.file_type().is_ok_and(|t| t.is_file())
                || path.extension().is_none_or(|x| x != "md")
            {
                continue;
            }
            let Some(conversation) = fs::read_to_string(&path)
                .ok()
                .and_then(|t| Conversation::parse(&t))
            else {
                continue;
            };
            let name = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let moved = new_dir(&parent, &name).and_then(|dir| {
                fs::rename(&path, dir.join(FILE))?;
                Ok(dir)
            });
            match moved {
                // Before folders, every chat's agent ran in the Chats folder itself.
                Ok(dir) => move_session(config, root, &dir, &conversation.session),
                Err(e) => eprintln!("chat: could not move {} into a folder: {e}", path.display()),
            }
        }
        // Only an emptied `conversations` folder goes; `archives` holds the archived folders.
        if files != parent {
            let _ = fs::remove_dir(&files);
        }
    }
}
/// Removes a file or folder; a symlink is removed itself, never followed.
fn remove(path: &FsPath) -> anyhow::Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
        Ok(_) => fs::remove_file(path)?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    Ok(())
}
/// The folder of a chat's conversation file, which must be a chat folder directly in `parent`.
fn chat_dir(parent: &FsPath, path: &FsPath) -> anyhow::Result<PathBuf> {
    let dir = path
        .parent()
        .ok_or_else(|| anyhow::anyhow!("Chat file has no folder"))?;
    anyhow::ensure!(
        dir.parent() == Some(parent) && dir.file_name().is_some_and(|n| n != "archives"),
        "Not a chat folder"
    );
    Ok(dir.to_owned())
}
/// Moves a chat's folder to `archives`, keeping Claude's session so it can be resumed.
fn archive_dir(config: &FsPath, root: &FsPath, path: &FsPath) -> anyhow::Result<PathBuf> {
    let dir = chat_dir(root, path)?;
    let session = load(path)?.session;
    let archives = root.join("archives");
    private_dir(&archives)?;
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut target = archives.join(&name);
    let mut copy = 2;
    while fs::symlink_metadata(&target).is_ok() {
        target = archives.join(format!("{name}-{copy}"));
        copy += 1;
    }
    fs::rename(&dir, &target)?;
    move_session(config, &dir, &target, &session);
    Ok(target)
}
fn claude_config() -> anyhow::Result<PathBuf> {
    Ok(match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(dir) => PathBuf::from(dir),
        None => apps::home()?.join(".claude"),
    })
}
/// Deletes a chat: its folder, including any files made in it, and Claude's copy of it.
fn delete_dir(config: &FsPath, root: &FsPath, path: &FsPath, id: &str) -> anyhow::Result<()> {
    let dir = chat_dir(root, path)?;
    let session = load(path)
        .map(|c| c.session)
        .unwrap_or_else(|_| id.to_owned());
    for file in claude_files(config, &dir, &session)? {
        remove(&file)?;
    }
    remove(&dir)
}

#[derive(Deserialize)]
pub struct Batch {
    ids: Vec<String>,
}
pub async fn archive(
    State(app): State<App>,
    Json(batch): Json<Batch>,
) -> Result<Json<Value>, ApiError> {
    manage(&app, batch.ids, false).await
}
pub async fn delete(
    State(app): State<App>,
    Json(batch): Json<Batch>,
) -> Result<Json<Value>, ApiError> {
    manage(&app, batch.ids, true).await
}
async fn manage(app: &App, ids: Vec<String>, delete: bool) -> Result<Json<Value>, ApiError> {
    if ids.is_empty() || ids.len() > 1000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Choose between 1 and 1000 chats"})),
        ));
    }
    let root = root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for id in ids {
        let path = match find(&root, &id) {
            Ok(path) => path,
            Err(e) => {
                failed.push(json!({"id":id,"error":e.to_string()}));
                continue;
            }
        };
        app.chats.retire(&id).await;
        let result = if delete {
            claude_config().and_then(|config| delete_dir(&config, &root, &path, &id))
        } else {
            claude_config().and_then(|config| archive_dir(&config, &root, &path).map(|_| ()))
        };
        match result {
            Ok(()) => done.push(id),
            Err(e) => failed.push(json!({"id":id,"error":e.to_string()})),
        }
    }
    let mut events = vec![json!({"type":"removed","ids":done})];
    app.chats.stamp(&mut events);
    app.chats.emit(events);
    Ok(Json(json!({"done":done,"failed":failed})))
}

pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(4096)
        .on_upgrade(move |socket| events(socket, app.chats))
}
async fn events(mut socket: WebSocket, chats: Chats) {
    let mut receiver = chats.events.subscribe();
    loop {
        tokio::select! {
            event = receiver.recv() => {
                let message = match event {
                    Ok(event) => event,
                    // Missed events: the client reloads the chat it shows.
                    Err(broadcast::error::RecvError::Lagged(_)) => json!({"type":"resync"}),
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                    break;
                }
            }
            incoming = socket.recv() => {
                if !matches!(incoming, Some(Ok(_))) {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Conversation {
        Conversation {
            id: "1b8ab544-8cc5-430e-8a40-0aec58bc3b10".into(),
            agent: "claude".into(),
            session: "1b8ab544-8cc5-430e-8a40-0aec58bc3b10".into(),
            model: "opus".into(),
            effort: "high".into(),
            title: "Plan \"dinner\": ideas".into(),
            created: "2026-10-03T10:00:00Z".into(),
            updated: "2026-10-03T10:01:00Z".into(),
            entries: vec![
                Entry { role: "user".into(), time: "2026-10-03T10:00:00Z".into(), name: String::new(), text: "Ideas for dinner?\n\nSomething quick.".into(), attachments: vec!["attachments/fridge.jpg".into(), "attachments/menu plan.pdf".into()] },
                Entry { role: "tool".into(), time: "2026-10-03T10:00:02Z".into(), name: "WebSearch".into(), text: "quick dinner recipes".into(), attachments: Vec::new() },
                Entry {
                    role: "assistant".into(),
                    time: "2026-10-03T10:00:05Z".into(),
                    name: String::new(),
                    text: "**Pasta** is quick.\n\n```\n<!-- omarchy-chat:user 2026 -->\n  <!-- omarchy-chat:tool x y -->\n```\n**You**".into(),
                    attachments: Vec::new(),
                },
            ],
        }
    }

    #[test]
    fn conversations_round_trip_through_markdown() {
        let conversation = sample();
        let markdown = conversation.to_markdown();
        assert!(markdown.starts_with("---\nid: \"1b8ab544-8cc5-430e-8a40-0aec58bc3b10\"\n"));
        assert!(markdown.contains("**You**\n\nIdeas for dinner?"));
        assert!(markdown.contains("> quick dinner recipes"));
        assert!(markdown.contains("Something quick.\n\n![fridge.jpg](<attachments/fridge.jpg>)\n[menu plan.pdf](<attachments/menu plan.pdf>)\n"));
        // Marker-like lines in a message cannot start a new entry.
        assert_eq!(markdown.matches(&format!("\n{MARK}")).count(), 3);
        assert_eq!(Conversation::parse(&markdown).unwrap(), conversation);
        assert_eq!(
            conversation.preview(),
            "**Pasta** is quick. ``` <!-- omarchy-chat:user 2026 --> <!-- omarchy-chat:tool x y --> ``` **You**"
        );
    }

    #[test]
    fn codex_events_become_entries_and_name_the_session() {
        let mut live = Live {
            conversation: Conversation {
                id: "c".into(),
                agent: "codex".into(),
                ..Conversation::default()
            },
            path: PathBuf::from("/tmp/chat.md"),
            busy: true,
            partial: String::new(),
            seq: 0,
            message: String::new(),
            used: Instant::now(),
            stopping: false,
            removed: false,
            started: Default::default(),
            failure: None,
        };
        let events = live.apply(&json!({"type":"thread.started","thread_id":"01a13635-b662"}));
        assert_eq!(live.conversation.session, "01a13635-b662");
        assert_eq!(events[0]["type"], "session");
        live.apply(
            &json!({"type":"item.completed","item":{"type":"agent_message","text":"I'll check."}}),
        );
        live.apply(&json!({"type":"item.started","item":{"type":"command_execution","command":"/usr/bin/bash -lc 'echo hi'"}}));
        // A finished command was already shown when it started.
        live.apply(&json!({"type":"item.completed","item":{"type":"command_execution","command":"/usr/bin/bash -lc 'echo hi'","aggregated_output":"hi"}}));
        live.apply(&json!({"type":"item.completed","item":{"type":"file_change","changes":[{"path":"/tmp/a/notes.md","kind":"add"}]}}));
        live.apply(&json!({"type":"item.completed","item":{"type":"reasoning","text":"private"}}));
        let done = live.apply(&json!({"type":"turn.completed","usage":{}}));
        let entries: Vec<(&str, &str, &str)> = live
            .conversation
            .entries
            .iter()
            .map(|e| (e.role.as_str(), e.name.as_str(), e.text.as_str()))
            .collect();
        assert_eq!(
            entries,
            [
                ("assistant", "", "I'll check."),
                ("tool", "Shell", "echo hi"),
                ("tool", "Edit", "notes.md"),
            ]
        );
        assert!(!live.busy);
        assert_eq!(done[0], json!({"type":"done","id":"c","error":null}));
        // A failed turn reports Codex's error.
        live.busy = true;
        live.apply(&json!({"type":"error","message":"You've hit your usage limit."}));
        let failed = live.apply(&json!({"type":"turn.failed"}));
        assert_eq!(failed[0]["error"], "You've hit your usage limit.");
        assert_eq!(
            codex_command("/usr/bin/bash -lc 'cargo build'"),
            "cargo build"
        );
        assert_eq!(codex_command("ls -la"), "ls -la");
    }

    #[test]
    fn a_codex_prompt_names_the_files_and_attaches_the_pictures() {
        let dir = crate::dictation::AudioDir::new().unwrap();
        let folder = dir.0.join("chat");
        fs::create_dir_all(folder.join("attachments")).unwrap();
        fs::write(
            folder.join("attachments/photo.png"),
            b"\x89PNG\r\n\x1a\nrest",
        )
        .unwrap();
        fs::write(folder.join("attachments/notes.txt"), "notes").unwrap();
        assert_eq!(
            codex_prompt("Hi", &folder, &[]),
            ("Hi".to_owned(), Vec::new())
        );
        let (prompt, images) = codex_prompt(
            "What is this?",
            &folder,
            &[
                "attachments/photo.png".into(),
                "attachments/notes.txt".into(),
            ],
        );
        assert_eq!(
            prompt,
            "What is this?\n\nAttached files, in this chat's folder:\n- attachments/photo.png\n- attachments/notes.txt"
        );
        assert_eq!(images, vec![folder.join("attachments/photo.png")]);
    }

    #[test]
    fn settings_are_limited_to_offered_models_and_efforts() {
        assert!(valid_settings("claude", "", ""));
        assert!(valid_settings("claude", "opus", "xhigh"));
        assert!(valid_settings("claudex", "opus", "max"));
        assert!(!valid_settings(
            "claude",
            "--dangerously-skip-permissions",
            ""
        ));
        assert!(!valid_settings("claude", "opus", "extreme"));
        // Codex runs its own configured model and has its own effort levels.
        assert!(valid_settings("codex", "", "xhigh"));
        assert!(!valid_settings("codex", "opus", ""));
        assert!(!valid_settings("codex", "", "max"));
        assert!(claude_family("claudex") && !claude_family("codex"));
        // A chat saved before there was a choice of agent ran Claude.
        assert_eq!(agent_of(&Conversation::default()), "claude");
        // Default uses Chat's configured model, and a chat's own choice wins over it.
        let configured = ("opus".to_owned(), String::new());
        assert_eq!(
            effective("", "", &configured),
            ("opus".into(), String::new())
        );
        assert_eq!(
            effective("haiku", "low", &configured),
            ("haiku".into(), "low".into())
        );
        // Files written before chats had settings still load, with Claude's defaults.
        let old = "---\nid: \"1b8ab544-8cc5-430e-8a40-0aec58bc3b10\"\ntitle: \"Old\"\n---\n";
        let conversation = Conversation::parse(old).unwrap();
        assert_eq!(
            (conversation.model.as_str(), conversation.effort.as_str()),
            ("", "")
        );
    }

    #[test]
    fn attachments_are_uploads_moved_into_the_chat_and_sent_as_images() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xfb, 0xff]), "+/8=");
        let dir = crate::dictation::AudioDir::new().unwrap();
        let uploads = dir.0.join("uploads");
        fs::create_dir(&uploads).unwrap();
        let png = b"\x89PNG\r\n\x1a\nrest of image".to_vec();
        let photo = uploads.join("0b8ab544-8cc5-430e-8a40-0aec58bc3b10-photo.png");
        fs::write(&photo, &png).unwrap();
        let notes = uploads.join("1c8ab544-8cc5-430e-8a40-0aec58bc3b10-notes.txt");
        fs::write(&notes, "notes").unwrap();
        assert_eq!(original_name(&photo), "photo.png");
        assert_eq!(
            original_name(&uploads.join("image-abc.png")),
            "image-abc.png"
        );
        // Only files in the uploads folder can be attached.
        assert_eq!(
            uploaded_in(&uploads, &photo).unwrap(),
            photo.canonicalize().unwrap()
        );
        let outside = dir.0.join("secret.txt");
        fs::write(&outside, "secret").unwrap();
        assert!(uploaded_in(&uploads, &outside).is_err());
        assert!(uploaded_in(&uploads, &uploads.join("../secret.txt")).is_err());
        assert!(uploaded_in(&uploads, &uploads).is_err());
        let chat = dir.0.join("chat");
        fs::create_dir(&chat).unwrap();
        fs::write(chat.join("ignored"), "").unwrap();
        assert_eq!(attach(&chat, &photo).unwrap(), "attachments/photo.png");
        assert!(!photo.exists());
        // The same name again is numbered rather than replacing the first.
        fs::write(&photo, &png).unwrap();
        assert_eq!(attach(&chat, &photo).unwrap(), "attachments/photo-2.png");
        assert_eq!(attach(&chat, &notes).unwrap(), "attachments/notes.txt");
        let content = message_content(
            "What is this?",
            &chat,
            &[
                "attachments/photo.png".into(),
                "attachments/notes.txt".into(),
            ],
        );
        assert_eq!(content[0]["type"], "image");
        assert_eq!(content[0]["source"]["media_type"], "image/png");
        assert_eq!(content[0]["source"]["data"], base64(&png));
        assert_eq!(content.as_array().unwrap().len(), 2);
        assert_eq!(
            content[1]["text"],
            "What is this?\n\nAttached files, in this chat's folder:\n- attachments/photo.png (shown above)\n- attachments/notes.txt"
        );
        assert_eq!(message_content("Plain", &chat, &[]), json!("Plain"));
        // A photo sent without text is previewed by its name.
        let mut conversation = sample();
        conversation.entries.push(Entry {
            attachments: vec!["attachments/photo.png".into()],
            ..Entry::new("user", "", "")
        });
        assert_eq!(conversation.preview(), "📎 photo.png");
    }

    #[test]
    fn unreadable_files_are_rejected() {
        assert!(Conversation::parse("no front matter").is_none());
        assert!(Conversation::parse("---\nid: \"not-a-uuid\"\n---\n").is_none());
        assert!(Conversation::parse("---\nid: unquoted\n---\n").is_none());
    }

    #[test]
    fn titles_slugs_and_timestamps() {
        assert_eq!(
            title("\n  What is   the best way\nsecond line"),
            "What is the best way"
        );
        assert_eq!(title(&"word ".repeat(30)).chars().count(), 60);
        assert_eq!(
            slug("Plan \"dinner\": ideas for a Tuesday night in"),
            "plan-dinner-ideas-for-a-tuesday"
        );
        assert_eq!(slug("¿Qué?"), "qu");
        assert_eq!(slug("…"), "chat");
        assert_eq!(timestamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(timestamp(1_696_334_400), "2023-10-03T12:00:00Z");
        assert_eq!(timestamp(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn stream_events_become_entries_and_deltas() {
        let mut live = Live {
            conversation: Conversation {
                id: "id".into(),
                ..Conversation::default()
            },
            path: PathBuf::new(),
            busy: true,
            partial: String::new(),
            seq: 0,
            message: String::new(),
            used: Instant::now(),
            stopping: false,
            removed: false,
            started: Default::default(),
            failure: None,
        };
        let delta = |text: &str| json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":text}}});
        assert_eq!(live.apply(&delta("Hel"))[0]["seq"], 1);
        live.apply(&delta("lo"));
        assert_eq!(live.partial, "Hello");
        // Thinking deltas and blocks are never shown.
        assert!(live.apply(&json!({"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"x"}}})).is_empty());
        let block = |message: &str, content: Value| json!({"type":"assistant","parent_tool_use_id":null,"message":{"id":message,"content":[content]}});
        assert!(
            live.apply(&block(
                "m1",
                json!({"type":"thinking","thinking":"private"})
            ))
            .is_empty()
        );
        let events = live.apply(&block("m1", json!({"type":"text","text":"Hello"})));
        assert_eq!(events[0]["entry"]["text"], "Hello");
        assert_eq!(live.partial, "");
        live.apply(&block(
            "m1",
            json!({"type":"tool_use","name":"WebSearch","input":{"query":"weather   today"}}),
        ));
        // Text after a tool in the same message starts a new entry; a later block of the same
        // message as the last entry joins it.
        live.apply(&block("m2", json!({"type":"text","text":"Sunny."})));
        let joined = live.apply(&block("m2", json!({"type":"text","text":"Warm, too."})));
        assert_eq!(joined[0]["index"], 2);
        // Worker (subagent) messages stay out of the conversation.
        assert!(live.apply(&json!({"type":"assistant","parent_tool_use_id":"t","message":{"id":"w","content":[{"type":"text","text":"worker"}]}})).is_empty());
        let roles: Vec<_> = live
            .conversation
            .entries
            .iter()
            .map(|e| (e.role.as_str(), e.text.as_str()))
            .collect();
        assert_eq!(
            roles,
            [
                ("assistant", "Hello"),
                ("tool", "weather today"),
                ("assistant", "Sunny.\n\nWarm, too.")
            ]
        );
        let done = live.apply(
            &json!({"type":"result","subtype":"success","is_error":false,"result":"Sunny."}),
        );
        assert_eq!(done[0], json!({"type":"done","id":"id","error":null}));
        assert!(!live.busy);
        live.busy = true;
        let failed = live.apply(&json!({"type":"result","subtype":"error_during_execution","is_error":true,"errors":["Out of usage"]}));
        assert_eq!(failed[0]["error"], "Out of usage");
    }

    fn project(config: &FsPath, cwd: &FsPath, session: &str) -> PathBuf {
        claude_project(config, cwd).join(format!("{session}.jsonl"))
    }
    fn write(path: &FsPath, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn each_chat_is_a_private_folder_and_the_list_reads_their_headers() {
        use std::os::unix::fs::PermissionsExt;
        let dir = crate::dictation::AudioDir::new().unwrap();
        let root = dir.0.join("Chats");
        prepare(&root).unwrap();
        assert_eq!(
            fs::metadata(&root).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let conversation = sample();
        let folder = new_dir(&root, "2026-10-03-plan-dinner-ideas-1b8ab544").unwrap();
        assert_eq!(
            fs::metadata(&folder).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let path = folder.join(FILE);
        save(&conversation, &path).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // A taken name gets a number rather than sharing a folder.
        assert_eq!(
            new_dir(&root, "2026-10-03-plan-dinner-ideas-1b8ab544").unwrap(),
            root.join("2026-10-03-plan-dinner-ideas-1b8ab544-2")
        );
        assert_eq!(find(&root, &conversation.id).unwrap(), path);
        assert!(find(&root, "2c8ab544-8cc5-430e-8a40-0aec58bc3b10").is_err());
        assert!(find(&root, "../escape").is_err());
        assert_eq!(load(&path).unwrap(), conversation);
        // Other folders, loose files, and archived chats are not listed.
        write(&root.join("project/notes.md"), "# not a chat");
        write(
            &root.join("archives/old-1b8ab544/chat.md"),
            &conversation.to_markdown(),
        );
        let chats = list(&root);
        assert_eq!(chats.len(), 1);
        assert_eq!(chats[0]["title"], "Plan \"dinner\": ideas");
        assert_eq!(chats[0]["folder"], json!(folder.to_string_lossy()));
        assert_eq!(chats[0]["preview"], conversation.preview());
    }

    #[test]
    fn archiving_moves_the_folder_with_its_files_and_session() {
        let dir = crate::dictation::AudioDir::new().unwrap();
        let (root, config) = (dir.0.join("Chats"), dir.0.join("claude"));
        let conversation = sample();
        let name = "2026-10-03-plan-dinner-ideas-1b8ab544";
        let folder = new_dir(&root, name).unwrap();
        save(&conversation, &folder.join(FILE)).unwrap();
        write(&folder.join("notes/plan.txt"), "made by Claude");
        write(&project(&config, &folder, &conversation.session), "log");
        let archived = archive_dir(&config, &root, &folder.join(FILE)).unwrap();
        assert_eq!(archived, root.join("archives").join(name));
        assert!(!folder.exists());
        assert!(archived.join("notes/plan.txt").exists());
        assert!(list(&root).is_empty());
        // Claude's log follows the folder, so `claude --resume` there lists it.
        assert!(project(&config, &archived, &conversation.session).exists());
        assert!(!project(&config, &folder, &conversation.session).exists());
        // A second chat with the same name does not replace the first.
        let again = new_dir(&root, name).unwrap();
        save(&conversation, &again.join(FILE)).unwrap();
        assert_eq!(
            archive_dir(&config, &root, &again.join(FILE)).unwrap(),
            root.join("archives").join(format!("{name}-2"))
        );
    }

    #[test]
    fn deleting_removes_the_folder_and_claudes_copy_and_nothing_else() {
        let dir = crate::dictation::AudioDir::new().unwrap();
        let (root, config) = (dir.0.join("Chats"), dir.0.join("claude"));
        let conversation = sample();
        let folder = new_dir(&root, "2026-10-03-plan-dinner-ideas-1b8ab544").unwrap();
        let path = folder.join(FILE);
        save(&conversation, &path).unwrap();
        write(&folder.join("draft.txt"), "made by Claude");
        let files = claude_files(&config, &folder, &conversation.session).unwrap();
        assert_eq!(files[0], project(&config, &folder, &conversation.session));
        write(&files[0], "log");
        fs::create_dir_all(files[2].join("nested")).unwrap();
        // A symlink in Claude's folders is removed, not followed.
        let outside = dir.0.join("outside");
        write(&outside.join("keep"), "keep");
        fs::create_dir_all(files[3].parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(&outside, &files[3]).unwrap();
        delete_dir(&config, &root, &path, &conversation.id).unwrap();
        assert!(!folder.exists());
        for file in &files {
            assert!(fs::symlink_metadata(file).is_err(), "{}", file.display());
        }
        assert!(outside.join("keep").exists());
        assert!(root.exists());
        // Only a chat folder directly in Chats can be deleted, never Chats itself or archives.
        assert!(delete_dir(&config, &root, &root.join(FILE), &conversation.id).is_err());
        assert!(
            delete_dir(
                &config,
                &root,
                &root.join("archives").join(FILE),
                &conversation.id
            )
            .is_err()
        );
        assert!(delete_dir(&config, &root, &outside.join(FILE), &conversation.id).is_err());
        assert!(claude_files(&config, &root, "../escape").is_err());
    }

    #[test]
    fn chats_saved_as_files_become_folders_with_their_sessions() {
        let dir = crate::dictation::AudioDir::new().unwrap();
        let (root, config) = (dir.0.join("Chats"), dir.0.join("claude"));
        let conversation = sample();
        let mut archived = sample();
        archived.id = "2c8ab544-8cc5-430e-8a40-0aec58bc3b10".into();
        archived.session = archived.id.clone();
        write(
            &root.join("conversations/2026-10-03-plan-1b8ab544.md"),
            &conversation.to_markdown(),
        );
        write(&root.join("conversations/notes.txt"), "not a chat");
        write(
            &root.join("archives/2026-10-02-old-2c8ab544.md"),
            &archived.to_markdown(),
        );
        // Before folders, every chat's agent ran in the Chats folder itself.
        write(&project(&config, &root, &conversation.session), "log");
        write(&project(&config, &root, &archived.session), "log");
        migrate(&config, &root);
        let active = root.join("2026-10-03-plan-1b8ab544");
        let old = root.join("archives/2026-10-02-old-2c8ab544");
        assert_eq!(load(&active.join(FILE)).unwrap(), conversation);
        assert_eq!(load(&old.join(FILE)).unwrap(), archived);
        assert!(project(&config, &active, &conversation.session).exists());
        assert!(project(&config, &old, &archived.session).exists());
        // Anything that was not a chat stays where it was, so its folder stays too.
        assert!(root.join("conversations/notes.txt").exists());
        assert_eq!(find(&root, &conversation.id).unwrap(), active.join(FILE));
        // Running it again changes nothing.
        migrate(&config, &root);
        assert_eq!(list(&root).len(), 1);
    }
}
