//! Muster: every Herdr agent thread on one board, grouped by project, so what needs the person
//! (a question, a finished turn) comes first without reading each pane. Threads stay in Herdr;
//! Muster only reads them, answers their questions, and sends messages, and a project can be
//! hidden from the board without closing anything.

use crate::{ApiError, App, apps, error, voice};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// One numbered choice of a menu an agent shows while it waits: a question, a permission, a plan.
#[derive(Debug, Clone, PartialEq)]
struct Choice {
    number: u32,
    label: String,
    detail: String,
    /// A multi-select choice's checkbox.
    checked: Option<bool>,
}
/// A menu on an agent's screen. Agents do not record a pending question in their logs (Claude
/// writes it only once answered), so the screen is the source: a block of numbered choices with
/// a cursor at the bottom of a blocked pane.
#[derive(Debug, Clone, PartialEq)]
struct Menu {
    question: String,
    /// What the question is about, such as the command a permission prompt would run.
    context: String,
    /// Claude's question tabs: `(label, answered)`; the last is `Submit` when there are several.
    tabs: Vec<(String, bool)>,
    choices: Vec<Choice>,
    /// The choice that takes typed text, such as Claude's `Type something`.
    other: Option<u32>,
}
impl Menu {
    fn multi(&self) -> bool {
        self.choices.iter().any(|c| c.checked.is_some())
    }
    fn id(&self) -> String {
        let key = json!([
            self.question,
            self.context,
            self.tabs,
            self.choices
                .iter()
                .map(|c| (&c.label, c.checked))
                .collect::<Vec<_>>()
        ]);
        format!("{:x}", Sha256::digest(key.to_string().as_bytes()))[..16].to_owned()
    }
    fn json(&self) -> Value {
        json!({
            "id": self.id(),
            "question": self.question,
            "context": self.context,
            "tabs": self.tabs.iter().map(|(label, done)| json!({"label":label,"done":done})).collect::<Vec<_>>(),
            "choices": self.choices.iter().map(|c| json!({"number":c.number,"label":c.label,"detail":c.detail,"checked":c.checked})).collect::<Vec<_>>(),
            "multi": self.multi(),
            "other": self.other,
        })
    }
}
fn separator(line: &str) -> bool {
    let line = line.trim();
    line.chars().count() >= 8 && line.chars().all(|c| matches!(c, '─' | '━' | '-' | '═'))
}
fn tab_row(line: &str) -> Option<Vec<(String, bool)>> {
    if !line.contains(['☐', '☒']) {
        return None;
    }
    let mut tabs: Vec<(String, bool)> = Vec::new();
    for c in line.chars() {
        match c {
            '☐' | '☒' | '✔' => tabs.push((String::new(), c != '☐')),
            '←' | '→' => {}
            c => {
                if let Some((label, _)) = tabs.last_mut() {
                    label.push(c);
                }
            }
        }
    }
    for (label, _) in &mut tabs {
        *label = label.trim().to_owned();
    }
    Some(tabs)
}
/// The menu at the bottom of a screen: the last run of choices numbered from 1, one of them
/// under the cursor, near the end of the screen. Numbered lists in the agent's prose above have
/// no cursor and are not at the bottom.
fn menu(screen: &str) -> Option<Menu> {
    let choice = regex::Regex::new(r"^\s*([❯›>]\s*)?(\d{1,2})\.\s+(.*?)\s*$").unwrap();
    let lines: Vec<&str> = screen.lines().collect();
    let end = lines.iter().rposition(|l| !l.trim().is_empty())? + 1;
    let start = end.saturating_sub(40);
    let numbered: Vec<(usize, u32, bool, String)> = (start..end)
        .filter_map(|i| {
            let m = choice.captures(lines[i])?;
            Some((i, m[2].parse().ok()?, m.get(1).is_some(), m[3].to_owned()))
        })
        .collect();
    // The latest 1 whose run counts up without gaps to the last numbered line.
    let first = (0..numbered.len()).rev().find(|&k| {
        numbered[k].1 == 1
            && numbered[k..]
                .iter()
                .enumerate()
                .all(|(j, n)| n.1 == j as u32 + 1)
    })?;
    let run = &numbered[first..];
    if run.len() < 2 || !run.iter().any(|n| n.2) || end - run.last()?.0 > 8 {
        return None;
    }
    let mut choices = Vec::new();
    for (k, (line, number, _, label)) in run.iter().enumerate() {
        let (checked, label) = match label.split_once("] ") {
            Some((mark, rest)) if mark.starts_with('[') && mark.chars().count() <= 3 => {
                (Some(mark.trim_start_matches('[').trim() != ""), rest.trim())
            }
            _ => (None, label.as_str()),
        };
        // Lines between this choice and the next describe it, as Claude's option details do.
        let next = run.get(k + 1).map_or(end, |n| n.0);
        let detail: Vec<&str> = lines[line + 1..next]
            .iter()
            .map(|l| l.trim())
            .take_while(|l| !l.is_empty())
            .filter(|l| !separator(l) && *l != "Submit")
            .collect();
        choices.push(Choice {
            number: *number,
            label: label.to_owned(),
            detail: detail.join(" "),
            checked,
        });
    }
    // Above the choices: the question, then what it is about, back to a rule or the tab row.
    let top = run[0].0;
    let block = lines[start..top]
        .iter()
        .rposition(|l| separator(l) || tab_row(l).is_some())
        .map_or(start, |i| start + i + 1);
    let tabs = (block > 0)
        .then(|| tab_row(lines[block - 1]))
        .flatten()
        .unwrap_or_default();
    let above: Vec<&str> = lines[block..top].iter().map(|l| l.trim_end()).collect();
    let above: Vec<&str> = above
        .iter()
        .rev()
        .skip_while(|l| l.trim().is_empty())
        .copied()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let split = above
        .iter()
        .rposition(|l| l.trim().is_empty())
        .map_or(0, |i| i + 1);
    let question = above[split..]
        .iter()
        .map(|l| l.trim())
        .collect::<Vec<_>>()
        .join(" ");
    let context = above[..split]
        .iter()
        .map(|l| l.trim())
        .skip_while(|l| l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned();
    let other = choices
        .iter()
        .find(|c| {
            c.label
                .trim_end_matches('.')
                .eq_ignore_ascii_case("type something")
        })
        .map(|c| c.number);
    Some(Menu {
        question,
        context,
        tabs,
        choices,
        other,
    })
}

fn hidden_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(apps::data_dir()?.join("muster.json"))
}
/// Projects hidden from the board, by Herdr workspace id (which Herdr keeps across restarts).
fn hidden() -> HashSet<String> {
    hidden_path()
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|v| serde_json::from_value(v["hidden"].clone()).ok())
        .unwrap_or_default()
}
fn save_hidden(ids: &HashSet<String>) -> anyhow::Result<()> {
    let path = hidden_path()?;
    let mut ids: Vec<&String> = ids.iter().collect();
    ids.sort();
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(&json!({"hidden":ids}))?)?;
    fs::rename(temp, path)?;
    Ok(())
}

