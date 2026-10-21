//! Chat: conversations with a local Claude Code agent, outside any project. Each conversation is a
//! folder in `~/Chats` holding `chat.md`, the app's own readable record (easy to back up with git),
//! and the agent runs in that folder, so files it makes stay with the conversation and the folder
//! can later become a project. Claude's session log is only used to resume.
use crate::{ApiError, apps, error};
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
use sha2::{Digest, Sha256};
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
    /// For Canvas: how much design work a page gets (one of `DESIGNS`); empty is medium.
    design: String,
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
        json!({"id":self.id,"agent":self.agent,"model":self.model,"effort":self.effort,"design":self.design,"title":self.title,"created":self.created,"updated":self.updated,"preview":self.preview()})
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
        // Only a canvas has a design level, so chats are written as before.
        if !self.design.is_empty() {
            out.push_str(&format!("design: {}\n", json!(self.design)));
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
            design: field("design"),
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
    folder_in_home("OMARCHY_CHAT_DIR", "Chats")
}
fn folder_in_home(variable: &str, default: &str) -> anyhow::Result<PathBuf> {
    let home = apps::home()?;
    let root = match std::env::var_os(variable) {
        Some(dir) => PathBuf::from(dir),
        None => home.join(default),
    };
    anyhow::ensure!(
        root.is_absolute() && root.starts_with(&home) && root != home,
        "{variable} must be a folder inside the home directory"
    );
    Ok(root)
}
/// A chat folder's conversation file.
const FILE: &str = "chat.md";
/// A canvas's icon in the list, which Claude draws.
const ICON: &str = "icon.svg";
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
    /// A Canvas session: its page's version is announced as the agent changes files.
    canvas: bool,
    /// Claude's last message in this turn, where a later fork can continue from.
    last_message: String,
    /// A turn ended: its page is to be kept, by its number, with when the page last changed
    /// before the turn.
    ended: Option<(usize, crate::canvas::Point, u64)>,
    /// Where Claude resumes when it starts: an earlier turn's end, forking its session.
    fork: Option<crate::canvas::Point>,
    /// The screen this turn's message came from, and when the page last changed before it: a
    /// turn that changes the page makes it for that screen.
    turn_layout: String,
    page_before: u64,
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
                if let Some(uuid) = line["uuid"].as_str() {
                    self.last_message = uuid.to_owned();
                }
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
            // A tool finished, perhaps writing the page; and a turn ended.
            "user" | "result" if self.canvas => {
                let folder = self.path.parent().unwrap_or(&self.path);
                events.push(page_event(&id, folder));
                if line["type"] == "result" {
                    let entries = &self.conversation.entries;
                    let turn = entries.iter().filter(|e| e.role == "user").count();
                    self.ended = Some((
                        turn,
                        crate::canvas::Point {
                            session: self.conversation.session.clone(),
                            uuid: self.last_message.clone(),
                            entries: entries.len(),
                            layout: self.turn_layout.clone(),
                        },
                        self.page_before,
                    ));
                    events.extend(self.finish_turn(line));
                }
            }
            "result" => events.extend(self.finish_turn(line)),
            _ => {}
        }
        if events.iter().any(|e| e["type"] != "delta") {
            self.conversation.updated = now();
        }
        events
    }
    fn finish_turn(&mut self, line: &Value) -> Vec<Value> {
        let id = self.conversation.id.clone();
        let mut events = Vec::new();
        {
            {
                self.busy = false;
                self.partial.clear();
                let failed = line["is_error"] == true || line["subtype"] != "success";
                let message = line["result"]
                    .as_str()
                    .or_else(|| line["errors"][0].as_str())
                    .unwrap_or("The agent stopped with an error");
                events.push(json!({"type":"done","id":id,"error":if failed {json!(message)} else {Value::Null}}));
            }
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

/// What a set of conversations is for: Chat's conversations in `~/Chats`, or Canvas sessions in
/// `~/Canvas`, where the agent shows its answers as a page it writes.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Chat,
    Canvas,
}
/// A page being redrawn: for which layout, and the job, which stopping aborts.
type Redrawing = (String, Option<tokio::task::AbortHandle>);
#[derive(Clone)]
pub struct Chats {
    kind: Kind,
    /// Signs the addresses of Canvas pages, which a frame loads without the app's request header.
    secret: Arc<String>,
    running: Arc<Mutex<HashMap<String, Arc<Running>>>>,
    events: broadcast::Sender<Value>,
    /// Numbers every event. A chat read reports the number its state includes, so a client
    /// applies only the events after it.
    counter: Arc<AtomicU64>,
    /// Canvas pages being redrawn for another screen: the layout, and the job doing it.
    redrawing: Arc<Mutex<HashMap<String, Redrawing>>>,
    /// Canvas icons being drawn, with the job drawing each.
    icons: Arc<Mutex<HashMap<String, Option<tokio::task::AbortHandle>>>>,
}
pub fn start(kind: Kind) -> Chats {
    let chats = Chats {
        kind,
        secret: Arc::new(format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4())),
        running: Arc::new(Mutex::new(HashMap::new())),
        events: broadcast::channel(1024).0,
        counter: Arc::new(AtomicU64::new(0)),
        redrawing: Arc::new(Mutex::new(HashMap::new())),
        icons: Arc::new(Mutex::new(HashMap::new())),
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
    /// A canvas's icon in a list entry, where Claude has drawn one.
    fn add_icon(&self, chat: &mut Value) {
        if self.kind != Kind::Canvas {
            return;
        }
        let id = chat["id"].as_str().unwrap_or_default().to_owned();
        let icon = FsPath::new(chat["folder"].as_str().unwrap_or_default()).join(ICON);
        let changed = fs::metadata(&icon)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok());
        if let Some(changed) = changed {
            chat["icon"] = json!(format!(
                "{}{ICON}?v={}",
                self.view(&id),
                changed.as_millis()
            ));
        }
    }
    /// A Canvas session's page: its address, its version, and whether it has been written yet.
    fn describe_page(&self, value: &mut Value, id: &str, folder: Option<&FsPath>, session: &str) {
        if self.kind != Kind::Canvas {
            return;
        }
        value["view"] = json!(self.view(id));
        value["version"] = json!(folder.map_or(0, page_version));
        value["page"] = json!(folder.is_some_and(|f| f.join("index.html").is_file()));
        value["turns"] = folder.map_or(json!([]), crate::canvas::turns);
        value["redrawing"] = json!(self.redrawing.lock().unwrap().get(id).map(|(l, _)| l));
        if let Some(folder) = folder {
            let page = page_event(id, folder);
            let mut layout = page["layout"].as_str().unwrap_or_default().to_owned();
            // A canvas from before layouts were noted takes its last message's screen.
            if layout.is_empty() && value["page"] == true {
                let log = claude_config()
                    .and_then(|config| claude_files(&config, folder, session))
                    .ok()
                    .and_then(|files| files.into_iter().next());
                if let Some(found) = log.as_deref().and_then(infer_layout) {
                    layout = crate::canvas::set_made_for(folder, found);
                }
            }
            value["layout"] = json!(layout);
            value["variants"] = page["variants"].clone();
        }
    }
    /// The agents this set can run: Canvas needs Claude's streaming protocol, so not Codex.
    fn installed(&self) -> Vec<(&'static str, &'static str, &'static str)> {
        installed()
            .into_iter()
            .filter(|(id, _, _)| self.kind == Kind::Chat || claude_family(id))
            .collect()
    }
    /// The address a Canvas session's page is served at, signed for that session.
    fn view(&self, id: &str) -> String {
        let token = format!(
            "{:x}",
            Sha256::digest(format!("{}:{id}", self.secret).as_bytes())
        );
        format!("/api/canvas/view/{id}/{}/", &token[..32])
    }
    /// The folder this set keeps its conversations in.
    fn root(&self) -> anyhow::Result<PathBuf> {
        match self.kind {
            Kind::Chat => root(),
            Kind::Canvas => folder_in_home("OMARCHY_CANVAS_DIR", "Canvas"),
        }
    }
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
    /// What every run of a conversation's Claude is given: its permissions and instructions, then
    /// its model and effort.
    fn agent_args(&self, conversation: &Conversation) -> anyhow::Result<Vec<String>> {
        let mut args: Vec<String> = Vec::new();
        if self.kind == Kind::Canvas {
            // Canvas builds pages with every tool, unasked, and is told how its page is shown.
            args.extend(["--permission-mode".into(), "bypassPermissions".into()]);
            args.extend(["--append-system-prompt".into(), CANVAS_BRIEF.into()]);
            if let Ok(extra) = std::env::var("OMARCHY_CANVAS_CLAUDE_ARGS") {
                args.extend(serde_json::from_str::<Vec<String>>(&extra)?);
            }
        } else {
            // Nobody answers approval prompts yet: anything that would ask is denied, except
            // web search and fetching pages, which a chat needs and which change nothing here.
            args.extend(
                [
                    "--permission-prompts",
                    "none",
                    "--allowedTools",
                    "WebSearch,WebFetch",
                ]
                .map(String::from),
            );
            if let Ok(extra) = std::env::var("OMARCHY_CHAT_CLAUDE_ARGS") {
                args.extend(serde_json::from_str::<Vec<String>>(&extra)?);
            }
        }
        let (model, effort) = (conversation.model.clone(), conversation.effort.clone());
        anyhow::ensure!(
            valid_settings(agent_of(conversation), &model, &effort),
            "Unsupported model or effort"
        );
        let (flag_model, flag_effort) = effective(&model, &effort, &configured());
        if !flag_model.is_empty() {
            args.extend(["--model".into(), flag_model]);
        }
        if !flag_effort.is_empty() {
            args.extend(["--effort".into(), flag_effort]);
        }
        Ok(args)
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
        ]
        .map(String::from)
        .into();
        args.extend(self.agent_args(&live.conversation)?);
        // `started` keeps the chat's own choice, so Default never looks like a change.
        let (model, effort) = (
            live.conversation.model.clone(),
            live.conversation.effort.clone(),
        );
        let mut live = live;
        live.started = (model, effort);
        if let Some(point) = live.fork.take() {
            // A new session that continues the old one as it was at the end of that turn.
            args.extend([
                "--resume".into(),
                point.session,
                "--resume-session-at".into(),
                point.uuid,
                "--fork-session".into(),
                "--session-id".into(),
                live.conversation.session.clone(),
            ]);
        } else {
            args.push(if resume { "--resume" } else { "--session-id" }.into());
            args.push(live.conversation.session.clone());
        }
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
                let (events, ended) = {
                    let mut live = reader.live.lock().unwrap();
                    let mut events = live.apply(&value);
                    chats.stamp(&mut events);
                    if events.iter().any(|e| e["type"] != "delta")
                        && !live.removed
                        && let Err(e) = save(&live.conversation, &live.path)
                    {
                        eprintln!("chat: could not save {}: {e}", live.path.display());
                    }
                    let folder = live.path.parent().map(FsPath::to_owned);
                    let ended = live.ended.take().filter(|_| !live.removed);
                    (events, ended.zip(folder))
                };
                chats.emit(events);
                if let Some(((turn, point, before), folder)) = ended {
                    chats.keep_page(&id, folder, turn, point, before).await;
                }
            }
            let _ = reader.child.lock().await.wait().await;
            let last = errors.await.unwrap_or_default();
            chats.finish(&id, &reader, &last);
        });
    }
    /// A one-off Claude run in a canvas's folder that forks its session, so it knows the
    /// conversation, without adding to it. The caller gives it its prompt with `run_once`.
    fn one_off(&self, conversation: &Conversation, folder: &FsPath) -> anyhow::Result<Child> {
        let mut args: Vec<String> = [
            "-p",
            "--output-format",
            "json",
            "--resume",
            &conversation.session,
            "--fork-session",
            "--no-session-persistence",
        ]
        .map(String::from)
        .into();
        args.extend(self.agent_args(conversation)?);
        let command = AGENTS
            .iter()
            .find(|(id, _, _)| *id == agent_of(conversation))
            .map_or("claude", |(_, _, command)| *command);
        Ok(Command::new(apps::resolve_program(command)?)
            .args(&args)
            .current_dir(folder)
            .env_remove("CLAUDECODE")
            .env_remove("CLAUDE_CODE_ENTRYPOINT")
            .env_remove("CLAUDE_CODE_SESSION_ID")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()?)
    }
    /// Has Claude draw a canvas's icon, `icon.svg`, for the list; returns false when one is
    /// already being drawn or the canvas cannot be.
    fn draw_icon(&self, id: &str, conversation: &Conversation, folder: &FsPath) -> bool {
        if !claude_family(agent_of(conversation)) || conversation.session.is_empty() {
            return false;
        }
        {
            let mut icons = self.icons.lock().unwrap();
            if icons.contains_key(id) {
                return false;
            }
            icons.insert(id.to_owned(), None);
        }
        let child = match self.one_off(conversation, folder) {
            Ok(child) => child,
            Err(e) => {
                eprintln!("canvas: could not start drawing an icon: {e}");
                self.icons.lock().unwrap().remove(id);
                return false;
            }
        };
        let job = {
            let (chats, id) = (self.clone(), id.to_owned());
            tokio::spawn(async move {
                if let Err(e) = run_once(child, ICON_PROMPT).await {
                    eprintln!("canvas: could not draw an icon for {id}: {e}");
                }
                chats.icons.lock().unwrap().remove(&id);
                let mut events = vec![json!({"type":"icon","id":id})];
                chats.stamp(&mut events);
                chats.emit(events);
            })
        };
        if let Some(entry) = self.icons.lock().unwrap().get_mut(id) {
            *entry = Some(job.abort_handle());
        }
        true
    }
    /// Keeps a Canvas page as a turn left it, and tells the app which turns it can go back to.
    async fn keep_page(
        &self,
        id: &str,
        folder: PathBuf,
        turn: usize,
        mut point: crate::canvas::Point,
        before: u64,
    ) {
        let id = id.to_owned();
        // A canvas without an icon for the list gets one drawn once its turn is over.
        if !folder.join(ICON).is_file()
            && let Some(running) = self.get(&id)
        {
            let conversation = running.live.lock().unwrap().conversation.clone();
            self.draw_icon(&id, &conversation, &folder);
        }
        let events = tokio::task::spawn_blocking(move || {
            // A turn that changed the page made it for the screen its message came from.
            point.layout = crate::canvas::record_layout(&folder, &point.layout, before);
            if let Err(e) = crate::canvas::snapshot(&folder, turn, &point) {
                eprintln!("canvas: could not keep turn {turn}: {e}");
            }
            let turns = crate::canvas::turns(&folder);
            vec![
                json!({"type":"turns","id":id,"turns":turns}),
                page_event(&id, &folder),
            ]
        })
        .await;
        let mut events = events.unwrap_or_default();
        self.stamp(&mut events);
        self.emit(events);
    }
    /// Takes a Canvas session back to the end of an earlier turn, to continue from there: its
    /// page as it was then, its transcript up to then, and a fork of Claude's session. What came
    /// after is gone. Returns the conversation, ready to start, and where Claude resumes.
    async fn rewind(
        &self,
        id: &str,
        turn: usize,
        root: &FsPath,
    ) -> anyhow::Result<(Conversation, PathBuf, crate::canvas::Point)> {
        let (mut conversation, path) = match self.get(id) {
            Some(running) => {
                anyhow::ensure!(
                    !running.live.lock().unwrap().busy,
                    "Wait for the reply to finish before continuing from an earlier page"
                );
                self.restart(id)
                    .await
                    .ok_or_else(|| anyhow::anyhow!("The canvas changed; try again"))?
            }
            None => {
                let path = find(root, id)?;
                (load(&path)?, path)
            }
        };
        let folder = path.parent().unwrap_or(root).to_owned();
        let (point, turns) = tokio::task::spawn_blocking(move || {
            let point = crate::canvas::restore(&folder, turn)?;
            anyhow::Ok((point, crate::canvas::turns(&folder)))
        })
        .await??;
        conversation.entries.truncate(point.entries);
        crate::canvas::left(path.parent().unwrap_or(root), &conversation.session)?;
        conversation.session = uuid::Uuid::new_v4().to_string();
        conversation.updated = now();
        save(&conversation, &path)?;
        let folder = path.parent().unwrap_or(root);
        let mut events = vec![
            json!({"type":"rewound","id":id,"entries":conversation.entries.len(),"turns":turns}),
            page_event(id, folder),
        ];
        self.stamp(&mut events);
        self.emit(events);
        Ok((conversation, path, point))
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
        if let Some((_, Some(job))) = self.redrawing.lock().unwrap().remove(id) {
            job.abort();
        }
        if let Some(Some(job)) = self.icons.lock().unwrap().remove(id) {
            job.abort();
        }
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

/// What Claude is told in a Canvas session, on top of its own system prompt.
const CANVAS_BRIEF: &str = "You are Canvas: the person talks or types to you, and you answer by building the page they see.

The page is index.html in your working directory, shown full-screen in a sandboxed frame in the Omarchy Remote app on the person's phone, iPad, or computer. Scripts, forms, popups, and dialogs work there; same-origin storage (localStorage, cookies, IndexedDB) does not. Write the page with your file tools: the app reloads it as soon as a file changes. Put any other files it needs (CSS, scripts, images, data) beside it and link them with relative paths. Each turn, rewrite or edit index.html so it shows the best answer to the latest message, keeping earlier content only where it still helps.

Design whatever the moment calls for: a chart, a table, a timeline, a map, a comparison, a calculator, a step-by-step guide, a game, a document, an illustration. Nothing is off limits: load libraries, fonts, and images from anywhere on the web (for example Chart.js, D3, Three.js, Leaflet). Each message begins with a <canvas-context> block giving the screen's size and device and the app's current theme as CSS colors and fonts; use it so the page feels at home, or depart from it when the content is better served another way. Fit the given screen and make everything work by touch.

The page can answer for the person: parent.postMessage({ type: 'canvas', text: 'Show the vegetarian version' }, '*') arrives as their next message. Use it for buttons, choices, and forms that should continue the conversation.

Keep your text reply to one or two short sentences in plain speech, with no Markdown: it is shown as a subtitle and may be read aloud. Put the detail on the page. Each message's <canvas-context> ends with a design level: how much time to spend on the page's UI. How much to research comes from what the person asks. Get a useful page up early; search and fetch the web for anything current.";
/// What a one-off run is asked when a canvas needs an icon for the list.
const ICON_PROMPT: &str = "Draw an icon for this canvas as icon.svg in this folder: a square SVG that stands for what the conversation is about, shown small beside its title in the list of canvases. Leave every other file as it is. Reply with one short sentence.";
/// How much design work a Canvas page gets, chosen per canvas; each level's words go to Claude
/// with every message. They set how far to go, never a look.
const DESIGNS: [(&str, &str); 4] = [
    (
        "quick",
        "Design level: quick. Good design that mostly follows the built-in theme, well laid out but no custom elements or complicated UI.",
    ),
    (
        "medium",
        "Design level: medium. Make a well-organized, good-looking page with some custom elements and images where it makes sense.",
    ),
    (
        "detailed",
        "Design level: detailed. Go well beyond the basics in both content and presentation.",
    ),
    (
        "max",
        "Design level: maximum. Maximum information, maximum style in the UI.",
    ),
];
/// The words for a design level; an empty or unknown level is medium.
fn design_brief(level: &str) -> &'static str {
    DESIGNS
        .iter()
        .find(|(id, _)| *id == level)
        .unwrap_or(&DESIGNS[1])
        .1
}
/// When a Canvas session's page last changed: the newest file in its folder, other than its
/// transcript, in milliseconds.
fn page_version(folder: &FsPath) -> u64 {
    fn newest(dir: &FsPath, depth: u8) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .filter(|e| {
                let name = e.file_name();
                let name = name.to_string_lossy();
                // The list's icon is not part of the page.
                !name.starts_with('.') && name != FILE && name != ICON
            })
            .map(|e| match e.file_type() {
                Ok(t) if t.is_dir() && depth > 0 => newest(&e.path(), depth - 1),
                Ok(t) if t.is_file() => e
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_millis() as u64),
                _ => 0,
            })
            .max()
            .unwrap_or(0)
    }
    newest(folder, 3)
}
/// A Canvas page's state for the app: its version, whether it exists yet, the screen it was made
/// for, and the layouts redrawn from it as it is now.
fn page_event(id: &str, folder: &FsPath) -> Value {
    json!({
        "type": "page",
        "id": id,
        "version": page_version(folder),
        "page": folder.join("index.html").is_file(),
        "layout": crate::canvas::layouts(folder).made_for,
        "variants": crate::canvas::fresh(folder),
    })
}
/// The screen of the last message in a Claude session log that gave one.
fn infer_layout(log: &FsPath) -> Option<&'static str> {
    let text = fs::read_to_string(log).ok()?;
    // The context is JSON inside the message's JSON string, so its quotes are escaped.
    let device = regex::Regex::new(r#"\\"device\\":\s*\\"(\w+)\\""#).unwrap();
    text.lines()
        .rev()
        .filter(|line| line.contains("canvas-context"))
        .find_map(|line| device.captures(line))
        .map(|c| crate::canvas::layout_of(&c[1]))
}
/// The routes of a set of conversations, mounted at `/api/chat` for Chat and `/api/canvas` for
/// Canvas.
pub fn router<S: Clone + std::marker::Send + Sync + 'static>(chats: Chats) -> axum::Router<S> {
    use axum::routing::{get, post};
    axum::Router::new()
        .route("/", get(status))
        .route("/send", post(send))
        .route("/archive", post(archive))
        .route("/delete", post(delete))
        .route("/restore", post(restore))
        .route("/archived", get(archived))
        .route("/ws", get(upgrade))
        .route("/{id}", get(read))
        .route("/{id}/stop", post(stop))
        .route("/{id}/rename", post(rename))
        .route("/{id}/redraw", post(redraw))
        .route("/{id}/icon", post(icon))
        .route("/{id}/attachments/{name}", get(attachment))
        .route("/{id}/response", get(response))
        .route("/{id}/speech", post(speech))
        // A Canvas page and its files, for the frame that shows it.
        .route("/view/{id}/{token}/", get(view))
        .route("/view/{id}/{token}/{*path}", get(view))
        .with_state(chats)
}
pub async fn status(State(chats): State<Chats>) -> Result<Json<Value>, ApiError> {
    let root = chats.root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let agents = chats.installed();
    let running = chats.running.lock().unwrap();
    let chats: Vec<Value> = list(&root)
        .into_iter()
        .map(|mut chat| {
            let id = chat["id"].as_str().unwrap_or_default().to_owned();
            chat["busy"] = json!(
                running
                    .get(&id)
                    .is_some_and(|r| r.live.lock().unwrap().busy)
            );
            chats.add_icon(&mut chat);
            chat
        })
        .collect();
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
        "archived": chat_files(&root.join("archives")).len(),
    })))
}
/// The archive: chats moved out of the list, newest first, which can be restored or deleted.
pub async fn archived(State(chats): State<Chats>) -> Result<Json<Value>, ApiError> {
    let root = chats.root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let list: Vec<Value> = list(&root.join("archives"))
        .into_iter()
        .map(|mut chat| {
            chats.add_icon(&mut chat);
            chat
        })
        .collect();
    Ok(Json(json!({"chats": list})))
}

