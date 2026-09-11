//! Browser adapters connect over a private local socket using native messaging.
use anyhow::{Result, bail};
use axum::{
    Json,
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
    sync::{mpsc, oneshot},
};
const LIMIT: usize = 4 * 1024 * 1024;
type Reply = oneshot::Sender<Value>;
struct Peer {
    snapshot: Value,
    send: mpsc::Sender<Value>,
}
#[derive(Default)]
struct Hub {
    peers: HashMap<String, Peer>,
    pending: HashMap<String, (String, Reply)>,
}
static HUB: OnceLock<Arc<Mutex<Hub>>> = OnceLock::new();
fn hub() -> &'static Arc<Mutex<Hub>> {
    HUB.get().expect("browser hub started")
}
fn socket_path() -> PathBuf {
    if let Some(path) = std::env::var_os("OMARCHY_BROWSER_SOCKET") {
        return PathBuf::from(path);
    }
    std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(format!("/run/user/{}", unsafe { libc::geteuid() })))
        .join("omarchy-remote-browser.sock")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
pub async fn start() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let path = socket_path();
    if path.exists() {
        if tokio::net::UnixStream::connect(&path).await.is_ok() {
            bail!("Browser bridge already running")
        }
        std::fs::remove_file(&path)?;
    }
    let listener = UnixListener::bind(path.clone())?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    let state = Arc::new(Mutex::new(Hub::default()));
    let _ = HUB.set(state.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if stream
                .peer_cred()
                .map(|c| c.uid() != unsafe { libc::geteuid() })
                .unwrap_or(true)
            {
                continue;
            }
            let state = state.clone();
            tokio::spawn(async move {
                let id = uuid::Uuid::new_v4().to_string();
                let (read, mut write) = stream.into_split();
                let mut read = BufReader::new(read);
                let (send, mut receive) = mpsc::channel::<Value>(32);
                let writer = tokio::spawn(async move {
                    while let Some(v) = receive.recv().await {
                        let mut data = serde_json::to_vec(&v).unwrap();
                        data.push(b'\n');
                        if write.write_all(&data).await.is_err() {
                            break;
                        }
                    }
                });
                loop {
                    let mut line = Vec::new();
                    let n = (&mut read)
                        .take((LIMIT + 1) as u64)
                        .read_until(b'\n', &mut line)
                        .await;
                    if !matches!(n,Ok(n) if n>0&&n<=LIMIT) {
                        break;
                    }
                    let Ok(v) = serde_json::from_slice::<Value>(&line) else {
                        break;
                    };
                    if v["type"] == "snapshot" {
                        if v["windows"].as_array().is_none() || v["profile_id"].as_str().is_none() {
                            break;
                        }
                        let mut snapshot = v;
                        snapshot["id"] = json!(id);
                        snapshot["connected"] = json!(true);
                        state.lock().unwrap().peers.insert(
                            id.clone(),
                            Peer {
                                snapshot,
                                send: send.clone(),
                            },
                        );
                    } else if v["type"] == "reply" {
                        if let Some(request) = v["id"].as_str() {
                            let mut h = state.lock().unwrap();
                            if h.pending
                                .get(request)
                                .is_some_and(|(owner, _)| owner == &id)
                            {
                                if let Some((_, reply)) = h.pending.remove(request) {
                                    let _ = reply.send(v.clone());
                                }
                            }
                        }
                    }
                }
                let mut h = state.lock().unwrap();
                h.peers.remove(&id);
                h.pending.retain(|_, (owner, _)| owner != &id);
                writer.abort();
            });
        }
    });
    Ok(())
}
pub async fn snapshot() -> Json<Value> {
    let h = hub().lock().unwrap();
    let mut instances = h
        .peers
        .values()
        .map(|p| p.snapshot.clone())
        .collect::<Vec<_>>();
    instances.sort_by_key(|v| {
        (
            v["label"].as_str().unwrap_or("").to_owned(),
            v["id"].as_str().unwrap_or("").to_owned(),
        )
    });
    Json(json!({"instances":instances}))
}
fn validate(peer: &Value, q: &Value) -> Result<()> {
    let action = q["action"].as_str().unwrap_or("");
    if !["create", "close", "focus", "reload", "pin", "mute", "move"].contains(&action) {
        bail!("Unknown browser action")
    }
    let windows = peer["windows"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Browser is not ready"))?;
    if action != "create" {
        let tab = q["tab_id"]
            .as_i64()
            .ok_or_else(|| anyhow::anyhow!("Choose a tab"))?;
        if !windows.iter().any(|w| {
            w["tabs"]
                .as_array()
                .is_some_and(|tabs| tabs.iter().any(|t| t["id"].as_i64() == Some(tab)))
        }) {
            bail!("Tab is no longer open; refresh the list")
        }
    }
    if action == "create" {
        let url = q["url"].as_str().unwrap_or("");
        if url.len() > 8192 || !(url.starts_with("https://") || url.starts_with("http://")) {
            bail!("Enter an http or https URL")
        }
    }
    if action == "move" || (action == "create" && !q["window_id"].is_null()) {
        if !windows.iter().any(|w| w["id"] == q["window_id"]) {
            bail!("Destination window is no longer open")
        }
    }
    if !q["workspace_id"].is_null() && peer["workspace_write"] != true {
        bail!(
            "This Vivaldi version supports workspace grouping, but not workspace changes through extensions"
        )
    }
    if !q["workspace_id"].is_null() && q["workspace_id"] != 0 {
        if !peer["workspaces"]
            .as_array()
            .is_some_and(|ws| ws.iter().any(|w| w["id"] == q["workspace_id"]))
        {
            bail!("Destination workspace is no longer available")
        }
    }
    Ok(())
}
pub async fn action(Json(mut q): Json<Value>) -> Response {
    let prepared = (|| -> Result<_> {
        let instance = q["instance_id"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Choose a browser"))?
            .to_owned();
        let mut h = hub().lock().unwrap();
        let peer = h
            .peers
            .get(&instance)
            .ok_or_else(|| anyhow::anyhow!("Browser disconnected"))?;
        validate(&peer.snapshot, &q)?;
        let send = peer.send.clone();
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        q["type"] = json!("command");
        q["id"] = json!(id);
        q["expires"] = json!(now() + 8000);
        if h.pending.len() >= 64 {
            bail!("Browser is busy; try again")
        }
        send.try_send(q.clone())
            .map_err(|_| anyhow::anyhow!("Browser is busy or disconnected"))?;
        h.pending.insert(id.clone(), (instance, tx));
        Ok((id, rx))
    })();
    let (id, rx) = match prepared {
        Ok(p) => p,
        Err(e) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({"error":e.to_string()})),
            )
                .into_response();
        }
    };
    let reply = tokio::time::timeout(std::time::Duration::from_secs(9), rx).await;
    hub().lock().unwrap().pending.remove(&id);
    match reply {
        Ok(Ok(v)) if v["ok"]==true => Json(json!({"ok":true,"result":v["result"]})).into_response(),
        Ok(Ok(v)) => (axum::http::StatusCode::BAD_REQUEST,Json(json!({"error":v["error"].as_str().unwrap_or("Browser action failed")}))).into_response(),
        _ => (axum::http::StatusCode::BAD_GATEWAY,Json(json!({"error":"Browser did not acknowledge the action. Refresh before trying again."}))).into_response()
    }
}
// Native messaging host: same Rust executable, stdio adapter only, no extra server.
pub fn native_bridge() -> Result<()> {
    use std::io::{BufRead, Read, Write};
    let stream = std::os::unix::net::UnixStream::connect(socket_path())?;
    let mut writer = stream.try_clone()?;
    let incoming = std::thread::spawn(move || -> Result<()> {
        let mut input = std::io::stdin().lock();
        loop {
            let mut length = [0u8; 4];
            if input.read_exact(&mut length).is_err() {
                break;
            }
            let n = u32::from_ne_bytes(length) as usize;
            if n > LIMIT {
                bail!("Browser message too large")
            }
            let mut bytes = vec![0; n];
            input.read_exact(&mut bytes)?;
            let mut v: Value = serde_json::from_slice(&bytes)?;
            if v["type"] == "snapshot" {
                // Read only workspace labels for the explicitly configured browser profile.
                v["workspaces"] = workspace_labels(
                    v["profile_folder"].as_str().unwrap_or("Default"),
                    &v["workspaces"],
                );
            }
            if v["type"] == "snapshot" {
                enrich_workspaces(&mut v);
            }
            serde_json::to_writer(&mut writer, &v)?;
            writer.write_all(b"\n")?;
        }
        let _ = writer.shutdown(std::net::Shutdown::Both);
        Ok(())
    });
    let mut output = std::io::stdout().lock();
    let mut reader = std::io::BufReader::new(&stream);
    loop {
        let mut line = Vec::new();
        let n = Read::take(&mut reader, (LIMIT + 1) as u64).read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        if n > LIMIT {
            bail!("Host message too large")
        }
        output.write_all(&(line.len() as u32).to_ne_bytes())?;
        output.write_all(&line)?;
        output.flush()?;
    }
    let _ = stream.shutdown(std::net::Shutdown::Both);
    // Browser stdin can remain open after server disconnect; exiting closes the port.
    drop(incoming);
    Ok(())
}
// Vivaldi 8 omits vivExtData from normal extension tab objects. Its session
// command 21 stores a Pickle of tab ID + JSON. Read only those metadata records;
// never use saved tabs as the source of truth for which tabs are open.
fn workspace_id(v: &Value) -> i64 {
    v.as_i64()
        .or_else(|| {
            v.as_f64()
                .filter(|n| n.is_finite() && n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0)
                .map(|n| n as i64)
        })
        .unwrap_or(0)
}
fn session_workspaces(bytes: &[u8]) -> HashMap<i64, Value> {
    let mut result = HashMap::new();
    if bytes.len() < 8
        || &bytes[..4] != b"SNSS"
        || ![1u32, 3].contains(&u32::from_le_bytes(bytes[4..8].try_into().unwrap()))
    {
        return result;
    }
    let mut at = 8;
    while at + 2 <= bytes.len() {
        let n = u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap()) as usize;
        at += 2;
        if n == 0 || at + n > bytes.len() {
            break;
        }
        let d = &bytes[at..at + n];
        at += n;
        if d[0] != 21 || d.len() < 13 {
            continue;
        }
        let id = i32::from_le_bytes(d[5..9].try_into().unwrap()) as i64;
        let len = u32::from_le_bytes(d[9..13].try_into().unwrap()) as usize;
        if len > d.len() - 13 {
            continue;
        }
        if let Ok(v) = serde_json::from_slice::<Value>(&d[13..13 + len]) {
            result.insert(id,json!({"workspace_id":workspace_id(&v["workspaceId"]),"stack_id":v["group"].as_str(),"fixed_title":v["fixedTitle"].as_str()}));
        }
    }
    result
}
fn profile_root(folder: &str) -> Option<PathBuf> {
    if folder != "Default"
        && !(folder.starts_with("Profile ")
            && folder.len() > 8
            && folder[8..].chars().all(|c| c.is_ascii_digit()))
    {
        return None;
    }
    let base = std::env::var_os("OMARCHY_VIVALDI_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config/vivaldi")
        });
    Some(base.join(folder))
}
fn enrich_workspaces(snapshot: &mut Value) {
    if snapshot["workspace_write"] == true {
        return;
    }
    let Some(root) = profile_root(snapshot["profile_folder"].as_str().unwrap_or("Default")) else {
        return;
    };
    let mut paths = std::fs::read_dir(root.join("Sessions"))
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("Session_"))
        .map(|e| e.path())
        .collect::<Vec<_>>();
    paths.sort();
    let mut metadata = HashMap::new();
    for path in paths
        .into_iter()
        .rev()
        .take(2)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
    {
        if std::fs::metadata(&path)
            .map(|m| m.len() > 16 * 1024 * 1024)
            .unwrap_or(true)
        {
            continue;
        }
        if let Ok(bytes) = std::fs::read(path) {
            metadata.extend(session_workspaces(&bytes));
        }
    }
    let mut found = Vec::new();
    if let Some(windows) = snapshot["windows"].as_array_mut() {
        for w in windows {
            if let Some(tabs) = w["tabs"].as_array_mut() {
                for tab in tabs {
                    if let Some(extra) = tab["id"].as_i64().and_then(|id| metadata.get(&id)) {
                        tab["workspace_id"] = extra["workspace_id"].clone();
                        tab["stack_id"] = extra["stack_id"].clone();
                        if let Some(title) = extra["fixed_title"].as_str() {
                            if !title.is_empty() {
                                tab["title"] = json!(title)
                            }
                        }
                        if let Some(id) = tab["workspace_id"].as_i64().filter(|id| *id != 0) {
                            found.push(id)
                        }
                    }
                }
            }
        }
    }
    if let Some(workspaces) = snapshot["workspaces"].as_array_mut() {
        for id in found {
            if !workspaces.iter().any(|w| w["id"] == id) {
                workspaces.push(json!({"id":id,"name":format!("Workspace {id}")}))
            }
        }
    }
}
fn workspace_labels(folder: &str, fallback: &Value) -> Value {
    let Some(root) = profile_root(folder) else {
        return fallback.clone();
    };
    let path = root.join("Preferences");
    let list = std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.pointer("/vivaldi/workspaces/list").cloned());
    let mut merged = fallback.as_array().cloned().unwrap_or_default();
    if let Some(Value::Array(list)) = list {
        for w in list {
            if w["id"].is_number() {
                let clean = json!({"id":workspace_id(&w["id"]),"name":w["name"].as_str().unwrap_or("Workspace")});
                if let Some(old) = merged.iter_mut().find(|x| x["id"] == clean["id"]) {
                    *old = clean
                } else {
                    merged.push(clean)
                }
            }
        }
    }
    json!(merged)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vivaldi_metadata_accepts_double_ids_and_partial_tail_without_exporting_navigation() {
        let text = br#"{"workspaceId":42.0,"group":"stack-a","urlForThumbnail":"not exported"}"#;
        let mut payload = vec![21];
        payload.extend_from_slice(&(8u32 + text.len() as u32).to_le_bytes());
        payload.extend_from_slice(&123i32.to_le_bytes());
        payload.extend_from_slice(&(text.len() as u32).to_le_bytes());
        payload.extend_from_slice(text);
        let mut bytes = b"SNSS".to_vec();
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
        bytes.extend_from_slice(&payload);
        bytes.extend_from_slice(&[100, 0, 21]);
        let result = session_workspaces(&bytes);
        assert_eq!(result[&123]["workspace_id"], 42);
        assert_eq!(result[&123]["stack_id"], "stack-a");
        assert!(result[&123].get("urlForThumbnail").is_none());
        assert!(session_workspaces(b"broken").is_empty());
    }
    #[test]
    fn actions_are_scoped_to_connected_instance_tabs_and_destinations() {
        let p = json!({"windows":[{"id":1,"tabs":[{"id":7}]}],"workspaces":[{"id":12}],"workspace_write":true});
        assert!(validate(&p, &json!({"action":"close","tab_id":7})).is_ok());
        assert!(validate(&p, &json!({"action":"close","tab_id":8})).is_err());
        assert!(validate(&p, &json!({"action":"move","tab_id":7,"window_id":2})).is_err());
        assert!(
            validate(
                &p,
                &json!({"action":"move","tab_id":7,"window_id":1,"workspace_id":13})
            )
            .is_err()
        );
        assert!(validate(&p, &json!({"action":"create","url":"javascript:alert(1)"})).is_err());
    }
}