/// What the board shows for a thread: `question` while it waits on the person, `ready` once a
/// turn has finished and not been looked at in Herdr, `working`, or `idle`.
fn state(status: &str, background: bool) -> &'static str {
    match status {
        "blocked" => "question",
        "working" => "working",
        _ if background => "working",
        "done" => "ready",
        _ => "idle",
    }
}
/// Which of a project's threads gives the project its state: a question first, then any work
/// still in progress, so a project with one tab working and another finished counts as working.
fn rank(state: &str) -> u8 {
    match state {
        "question" => 0,
        "working" => 1,
        "ready" => 2,
        _ => 3,
    }
}
fn clip(text: &str, limit: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let cut: String = text.chars().take(limit).collect();
    format!("{}…", cut.trim_end())
}
/// The latest thing the agent said: its answer when a turn is done, else its newest paragraph or
/// progress note. An answer to a message before the person's last one is not current, so a
/// thread just sent a message has nothing to show until the agent replies.
fn latest(thread: &Value) -> String {
    let working = thread["working"] == true;
    let last = |key: &str| {
        thread[key]
            .as_array()
            .and_then(|a| a.last())
            .and_then(|m| m["text"].as_str())
            .map(str::to_owned)
    };
    // The newest paragraph written since the person's message, as written.
    let progress = thread["turn_text"]
        .as_str()
        .and_then(|text| text.rsplit("\n\n").find(|p| !p.trim().is_empty()))
        .map(str::to_owned)
        .or_else(|| last("paragraphs"))
        .or_else(|| last("updates"));
    let answer = thread["answer"]["text"]
        .as_str()
        .filter(|_| thread["answered"] != false)
        .map(str::to_owned);
    if working {
        progress.or(answer)
    } else {
        answer.or(progress)
    }
    .unwrap_or_default()
}