pub async fn read(
    State(chats): State<Chats>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if let Some(running) = chats.get(&id) {
        let live = running.live.lock().unwrap();
        let mut value = live.conversation.json();
        value["busy"] = json!(live.busy);
        value["folder"] = json!(live.path.parent().map(|d| d.to_string_lossy()));
        chats.describe_page(
            &mut value,
            &id,
            live.path.parent(),
            &live.conversation.session,
        );
        value["partial"] = json!(live.partial);
        value["seq"] = json!(live.seq);
        value["n"] = json!(chats.counter.load(Ordering::SeqCst));
        return Ok(Json(value));
    }
    let root = chats.root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let path = find(&root, &id)
        .map_err(|e| (StatusCode::NOT_FOUND, Json(json!({"error":e.to_string()}))))?;
    let conversation = load(&path).map_err(error)?;
    let mut value = conversation.json();
    value["folder"] = json!(path.parent().map(|d| d.to_string_lossy()));
    chats.describe_page(&mut value, &id, path.parent(), &conversation.session);
    value["busy"] = json!(false);
    value["partial"] = json!("");
    value["seq"] = json!(0);
    value["n"] = json!(chats.counter.load(Ordering::SeqCst));
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
    /// For Canvas: the screen and theme the page is shown with, given to the agent each message.
    #[serde(default)]
    context: Option<Value>,
    /// Paths returned by `/api/uploads/files`, moved into the chat's folder when sent.
    #[serde(default)]
    attachments: Vec<String>,
    /// For Canvas: the earlier turn to continue from, forgetting the turns after it.
    #[serde(default)]
    from: Option<usize>,
    /// For Canvas: the design level, one of `DESIGNS` (empty is medium); kept with the canvas.
    #[serde(default)]
    design: Option<String>,
}
pub async fn send(
    State(chats): State<Chats>,
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
    let chats = chats.clone();
    let root = chats.root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let agents = chats.installed();
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
    let design = match (&request.design, chats.kind) {
        (Some(level), Kind::Canvas) => {
            if !level.is_empty() && !DESIGNS.iter().any(|(id, _)| id == level) {
                return Err(refuse(StatusCode::BAD_REQUEST, "Unknown design level"));
            }
            Some(level.clone())
        }
        _ => None,
    };
    // Continuing from an earlier page starts Claude again, from that turn.
    let mut fork = None;
    let mut restarted = None;
    if let (Some(id), Some(turn), Kind::Canvas) = (request.id.as_deref(), request.from, chats.kind)
    {
        let (conversation, path, point) = chats
            .rewind(id, turn, &root)
            .await
            .map_err(|e| refuse(StatusCode::CONFLICT, &e.to_string()))?;
        restarted = Some((conversation, path));
        fork = Some(point);
    }
    // New settings, or the other agent of the Claude family, take effect by starting the agent
    // again; never in the middle of a reply. A Codex reply cannot take another message.
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
                        design: String::new(),
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
                canvas: chats.kind == Kind::Canvas,
                last_message: String::new(),
                ended: None,
                fork,
                turn_layout: String::new(),
                page_before: 0,
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
        if let Some(design) = design {
            live.conversation.design = design;
        }
        if chats.kind == Kind::Canvas {
            // A turn that changes the page makes it for the screen this message came from.
            live.page_before = crate::canvas::page_time(live.path.parent().unwrap_or(&root));
            live.turn_layout = request
                .context
                .as_ref()
                .and_then(|c| c["device"].as_str())
                .map_or("", crate::canvas::layout_of)
                .to_owned();
        }
        let (id, events, attachments) =
            add_message(&chats, &mut live, &text, &uploads, &root).map_err(error)?;
        let folder = live.path.parent().unwrap_or(&root).to_owned();
        let content = message_content(&text, &folder, &attachments);
        let content = match (&request.context, chats.kind) {
            (Some(context), Kind::Canvas) => {
                with_context(content, context, &live.conversation.design)
            }
            _ => content,
        };
        (id, events, content)
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

/// A Canvas message as the agent receives it: the screen and theme first, then the message.
fn with_context(content: Value, context: &Value, design: &str) -> Value {
    let mut described = serde_json::to_string_pretty(context).unwrap_or_default();
    if described.len() > 6000 {
        described = clip(&described, 6000);
    }
    let brief = design_brief(design);
    let block = format!("<canvas-context>\n{described}\n\n{brief}\n</canvas-context>");
    match content {
        Value::String(text) => json!(format!("{block}\n\n{text}")),
        Value::Array(mut blocks) => {
            blocks.insert(0, json!({"type":"text","text":block}));
            json!(blocks)
        }
        other => other,
    }
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
fn session_log(chats: &Chats, id: &str) -> anyhow::Result<(String, String, Option<PathBuf>, bool)> {
    let (conversation, path, busy) = match chats.get(id) {
        Some(running) => {
            let live = running.live.lock().unwrap();
            (live.conversation.clone(), live.path.clone(), live.busy)
        }
        None => {
            let path = find(&chats.root()?, id)?;
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
async fn voice_state(chats: &Chats, id: &str) -> anyhow::Result<Value> {
    let (agent, session, log, busy) = session_log(chats, id)?;
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
    State(chats): State<Chats>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(voice_state(&chats, &id).await.map_err(error)?))
}
pub async fn speech(
    State(chats): State<Chats>,
    Path(id): Path<String>,
    Json(request): Json<crate::voice::SpeechRequest>,
) -> Result<Response, ApiError> {
    let value = voice_state(&chats, &id).await.map_err(error)?;
    crate::voice::speak(&value, request).await
}

/// The type a Canvas page's file is served as, by its extension.
fn content_type(path: &str) -> &'static str {
    let extension = path
        .rsplit_once('.')
        .map_or("", |(_, e)| e)
        .to_ascii_lowercase();
    match extension.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json",
        "txt" | "md" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}
/// A Canvas page or one of its files, for the frame that shows it. The address is signed for the
/// session, as a frame cannot send the app's request header; only files in the session's folder
/// are served, and never its transcript or hidden files.
pub async fn view(
    State(chats): State<Chats>,
    Path(params): Path<HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let missing = || (StatusCode::NOT_FOUND, Json(json!({"error":"Not found"})));
    let id = params.get("id").cloned().unwrap_or_default();
    let token = params.get("token").cloned().unwrap_or_default();
    if chats.kind != Kind::Canvas || chats.view(&id) != format!("/api/canvas/view/{id}/{token}/") {
        return Err(missing());
    }
    let path = params.get("path").cloned().unwrap_or_default();
    let relative = if path.is_empty() || path.ends_with('/') {
        format!("{path}index.html")
    } else {
        path
    };
    if relative == FILE
        || relative
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.contains('\\'))
    {
        return Err(missing());
    }
    let transcript = match chats.get(&id) {
        Some(running) => running.live.lock().unwrap().path.clone(),
        None => {
            // An archived canvas still shows its icon in the archive.
            let root = chats.root().map_err(error)?;
            find(&root, &id)
                .or_else(|_| find(&root.join("archives"), &id))
                .map_err(|_| missing())?
        }
    };
    let mut folder = transcript.parent().ok_or_else(missing)?.to_owned();
    // `@3/…` is the page as turn 3 left it.
    let mut relative = relative;
    if let Some((first, rest)) = relative.split_once('/')
        && let Some(turn) = first.strip_prefix('@').and_then(|t| t.parse::<u32>().ok())
    {
        folder = crate::canvas::page(&folder, turn);
        relative = rest.to_owned();
    }
    let bytes = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
        let file = folder.join(&relative).canonicalize()?;
        anyhow::ensure!(file.starts_with(folder.canonicalize()?) && file.is_file());
        Ok(fs::read(file)?)
    })
    .await
    .map_err(error)?
    .map_err(|_| missing())?;
    let kind = content_type(params.get("path").map_or("index.html", |p| {
        if p.is_empty() || p.ends_with('/') {
            "index.html"
        } else {
            p
        }
    }));
    Ok(([(axum::http::header::CONTENT_TYPE, kind)], bytes).into_response())
}