type Cache = HashMap<String, (Instant, Value)>;
static THREADS: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// A pane's conversation, kept briefly: every open board asks every few seconds.
async fn conversation(app: &App, pane: &str, agent: &Value) -> Value {
    let key = format!("{pane}:{}", agent["terminal_id"]);
    if let Some((at, value)) = THREADS.lock().unwrap().get(&key)
        && at.elapsed() < Duration::from_secs(2)
    {
        return value.clone();
    }
    let value = match voice::thread(&app.herdr, pane, agent.clone()).await {
        Ok(value) => value,
        Err(e) => json!({"error": e.to_string()}),
    };
    let mut cache = THREADS.lock().unwrap();
    if cache.len() >= 256 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), value.clone()));
    value
}
/// One thread's summary; `full` keeps all of its prose for the thread view.
async fn summary(app: &App, pane: &Value, agent: &Value, tabs: &Value, full: bool) -> Value {
    let id = pane["pane_id"].as_str().unwrap_or_default();
    let status = pane["agent_status"].as_str().unwrap_or("unknown");
    let thread = conversation(app, id, agent).await;
    let background = pane["background"]
        .as_array()
        .or(thread["background"].as_array())
        .cloned()
        .unwrap_or_default();
    let state = state(status, !background.is_empty());
    let screen = if state == "question" {
        app.herdr.screen(id).await
    } else {
        String::new()
    };
    let question = menu(&screen);
    let tab = tabs
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["tab_id"] == pane["tab_id"]);
    let limit = if full { usize::MAX } else { 280 };
    let mut value = json!({
        "pane_id": id,
        "tab_id": pane["tab_id"],
        "tab": tab.map(|t| t["label"].clone()).unwrap_or(Value::Null),
        "agent": agent["agent"],
        "status": status,
        "state": state,
        "title": clip(thread["title"].as_str().unwrap_or_default(), 120),
        "prompt": clip(thread["prompt"].as_str().unwrap_or_default(), limit),
        "latest": clip(&latest(&thread), limit),
        "updated": thread["updated"],
        // Messages before the last one, which the thread view can summarize.
        "earlier": thread["prompts"].as_u64().unwrap_or(0).saturating_sub(1),
        // False once the person has sent a message the agent has not answered yet.
        "answered": thread["answered"] != false,
        "background": background,
        "question": question.as_ref().map(Menu::json),
        "error": thread["error"],
        "cwd": pane["foreground_cwd"].as_str().or(pane["cwd"].as_str()),
    });
    if full {
        value["paragraphs"] = thread["paragraphs"].clone();
        value["updates"] = thread["updates"].clone();
        value["answer"] = thread["answer"].clone();
        value["working"] = thread["working"].clone();
        value["turn_text"] = thread["turn_text"].clone();
        value["turn_parts"] = thread["turn_parts"].clone();
        // A wait Muster cannot read as a menu still shows what the agent has on screen.
        if state == "question" && question.is_none() {
            let lines: Vec<&str> = screen.trim_end().lines().collect();
            value["screen"] = json!(lines[lines.len().saturating_sub(24)..].join("\n"));
        }
    }
    value
}
fn agents(snapshot: &Value) -> HashMap<String, Value> {
    snapshot["agents"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|a| Some((a["pane_id"].as_str()?.to_owned(), a.clone())))
        .collect()
}

pub async fn board(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    let snapshot = app.herdr.snapshot().await.map_err(error)?;
    let agents = agents(&snapshot);
    let hidden = hidden();
    let panes: Vec<&Value> = snapshot["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            p["pane_id"]
                .as_str()
                .is_some_and(|id| agents.contains_key(id))
        })
        .collect();
    let threads = futures_util::future::join_all(panes.iter().map(|pane| {
        let agent = &agents[pane["pane_id"].as_str().unwrap_or_default()];
        summary(&app, pane, agent, &snapshot["tabs"], false)
    }))
    .await;
    let mut projects: Vec<Value> = snapshot["workspaces"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| {
            let id = w["workspace_id"].as_str()?;
            let mut mine: Vec<Value> = panes
                .iter()
                .zip(&threads)
                .filter(|(p, _)| p["workspace_id"] == id)
                .map(|(_, t)| t.clone())
                .collect();
            if mine.is_empty() {
                return None;
            }
            mine.sort_by_key(|t| rank(t["state"].as_str().unwrap_or_default()));
            let state = mine[0]["state"].clone();
            let updated = mine
                .iter()
                .filter_map(|t| t["updated"].as_str())
                .max()
                .map(str::to_owned);
            Some(json!({
                "workspace_id": id,
                "label": w["label"],
                "hidden": hidden.contains(id),
                "state": state,
                "updated": updated,
                "threads": mine,
            }))
        })
        .collect();
    // What needs the person first, then the most recently active.
    projects.sort_by(|a, b| {
        rank(a["state"].as_str().unwrap_or_default())
            .cmp(&rank(b["state"].as_str().unwrap_or_default()))
            .then_with(|| {
                b["updated"]
                    .as_str()
                    .unwrap_or_default()
                    .cmp(a["updated"].as_str().unwrap_or_default())
            })
    });
    Ok(Json(json!({"projects": projects})))
}

async fn pane_of(app: &App, id: &str) -> Result<(Value, Value, Value), ApiError> {
    let snapshot = app.herdr.snapshot().await.map_err(error)?;
    let agent = agents(&snapshot).remove(id).ok_or_else(|| {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"No agent runs in this pane"})),
        )
    })?;
    let pane = snapshot["panes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["pane_id"] == id)
        .cloned()
        .unwrap_or_default();
    Ok((pane, agent, snapshot["tabs"].clone()))
}
pub async fn thread(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (pane, agent, tabs) = pane_of(&app, &id).await?;
    Ok(Json(summary(&app, &pane, &agent, &tabs, true).await))
}

fn conflict(message: &str) -> ApiError {
    (StatusCode::CONFLICT, Json(json!({"error":message})))
}
fn invalid(message: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, Json(json!({"error":message})))
}
async fn typed(app: &App, pane: &str, text: &str, keys: &[&str]) -> Result<(), ApiError> {
    let keys: Vec<String> = keys.iter().map(|k| (*k).to_owned()).collect();
    app.herdr
        .input(pane, text, &keys, true)
        .await
        .map_err(error)?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    Ok(())
}

#[derive(Deserialize)]
pub struct Answer {
    /// The menu being answered, as the board showed it.
    menu: String,
    /// Choices to pick, or for a multi-select menu, every choice that should be checked.
    #[serde(default)]
    choose: Vec<u32>,
    /// Typed text for the menu's `Type something` choice.
    #[serde(default)]
    text: Option<String>,
}
/// Answers the menu on a pane's screen with the keys the agent expects: a choice's number picks
/// it (and toggles it in a multi-select menu), Tab moves on to the next question or Submit, and
/// typed text goes to the `Type something` choice. Nothing is sent unless the screen still shows
/// the menu the person answered.
pub async fn answer(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(request): Json<Answer>,
) -> Result<Json<Value>, ApiError> {
    let current =
        menu(&app.herdr.screen(&id).await).ok_or_else(|| conflict("The question was answered"))?;
    if current.id() != request.menu {
        return Err(conflict("The question changed; check it again"));
    }
    let known = |n: &u32| current.choices.iter().any(|c| c.number == *n) && *n <= 9;
    if !request.choose.iter().all(known) {
        return Err(invalid("No such choice"));
    }
    if let Some(text) = request.text.as_deref().map(str::trim) {
        let other = current
            .other
            .filter(|_| !current.multi())
            .ok_or_else(|| invalid("This question takes no typed answer"))?;
        if text.is_empty() || text.len() > 4096 || text.contains(['\n', '\r']) {
            return Err(invalid("Type a one-line answer"));
        }
        typed(&app, &id, &other.to_string(), &[]).await?;
        typed(&app, &id, text, &["Enter"]).await?;
    } else if current.multi() {
        for choice in &current.choices {
            let wanted = request.choose.contains(&choice.number);
            if choice.checked.is_some_and(|checked| checked != wanted) {
                typed(&app, &id, &choice.number.to_string(), &[]).await?;
            }
        }
        if current.tabs.iter().any(|(label, _)| label == "Submit") {
            typed(&app, &id, "", &["Tab"]).await?;
        }
    } else {
        let [number] = request.choose[..] else {
            return Err(invalid("Pick one choice"));
        };
        typed(&app, &id, &number.to_string(), &[]).await?;
    }
    // The next question, or none once the agent continues.
    tokio::time::sleep(Duration::from_millis(400)).await;
    THREADS
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with(&format!("{id}:")));
    let next = menu(&app.herdr.screen(&id).await);
    Ok(Json(json!({"question": next.as_ref().map(Menu::json)})))
}