/// A chat's attachment, for the app to show: `name` must be a file in its `attachments` folder.
pub async fn attachment(
    State(chats): State<Chats>,
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
    let path = match chats.get(&id) {
        Some(running) => running.live.lock().unwrap().path.clone(),
        None => {
            let root = chats.root().map_err(error)?;
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
/// Draws a canvas's icon for the list again, or for the first time.
pub async fn icon(
    State(chats): State<Chats>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if chats.kind != Kind::Canvas {
        return Err((StatusCode::NOT_FOUND, Json(json!({"error":"Not found"}))));
    }
    let (conversation, path) = match chats.get(&id) {
        Some(running) => {
            let live = running.live.lock().unwrap();
            (live.conversation.clone(), live.path.clone())
        }
        None => {
            let root = chats.root().map_err(error)?;
            let path = find(&root, &id)
                .map_err(|e| (StatusCode::NOT_FOUND, Json(json!({"error":e.to_string()}))))?;
            (load(&path).map_err(error)?, path)
        }
    };
    let folder = path.parent().map(FsPath::to_owned).unwrap_or_default();
    Ok(Json(
        json!({"drawing": chats.draw_icon(&id, &conversation, &folder)}),
    ))
}
#[derive(Deserialize)]
pub struct Redraw {
    /// The screen to redraw for: one of `canvas::LAYOUTS`.
    layout: String,
    /// The screen and theme, as a message sends them.
    #[serde(default)]
    context: Option<Value>,
}
/// Gives a one-off run its prompt and waits for it; returns the error it ended with, if any.
async fn run_once(mut child: Child, prompt: &str) -> Result<(), String> {
    if let Some(mut stdin) = child.stdin.take() {
        // Closing the input tells Claude the prompt is complete.
        let _ = stdin.write_all(prompt.as_bytes()).await;
    }
    let output = child.wait_with_output().await.map_err(|e| e.to_string())?;
    // The last line of output is the run's result.
    let result = String::from_utf8_lossy(&output.stdout)
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok());
    match result {
        Some(result) if result["is_error"] != true => Ok(()),
        Some(result) => Err(result["result"]
            .as_str()
            .unwrap_or("Claude stopped with an error")
            .to_owned()),
        None => Err("Claude stopped with an error".into()),
    }
}
/// Redraws a Canvas page for the other kind of screen, as `index.<layout>.html` beside it. A
/// one-off Claude run forks the canvas's session, so it knows what the page is for, without
/// adding to the conversation.
pub async fn redraw(
    State(chats): State<Chats>,
    Path(id): Path<String>,
    Json(request): Json<Redraw>,
) -> Result<Json<Value>, ApiError> {
    let refuse = |status: StatusCode, message: &str| (status, Json(json!({"error": message})));
    let layout = request.layout.clone();
    if chats.kind != Kind::Canvas || !crate::canvas::LAYOUTS.contains(&layout.as_str()) {
        return Err(refuse(StatusCode::BAD_REQUEST, "Unknown layout"));
    }
    let (conversation, path, busy) = match chats.get(&id) {
        Some(running) => {
            let live = running.live.lock().unwrap();
            (live.conversation.clone(), live.path.clone(), live.busy)
        }
        None => {
            let root = chats.root().map_err(error)?;
            let path =
                find(&root, &id).map_err(|e| refuse(StatusCode::NOT_FOUND, &e.to_string()))?;
            (load(&path).map_err(error)?, path, false)
        }
    };
    if busy {
        return Err(refuse(
            StatusCode::CONFLICT,
            "Wait for the reply to finish before redrawing",
        ));
    }
    if !claude_family(agent_of(&conversation)) || conversation.session.is_empty() {
        return Err(refuse(
            StatusCode::BAD_REQUEST,
            "This canvas cannot be redrawn",
        ));
    }
    let folder = path.parent().map(FsPath::to_owned).unwrap_or_default();
    let Some(from) = crate::canvas::page_hash(&folder) else {
        return Err(refuse(
            StatusCode::CONFLICT,
            "There is no page to redraw yet",
        ));
    };
    {
        let mut redrawing = chats.redrawing.lock().unwrap();
        if redrawing.contains_key(&id) {
            return Err(refuse(
                StatusCode::CONFLICT,
                "This page is already being redrawn",
            ));
        }
        redrawing.insert(id.clone(), (layout.clone(), None));
    }
    let screen = |layout: &str| {
        if layout == "phone" {
            "a phone"
        } else {
            "a wider screen (a tablet or computer)"
        }
    };
    let other = if layout == "phone" { "wide" } else { "phone" };
    let text = format!(
        "The page, index.html, was made for {}; this person is now looking at it on {}. Write a version of it for this screen as index.{layout}.html beside it: the same page, laid out and sized to work well here. Link the page's other files by the same relative paths, and leave index.html and every other file as it is. Reply with one short sentence.",
        screen(other),
        screen(&layout),
    );
    let prompt = with_context(
        json!(text),
        request.context.as_ref().unwrap_or(&json!({})),
        &conversation.design,
    );
    let prompt = prompt.as_str().unwrap_or(&text).to_owned();
    let child = match chats.one_off(&conversation, &folder) {
        Ok(child) => child,
        Err(e) => {
            chats.redrawing.lock().unwrap().remove(&id);
            return Err(error(format!("Claude could not start: {e}")));
        }
    };
    let mut events = vec![json!({"type":"redraw","id":id,"layout":layout,"state":"started"})];
    chats.stamp(&mut events);
    chats.emit(events);
    let job = {
        let (chats, id, layout) = (chats.clone(), id.clone(), layout.clone());
        tokio::spawn(async move {
            let failure = match run_once(child, &prompt).await {
                Err(e) => Some(e),
                Ok(()) if !folder.join(format!("index.{layout}.html")).is_file() => {
                    Some("Claude did not write the redrawn page".into())
                }
                Ok(()) => None,
            };
            if failure.is_none()
                && let Err(e) = crate::canvas::add_variant(&folder, &layout, &from)
            {
                eprintln!("canvas: could not note the redrawn page: {e}");
            }
            chats.redrawing.lock().unwrap().remove(&id);
            let mut events = vec![
                page_event(&id, &folder),
                json!({"type":"redraw","id":id,"layout":layout,"state":"done","error":failure}),
            ];
            chats.stamp(&mut events);
            chats.emit(events);
        })
    };
    if let Some(entry) = chats.redrawing.lock().unwrap().get_mut(&id) {
        entry.1 = Some(job.abort_handle());
    }
    Ok(Json(json!({"redrawing":layout})))
}
#[derive(Deserialize)]
pub struct Rename {
    title: String,
}
/// A title as typed, on one line with single spaces, if it is 1 to 200 characters.
fn new_title(text: &str) -> Option<String> {
    let title = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!title.is_empty() && title.chars().count() <= 200).then_some(title)
}
/// Renames a conversation; its folder keeps the name it was made with.
pub async fn rename(
    State(chats): State<Chats>,
    Path(id): Path<String>,
    Json(request): Json<Rename>,
) -> Result<Json<Value>, ApiError> {
    let Some(title) = new_title(&request.title) else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"A title is 1 to 200 characters"})),
        ));
    };
    let mut events = vec![json!({"type":"renamed","id":id,"title":title})];
    if let Some(running) = chats.get(&id) {
        let mut live = running.live.lock().unwrap();
        live.conversation.title = title;
        if !live.removed {
            save(&live.conversation, &live.path).map_err(error)?;
        }
        chats.stamp(&mut events);
    } else {
        let root = chats.root().map_err(error)?;
        let path = find(&root, &id)
            .map_err(|e| (StatusCode::NOT_FOUND, Json(json!({"error":e.to_string()}))))?;
        let mut conversation = load(&path).map_err(error)?;
        conversation.title = title;
        save(&conversation, &path).map_err(error)?;
        chats.stamp(&mut events);
    }
    chats.emit(events);
    Ok(Json(json!({"renamed":true})))
}
pub async fn stop(State(chats): State<Chats>, Path(id): Path<String>) -> Json<Value> {
    if let Some(running) = chats.get(&id) {
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
/// Moves a chat's folder into `parent`, with Claude's logs of its sessions so they can still be
/// resumed there; a name already taken there gains a number. Returns the new folder.
fn relocate(config: &FsPath, dir: &FsPath, parent: &FsPath) -> anyhow::Result<PathBuf> {
    let session = load(&dir.join(FILE))?.session;
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let mut target = parent.join(&name);
    let mut copy = 2;
    while fs::symlink_metadata(&target).is_ok() {
        target = parent.join(format!("{name}-{copy}"));
        copy += 1;
    }
    let sessions = sessions(dir, session);
    fs::rename(dir, &target)?;
    for session in sessions {
        move_session(config, dir, &target, &session);
    }
    Ok(target)
}
fn archive_dir(config: &FsPath, root: &FsPath, path: &FsPath) -> anyhow::Result<PathBuf> {
    let dir = chat_dir(root, path)?;
    let archives = root.join("archives");
    private_dir(&archives)?;
    relocate(config, &dir, &archives)
}
/// Brings an archived chat back to the list, with its sessions.
fn restore_dir(config: &FsPath, root: &FsPath, path: &FsPath) -> anyhow::Result<PathBuf> {
    let dir = chat_dir(&root.join("archives"), path)?;
    relocate(config, &dir, root)
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
    for session in sessions(&dir, session) {
        for file in claude_files(config, &dir, &session)? {
            remove(&file)?;
        }
    }
    remove(&dir)
}
/// A conversation's Claude sessions: its own, then any a canvas left behind by forking.
fn sessions(dir: &FsPath, session: String) -> Vec<String> {
    let mut sessions = vec![session];
    for left in crate::canvas::sessions(dir) {
        if uuid::Uuid::parse_str(&left).is_ok() && !sessions.contains(&left) {
            sessions.push(left);
        }
    }
    sessions
}

#[derive(Deserialize)]
pub struct Batch {
    ids: Vec<String>,
    /// Chats in the archive rather than the list: to delete, or to restore.
    #[serde(default)]
    archived: bool,
}
#[derive(Clone, Copy, PartialEq)]
enum Manage {
    Archive,
    Delete,
    Restore,
}
pub async fn archive(
    State(chats): State<Chats>,
    Json(batch): Json<Batch>,
) -> Result<Json<Value>, ApiError> {
    manage(&chats, batch.ids, Manage::Archive, false).await
}
pub async fn restore(
    State(chats): State<Chats>,
    Json(batch): Json<Batch>,
) -> Result<Json<Value>, ApiError> {
    manage(&chats, batch.ids, Manage::Restore, true).await
}
pub async fn delete(
    State(chats): State<Chats>,
    Json(batch): Json<Batch>,
) -> Result<Json<Value>, ApiError> {
    manage(&chats, batch.ids, Manage::Delete, batch.archived).await
}
async fn manage(
    chats: &Chats,
    ids: Vec<String>,
    action: Manage,
    archived: bool,
) -> Result<Json<Value>, ApiError> {
    if ids.is_empty() || ids.len() > 1000 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(json!({"error":"Choose between 1 and 1000 chats"})),
        ));
    }
    let root = chats.root().map_err(error)?;
    prepare(&root).map_err(error)?;
    let archives = root.join("archives");
    let (mut done, mut failed) = (Vec::new(), Vec::new());
    for id in ids {
        let path = match find(if archived { &archives } else { &root }, &id) {
            Ok(path) => path,
            Err(e) => {
                failed.push(json!({"id":id,"error":e.to_string()}));
                continue;
            }
        };
        chats.retire(&id).await;
        let result = claude_config().and_then(|config| match action {
            Manage::Delete if archived => delete_dir(&config, &archives, &path, &id),
            Manage::Delete => delete_dir(&config, &root, &path, &id),
            Manage::Archive => archive_dir(&config, &root, &path).map(|_| ()),
            Manage::Restore => restore_dir(&config, &root, &path).map(|_| ()),
        });
        match result {
            Ok(()) => done.push(id),
            Err(e) => failed.push(json!({"id":id,"error":e.to_string()})),
        }
    }
    let kind = if action == Manage::Restore {
        "restored"
    } else {
        "removed"
    };
    let mut events = vec![json!({"type":kind,"ids":done})];
    chats.stamp(&mut events);
    chats.emit(events);
    Ok(Json(json!({"done":done,"failed":failed})))
}