#[derive(Deserialize)]
pub struct Keys {
    keys: Vec<String>,
}
/// Keys for a wait Muster cannot read as a menu, such as a folder-trust prompt.
pub async fn keys(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(request): Json<Keys>,
) -> Result<Json<Value>, ApiError> {
    const NAMED: [&str; 7] = ["Up", "Down", "Left", "Right", "Enter", "Escape", "Tab"];
    if request.keys.is_empty() || request.keys.len() > 8 {
        return Err(invalid("Send one to eight keys"));
    }
    for key in &request.keys {
        if NAMED.contains(&key.as_str()) {
            typed(&app, &id, "", &[key]).await?;
        } else if key.len() == 1 && key.as_bytes()[0].is_ascii_digit() {
            typed(&app, &id, key, &[]).await?;
        } else {
            return Err(invalid("Unsupported key"));
        }
    }
    Ok(Json(json!({"type":"ok"})))
}

#[derive(Deserialize)]
pub struct Message {
    text: String,
}
/// A message to the agent, as Herdr's Send pastes it. While the agent waits on a question the
/// text would land in its menu, so it must be answered first.
pub async fn send(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(request): Json<Message>,
) -> Result<Json<Value>, ApiError> {
    let text = request.text.trim();
    if text.is_empty() || text.len() > 16384 {
        return Err(invalid("The message is empty or too long"));
    }
    let (pane, _, _) = pane_of(&app, &id).await?;
    if pane["agent_status"] == "blocked" {
        return Err(conflict("Answer the agent's question first"));
    }
    app.herdr
        .input(&id, text, &["Enter".into()], false)
        .await
        .map_err(error)?;
    THREADS
        .lock()
        .unwrap()
        .retain(|key, _| !key.starts_with(&format!("{id}:")));
    Ok(Json(json!({"type":"ok"})))
}

/// What came before the person's last message, as the text a summary is made from: each turn
/// labeled, long messages shortened, and the oldest dropped past a limit (keeping the first
/// request, which usually names the goal). Empty when the last message is the only one.
fn recap_source(exchanges: &[(bool, String)]) -> String {
    let Some(last) = exchanges.iter().rposition(|(person, _)| *person) else {
        return String::new();
    };
    let earlier: Vec<String> = exchanges[..last]
        .iter()
        .map(|(person, text)| {
            format!(
                "{}: {}",
                if *person { "Person" } else { "Agent" },
                clip(text, 3000)
            )
        })
        .collect();
    let mut kept: Vec<&String> = Vec::new();
    let mut size = earlier.first().map_or(0, String::len);
    for turn in earlier.iter().skip(1).rev() {
        if size + turn.len() > 60_000 {
            break;
        }
        size += turn.len();
        kept.push(turn);
    }
    kept.reverse();
    let mut parts: Vec<&str> = earlier.first().map(String::as_str).into_iter().collect();
    if kept.len() + 1 < earlier.len() {
        parts.push("[Earlier turns omitted]");
    }
    parts.extend(kept.iter().map(|s| s.as_str()));
    parts.join("\n\n")
}
const RECAP_PROMPT: &str = "You write recaps of conversations between a person and a coding agent, so the person can pick a thread back up after time away. You are not a participant: never continue the conversation, answer it, or speak as the agent.";
const RECAP_REQUEST: &str = "Recap the transcript above for the person, writing to them (\"You asked…\"): the goal, what was decided and done, and what is still open. Their latest message is not included. Hard limit: 80 words. No heading, no preamble; at most two short paragraphs or four bullets, in Markdown. Reply with the recap only.";
static RECAPS: LazyLock<Mutex<Option<HashMap<String, String>>>> =
    LazyLock::new(|| Mutex::new(None));
static SUMMARIZING: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
fn recaps_path() -> anyhow::Result<std::path::PathBuf> {
    Ok(apps::data_dir()?.join("muster-summaries.json"))
}
/// Summaries already made, by the hash of what they summarize, so a thread is summarized again
/// only once it has a new turn.
fn cached_recap(key: &str) -> Option<String> {
    let mut recaps = RECAPS.lock().unwrap();
    let recaps = recaps.get_or_insert_with(|| {
        recaps_path()
            .ok()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    });
    recaps.get(key).cloned()
}
fn save_recap(key: String, summary: String) -> anyhow::Result<()> {
    let mut recaps = RECAPS.lock().unwrap();
    let recaps = recaps.get_or_insert_with(HashMap::new);
    if recaps.len() >= 300 {
        recaps.clear();
    }
    recaps.insert(key, summary);
    let path = recaps_path()?;
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec(&*recaps)?)?;
    fs::rename(temp, path)?;
    Ok(())
}
/// Runs Claude Code once, without tools or a saved session, to summarize `source`.
async fn summarize(source: &str) -> anyhow::Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let model = std::env::var("OMARCHY_MUSTER_SUMMARY_MODEL").unwrap_or_else(|_| "haiku".into());
    let mut child = tokio::process::Command::new(apps::resolve_program("claude")?)
        .args(["-p", "--no-session-persistence", "--tools", ""])
        // No MCP servers: starting them took most of a summary's time. (`--bare` would skip more,
        // but also the stored Claude login, which is all the service has.)
        .arg("--strict-mcp-config")
        // A recap needs no thinking, which otherwise was most of its output and its time.
        .env("MAX_THINKING_TOKENS", "0")
        .args(["--output-format", "json", "--model"])
        .arg(model)
        .arg("--system-prompt")
        .arg(RECAP_PROMPT)
        // Away from any project, so no project instructions are read.
        .current_dir(std::env::temp_dir())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    // The transcript is quoted, with the request after it, so it reads as material to recap
    // rather than a conversation to join.
    let message = format!("<transcript>\n{source}\n</transcript>\n\n{RECAP_REQUEST}");
    tokio::time::timeout(Duration::from_secs(120), async move {
        stdin.write_all(message.as_bytes()).await?;
        drop(stdin);
        let (mut output, mut errors) = (String::new(), String::new());
        tokio::try_join!(
            stdout.read_to_string(&mut output),
            stderr.read_to_string(&mut errors)
        )?;
        let ok = child.wait().await?.success();
        // Only the JSON result counts; a version manager may print a line before it.
        let result = output
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str::<Value>(line).ok())
            .unwrap_or_default();
        if !ok || result["is_error"] == true {
            let detail = result["result"].as_str().unwrap_or(errors.trim());
            eprintln!("muster: summary failed: {}", clip(detail, 500));
            anyhow::bail!("The summary could not be made");
        }
        let summary = result["result"].as_str().unwrap_or_default().trim();
        anyhow::ensure!(!summary.is_empty(), "The summary came back empty");
        Ok(summary.to_owned())
    })
    .await
    .map_err(|_| anyhow::anyhow!("The summary took too long"))?
}
/// A summary of the thread before the person's last message, made when they ask for it.
pub async fn recap(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (_, agent, _) = pane_of(&app, &id).await?;
    let (name, path, _) = voice::session_log(&app.herdr, &id, &agent)
        .await
        .map_err(error)?;
    let source = tokio::task::spawn_blocking(move || {
        voice::exchanges(&name, &path).map(|exchanges| recap_source(&exchanges))
    })
    .await
    .map_err(error)?
    .map_err(error)?;
    if source.is_empty() {
        return Ok(Json(json!({"summary": null})));
    }
    // A changed request makes new summaries rather than reusing old ones.
    let request = format!("{RECAP_PROMPT}{RECAP_REQUEST}{source}");
    let key = format!("{:x}", Sha256::digest(request.as_bytes()))[..24].to_owned();
    if let Some(summary) = cached_recap(&key) {
        return Ok(Json(json!({"summary": summary, "cached": true})));
    }
    let _permit = SUMMARIZING.acquire().await.map_err(error)?;
    if let Some(summary) = cached_recap(&key) {
        return Ok(Json(json!({"summary": summary, "cached": true})));
    }
    let summary = summarize(&source).await.map_err(error)?;
    save_recap(key, summary.clone()).map_err(error)?;
    Ok(Json(json!({"summary": summary, "cached": false})))
}