pub async fn upgrade(State(chats): State<Chats>, ws: WebSocketUpgrade) -> Response {
    ws.max_message_size(4096)
        .on_upgrade(move |socket| events(socket, chats))
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
            design: String::new(),
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
            canvas: false,
            last_message: String::new(),
            ended: None,
            fork: None,
            turn_layout: String::new(),
            page_before: 0,
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
    fn canvas_pages_are_versioned_typed_and_given_their_context() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            content_type("lib/chart.MJS"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(content_type("photo.webp"), "image/webp");
        assert_eq!(content_type("data"), "application/octet-stream");
        let context = json!({"screen":{"width":402,"height":874},"device":"phone"});
        let plain = with_context(json!("Plan my week"), &context, "");
        assert!(plain.as_str().unwrap().starts_with("<canvas-context>\n{"));
        assert!(
            plain
                .as_str()
                .unwrap()
                .ends_with("</canvas-context>\n\nPlan my week")
        );
        let blocks = with_context(
            json!([{"type":"image"},{"type":"text","text":"What is this?"}]),
            &context,
            "max",
        );
        assert_eq!(blocks[0]["type"], "text");
        assert!(
            blocks[0]["text"]
                .as_str()
                .unwrap()
                .contains("\"device\": \"phone\"")
        );
        assert_eq!(blocks[2]["text"], "What is this?");
        // The design level's words come with the context; no level is medium.
        assert!(plain.as_str().unwrap().contains("Design level: medium."));
        let text = blocks[0]["text"].as_str().unwrap();
        assert!(text.contains("Maximum information, maximum style in the UI."));
        assert!(text.ends_with("</canvas-context>"));
        assert_eq!(design_brief("unknown"), design_brief("medium"));
        // A canvas keeps its level in its front matter; a chat's file does not gain one.
        let mut conversation = sample();
        assert!(!conversation.to_markdown().contains("design:"));
        conversation.design = "detailed".into();
        let read = Conversation::parse(&conversation.to_markdown()).unwrap();
        assert_eq!(read.design, "detailed");
        // A page's version follows its files, not the transcript or hidden files.
        let dir = crate::dictation::AudioDir::new().unwrap();
        let folder = dir.0.join("session");
        fs::create_dir_all(folder.join("assets")).unwrap();
        assert_eq!(page_version(&folder), 0);
        fs::write(folder.join(FILE), "transcript").unwrap();
        fs::write(folder.join(".notes"), "hidden").unwrap();
        assert_eq!(page_version(&folder), 0);
        fs::write(folder.join("assets/app.js"), "go()").unwrap();
        let first = page_version(&folder);
        assert!(first > 0);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(folder.join("index.html"), "<h1>Hi</h1>").unwrap();
        assert!(page_version(&folder) > first);
        // The list's icon is not part of the page, so drawing it does not reload the page.
        let page = page_version(&folder);
        std::thread::sleep(Duration::from_millis(20));
        fs::write(folder.join(ICON), "<svg/>").unwrap();
        assert_eq!(page_version(&folder), page);
    }

    #[test]
    fn a_canvas_turn_ends_where_a_fork_can_continue() {
        let mut live = Live {
            conversation: Conversation {
                id: "c".into(),
                session: "s1".into(),
                entries: vec![Entry::new("user", "", "Plan dinner")],
                ..Conversation::default()
            },
            path: PathBuf::from("/tmp/canvas/chat.md"),
            busy: true,
            partial: String::new(),
            seq: 0,
            message: String::new(),
            used: Instant::now(),
            stopping: false,
            removed: false,
            started: Default::default(),
            failure: None,
            canvas: true,
            last_message: String::new(),
            ended: None,
            fork: None,
            turn_layout: String::new(),
            page_before: 0,
        };
        live.apply(&json!({"type":"assistant","uuid":"u1","parent_tool_use_id":null,"message":{"id":"m1","content":[{"type":"text","text":"Here it is."}]}}));
        // A subagent's messages are not where the conversation stands.
        live.apply(&json!({"type":"assistant","uuid":"sub","parent_tool_use_id":"t","message":{"id":"m2","content":[]}}));
        assert!(live.ended.is_none());
        live.apply(&json!({"type":"result","subtype":"success","result":"Here it is."}));
        let (turn, point, _) = live.ended.take().unwrap();
        assert_eq!(turn, 1);
        assert_eq!(
            point,
            crate::canvas::Point {
                session: "s1".into(),
                uuid: "u1".into(),
                entries: 2,
                layout: String::new(),
            }
        );
    }

    #[test]
    fn an_older_canvas_takes_the_screen_of_its_last_message() {
        let dir = crate::dictation::AudioDir::new().unwrap();
        let log = dir.0.join("session.jsonl");
        let message = |device: &str| {
            let context = serde_json::to_string_pretty(&json!({"device": device})).unwrap();
            json!({"type":"user","message":{"role":"user","content":format!("<canvas-context>\n{context}\n</canvas-context>\n\nHi")}})
                .to_string()
        };
        assert_eq!(infer_layout(&log), None);
        let lines = [
            message("tablet"),
            r#"{"type":"assistant"}"#.into(),
            message("phone"),
        ];
        fs::write(&log, lines.join("\n")).unwrap();
        assert_eq!(infer_layout(&log), Some("phone"));
        fs::write(&log, [message("phone"), message("computer")].join("\n")).unwrap();
        assert_eq!(infer_layout(&log), Some("wide"));
    }

    #[test]
    fn a_new_title_is_one_line_of_1_to_200_characters() {
        assert_eq!(
            new_title("  Weeknight\n dinners ").as_deref(),
            Some("Weeknight dinners")
        );
        assert_eq!(new_title(" \n "), None);
        assert_eq!(
            new_title(&"é".repeat(200)).map(|t| t.chars().count()),
            Some(200)
        );
        assert_eq!(new_title(&"a".repeat(201)), None);
        // Saved and read back, the title is what was set.
        let mut conversation = sample();
        conversation.title = new_title("Trip: \"Lisbon\"").unwrap();
        let dir = crate::dictation::AudioDir::new().unwrap();
        let path = dir.0.join(FILE);
        save(&conversation, &path).unwrap();
        assert_eq!(load(&path).unwrap().title, "Trip: \"Lisbon\"");
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
            canvas: false,
            last_message: String::new(),
            ended: None,
            fork: None,
            turn_layout: String::new(),
            page_before: 0,
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
    fn an_archived_chat_comes_back_with_its_files_and_sessions() {
        let dir = crate::dictation::AudioDir::new().unwrap();
        let (root, config) = (dir.0.join("Canvas"), dir.0.join("claude"));
        let conversation = sample();
        let name = "2026-10-03-plan-dinner-ideas-1b8ab544";
        let folder = new_dir(&root, name).unwrap();
        save(&conversation, &folder.join(FILE)).unwrap();
        write(&folder.join("index.html"), "<h1>Dinner</h1>");
        // A canvas that forked has an earlier session too.
        let earlier = "2d8ab544-8cc5-430e-8a40-0aec58bc3b10";
        crate::canvas::left(&folder, earlier).unwrap();
        write(&project(&config, &folder, &conversation.session), "log");
        write(&project(&config, &folder, earlier), "earlier log");
        let archived = archive_dir(&config, &root, &folder.join(FILE)).unwrap();
        assert_eq!(list(&root.join("archives")).len(), 1);
        // Only an archived chat can be restored.
        assert!(restore_dir(&config, &root, &folder.join(FILE)).is_err());
        let restored = restore_dir(&config, &root, &archived.join(FILE)).unwrap();
        assert_eq!(restored, folder);
        assert!(!archived.exists());
        assert!(list(&root.join("archives")).is_empty());
        assert_eq!(list(&root).len(), 1);
        assert!(restored.join("index.html").exists());
        for session in [conversation.session.as_str(), earlier] {
            assert!(project(&config, &restored, session).exists(), "{session}");
            assert!(!project(&config, &archived, session).exists(), "{session}");
        }
        // Deleting from the archive removes the folder and its sessions.
        let archived = archive_dir(&config, &root, &restored.join(FILE)).unwrap();
        delete_dir(
            &config,
            &root.join("archives"),
            &archived.join(FILE),
            &conversation.id,
        )
        .unwrap();
        assert!(!archived.exists());
        assert!(!project(&config, &archived, earlier).exists());
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
        // A session a canvas left behind by forking goes too.
        let earlier = "2d8ab544-8cc5-430e-8a40-0aec58bc3b10";
        crate::canvas::left(&folder, earlier).unwrap();
        let left = project(&config, &folder, earlier);
        write(&left, "earlier log");
        delete_dir(&config, &root, &path, &conversation.id).unwrap();
        assert!(!folder.exists());
        assert!(!left.exists());
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