#[derive(Deserialize)]
pub struct Hide {
    workspace_id: String,
    hidden: bool,
}
static HIDING: Mutex<()> = Mutex::new(());
/// Hides a project from the board, or brings it back. Herdr keeps the project as it is.
pub async fn hide(Json(request): Json<Hide>) -> Result<Json<Value>, ApiError> {
    if request.workspace_id.is_empty() || request.workspace_id.len() > 128 {
        return Err(invalid("Invalid project"));
    }
    let _lock = HIDING.lock().unwrap();
    let mut ids = hidden();
    if request.hidden {
        ids.insert(request.workspace_id);
    } else {
        ids.remove(&request.workspace_id);
    }
    save_hidden(&ids).map_err(error)?;
    Ok(Json(json!({"hidden": ids.len()})))
}

#[cfg(test)]
mod tests {
    use super::*;

    const QUESTIONS: &str = "\
❯ Use the AskUserQuestion tool to ask me two questions at once
────────────────────────────────────────────────────────────────
←  ☐ Color  ☐ Fruits  ✔ Submit  →

Which color do you prefer?

❯ 1. Red
     A warm, vibrant color
  2. Green
     A cool, natural color
  3. Blue
     A calm, peaceful color
  4. Type something.
────────────────────────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
";

    #[test]
    fn a_question_on_screen_becomes_a_menu() {
        let menu = menu(QUESTIONS).unwrap();
        assert_eq!(menu.question, "Which color do you prefer?");
        assert_eq!(
            menu.tabs,
            vec![
                ("Color".into(), false),
                ("Fruits".into(), false),
                ("Submit".into(), true)
            ]
        );
        let labels: Vec<&str> = menu.choices.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Red", "Green", "Blue", "Type something.", "Chat about this"]
        );
        assert_eq!(menu.choices[1].detail, "A cool, natural color");
        assert_eq!(menu.choices[3].detail, "");
        assert_eq!(menu.other, Some(4));
        assert!(!menu.multi());
        assert_eq!(menu.id(), super::menu(QUESTIONS).unwrap().id());
    }

    #[test]
    fn multi_select_choices_carry_their_checkboxes() {
        let screen = "\
←  ☒ Color  ☒ Fruits  ✔ Submit  →

Which fruits do you like?

❯ 1. [✔] Apple
         A crisp, sweet fruit
  2. [ ] Pear
         A juicy, smooth fruit
  3. [✔] Plum
         A tart, flavorful fruit
  4. [ ] Type something
     Submit
────────────────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel";
        let menu = menu(screen).unwrap();
        assert!(menu.multi());
        let checked: Vec<Option<bool>> = menu.choices.iter().map(|c| c.checked).collect();
        assert_eq!(
            checked,
            [Some(true), Some(false), Some(true), Some(false), None]
        );
        assert_eq!(menu.choices[2].label, "Plum");
        // "Submit" is not part of the last choice's description.
        assert_eq!(menu.choices[3].detail, "");
        assert_eq!(menu.question, "Which fruits do you like?");
        // Checking another choice is a different menu, so a stale answer is refused.
        assert_ne!(
            menu.id(),
            super::menu(&screen.replace("2. [ ]", "2. [✔]"))
                .unwrap()
                .id()
        );
    }

    #[test]
    fn a_permission_prompt_names_what_it_would_run() {
        let screen = "\
● Creating a file at /tmp/probe/ok.txt
  ⎿  $ touch /tmp/probe/ok.txt

────────────────────────────────────────────
 Bash command

   touch /tmp/probe/ok.txt
   Create a file at /tmp/probe/ok.txt

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/probe from this project
   3. No

 Esc to cancel · Tab to amend";
        let menu = menu(screen).unwrap();
        assert_eq!(menu.question, "Do you want to proceed?");
        assert_eq!(
            menu.context,
            "Bash command\n\ntouch /tmp/probe/ok.txt\nCreate a file at /tmp/probe/ok.txt"
        );
        assert_eq!(menu.choices.len(), 3);
        assert_eq!(menu.other, None);
        assert!(menu.tabs.is_empty());
    }

    #[test]
    fn numbered_prose_and_prompts_without_numbers_are_not_menus() {
        // An agent's own numbered list has no cursor.
        assert_eq!(
            menu("Plan:\n1. Read the code\n2. Fix the bug\n\n❯ \n"),
            None
        );
        // Only the run at the bottom counts: earlier prose is above it.
        let screen = format!("Steps:\n1. One\n2. Two\n3. Three\n{QUESTIONS}");
        assert_eq!(super::menu(&screen).unwrap().choices.len(), 5);
        // A choice list far above the end of the screen is not the current wait.
        let stale = format!("{QUESTIONS}{}", "output\n".repeat(12));
        assert_eq!(menu(&stale), None);
        // Claude's folder-trust prompt has no numbers; the board shows its screen instead.
        assert_eq!(
            menu(" ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel"),
            None
        );
    }

    #[test]
    fn a_recap_covers_what_came_before_the_last_message() {
        let turns = |list: &[(bool, &str)]| -> Vec<(bool, String)> {
            list.iter().map(|(p, t)| (*p, (*t).to_owned())).collect()
        };
        assert_eq!(recap_source(&turns(&[(true, "Only message")])), "");
        assert_eq!(recap_source(&[]), "");
        let source = recap_source(&turns(&[
            (true, "Build a taxi game"),
            (false, "Done: a basic taxi game."),
            (true, "Add rain"),
            (false, "Rain is in."),
            (true, "Now make it night"),
            (false, "Working on night…"),
        ]));
        assert_eq!(
            source,
            "Person: Build a taxi game\n\nAgent: Done: a basic taxi game.\n\nPerson: Add rain\n\nAgent: Rain is in."
        );
        // A long history keeps the first request and the latest turns.
        let mut long = vec![(true, "The goal".to_owned())];
        for i in 0..40 {
            long.push((false, format!("Reply {i} {}", "x".repeat(2900))));
        }
        long.push((true, "Latest".to_owned()));
        let source = recap_source(&long);
        assert!(source.starts_with("Person: The goal\n\n[Earlier turns omitted]\n\nAgent: Reply"));
        assert!(source.ends_with(&format!("Agent: Reply 39 {}", "x".repeat(2900))));
        assert!(source.len() < 64_000);
    }

    #[test]
    fn threads_are_ranked_by_what_needs_the_person() {
        assert_eq!(state("blocked", false), "question");
        assert_eq!(state("done", false), "ready");
        assert_eq!(state("done", true), "working");
        assert_eq!(state("idle", true), "working");
        assert_eq!(state("idle", false), "idle");
        assert!(rank("question") < rank("working") && rank("working") < rank("ready"));
        assert!(rank("ready") < rank("idle"));
        assert_eq!(clip("  short  ", 10), "short");
        assert_eq!(clip("a long sentence here", 6), "a long…");
        let working = json!({"working":true,"answer":{"text":"Old answer"},"paragraphs":[{"text":"First"},{"text":"Now this"}]});
        assert_eq!(latest(&working), "Now this");
        let done = json!({"working":false,"answer":{"text":"Done: all fixed"},"paragraphs":[{"text":"Now this"}]});
        assert_eq!(latest(&done), "Done: all fixed");
        // The answer to an earlier message is not the latest once the person writes again.
        let asked = json!({"working":true,"answered":false,"answer":{"text":"Done: all fixed"},"paragraphs":[]});
        assert_eq!(latest(&asked), "");
        let replying = json!({"working":true,"answered":false,"answer":{"text":"Done: all fixed"},"paragraphs":[{"text":"On it"}]});
        assert_eq!(latest(&replying), "On it");
        let written = json!({"working":true,"answered":false,"turn_text":"First **step**.\n\nSecond `step`.","paragraphs":[{"text":"Second step."}]});
        assert_eq!(latest(&written), "Second `step`.");
    }
}
