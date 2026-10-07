use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    process::Command,
    time::timeout,
};

/// Lines sent while following a pane, and while reading its history (Herdr's read maximum).
pub const PANE_LINES: u32 = 300;
pub const HISTORY_LINES: u32 = 1000;

#[derive(Clone)]
pub struct Herdr {
    pub path: PathBuf,
}
impl Herdr {
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        timeout(Duration::from_secs(5), async {
            let mut stream = UnixStream::connect(&self.path).await?;
            let request = json!({"id": "omarchy-remote", "method": method, "params": params});
            stream.write_all(format!("{request}\n").as_bytes()).await?;
            let mut reader = BufReader::new(stream).take(4 * 1024 * 1024);
            let mut line = String::new();
            reader.read_line(&mut line).await?;
            let response: Value = serde_json::from_str(&line)?;
            if let Some(error) = response.get("error") {
                bail!(
                    "Herdr: {}",
                    error["message"].as_str().unwrap_or("request failed")
                );
            }
            response
                .get("result")
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Missing Herdr result"))
        })
        .await?
    }
    pub async fn snapshot(&self) -> Result<Value> {
        let (snapshot, inventory) = tokio::join!(
            self.call("session.snapshot", json!({})),
            self.call("agent.list", json!({}))
        );
        let mut snapshot = snapshot?["snapshot"].clone();
        // Activity sequence is authoritative across panes; pane revisions are not.
        if let (Some(panes), Ok(inventory)) = (snapshot["panes"].as_array_mut(), inventory)
            && let Some(agents) = inventory["agents"].as_array()
        {
            for pane in panes {
                if let Some(agent) = agents.iter().find(|a| {
                    a["pane_id"] == pane["pane_id"] && a["terminal_id"] == pane["terminal_id"]
                }) && let Some(sequence) = agent["state_change_seq"].as_u64()
                {
                    pane["state_change_seq"] = json!(sequence);
                }
            }
        }
        crate::voice::annotate(self, &mut snapshot).await;
        Ok(snapshot)
    }
    /// The last `lines` lines of a pane; Herdr returns at most 1000 whatever is asked.
    pub async fn read_lines(&self, pane: &str, lines: u32) -> Result<Value> {
        Ok(self.call("pane.read", json!({"pane_id":pane,"source":"recent","lines":lines,"format":"ansi","strip_ansi":false})).await?["read"].clone())
    }
    pub async fn read(&self, pane: &str) -> Result<Value> {
        self.read_lines(pane, PANE_LINES).await
    }
    /// The pane's visible screen as plain text. The ANSI read stays fast for full-screen panes,
    /// where Herdr's plain-text read can take seconds.
    pub async fn screen(&self, pane: &str) -> String {
        let read = self
            .call(
                "pane.read",
                json!({"pane_id":pane,"source":"visible","format":"ansi","strip_ansi":false}),
            )
            .await
            .unwrap_or_default();
        let ansi = regex::Regex::new(r"\x1b\[[0-?]*[ -/]*[@-~]").unwrap();
        ansi.replace_all(read["read"]["text"].as_str().unwrap_or_default(), "")
            .into_owned()
    }
    /// Whether a full-screen program such as Vim or less owns the pane. Herdr does not report the
    /// alternate screen, but it hides the scrollback and a read is then exactly the screen.
    pub async fn fullscreen(&self, pane: &str, text: &str) -> Result<bool> {
        let scroll = &self.call("pane.get", json!({"pane_id":pane})).await?["pane"]["scroll"];
        let rows = scroll["viewport_rows"].as_u64().unwrap_or(u64::MAX);
        Ok(scroll["max_offset_from_bottom"] == 0 && text.lines().count() as u64 == rows)
    }
    /// Names of the pane's foreground processes, such as ["fish"] at a prompt or ["nvim"].
    pub async fn foreground(&self, pane: &str) -> Result<Value> {
        let info = self
            .call("pane.process_info", json!({"pane_id":pane}))
            .await?;
        Ok(json!(
            info["process_info"]["foreground_processes"]
                .as_array()
                .map(|all| all.iter().map(|p| p["name"].clone()).collect::<Vec<_>>())
                .unwrap_or_default()
        ))
    }
    /// Sizes a pane's terminal to the window showing it, as a terminal window would. Without a
    /// desktop client Herdr gives new panes its small fallback screen, and its socket API has no
    /// size; a terminal controller takes the size, then lets go, and the pane keeps it. A pane
    /// another controller owns is left alone.
    pub async fn resize(&self, pane: &str, cols: u16, rows: u16) -> Result<()> {
        let mut child = Command::new(crate::apps::resolve_program("herdr")?)
            .args(["terminal", "session", "control", pane, "--cols"])
            .arg(cols.to_string())
            .arg("--rows")
            .arg(rows.to_string())
            .env("HERDR_SOCKET_PATH", &self.path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let mut stdin = child.stdin.take().unwrap();
        let mut frames = BufReader::new(child.stdout.take().unwrap()).lines();
        let mut stderr = child.stderr.take().unwrap();
        timeout(Duration::from_secs(5), async {
            // The first frame means the controller is attached at the new size.
            if frames.next_line().await?.is_none() {
                let mut message = String::new();
                stderr.read_to_string(&mut message).await?;
                bail!("Herdr: {}", message.trim());
            }
            stdin
                .write_all(b"{\"type\":\"terminal.release\"}\n")
                .await?;
            drop(stdin);
            while frames.next_line().await?.is_some() {}
            child.wait().await?;
            Ok(())
        })
        .await?
    }
    pub async fn create_workspace(&self, cwd: &Path) -> Result<Value> {
        let created = self
            .call("workspace.create", json!({"cwd":cwd,"focus":false}))
            .await?;
        Ok(created["root_pane"].clone())
    }
    pub async fn create_tab(&self, workspace: &str, cwd: &Path) -> Result<Value> {
        let created = self
            .call(
                "tab.create",
                json!({"workspace_id":workspace,"cwd":cwd,"focus":false}),
            )
            .await?;
        Ok(created["root_pane"].clone())
    }
    /* send_input delivers its text as a paste (bracketed when the program asks for it), which suits
    composed messages. Keystrokes must arrive as typing, or editors such as Vim insert them
    literally instead of treating them as commands; send_text and send_keys type them. */
    pub async fn input(
        &self,
        pane: &str,
        text: &str,
        keys: &[String],
        typed: bool,
    ) -> Result<Value> {
        if !typed {
            let images = image_paths(text);
            if images == 0 || keys.is_empty() {
                return self
                    .call(
                        "pane.send_input",
                        json!({"pane_id":pane,"text":text,"keys":keys}),
                    )
                    .await;
            }
            // Claude Code turns a pasted image path into an attachment after the paste arrives,
            // and a Return sent with the paste lands while it is busy and is lost. Paste first,
            // then press the keys once the attachments show, or the screen settles for agents
            // that show none.
            let before = attachments(&self.screen(pane).await);
            let result = self
                .call(
                    "pane.send_input",
                    json!({"pane_id":pane,"text":text,"keys":[]}),
                )
                .await?;
            let start = std::time::Instant::now();
            let (mut last, mut settled) = (String::new(), std::time::Instant::now());
            while start.elapsed() < std::time::Duration::from_secs(4) {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let screen = self.screen(pane).await;
                if attachments(&screen) >= before + images {
                    break;
                }
                if screen != last {
                    last = screen;
                    settled = std::time::Instant::now();
                } else if settled.elapsed() >= std::time::Duration::from_millis(600) {
                    break;
                }
            }
            self.call("pane.send_keys", json!({"pane_id":pane,"keys":keys}))
                .await?;
            return Ok(result);
        }
        let mut result = json!({"type":"ok"});
        if !text.is_empty() {
            result = self
                .call("pane.send_text", json!({"pane_id":pane,"text":text}))
                .await?;
        }
        if !keys.is_empty() {
            result = self
                .call("pane.send_keys", json!({"pane_id":pane,"keys":keys}))
                .await?;
        }
        Ok(result)
    }
}

/// How many image files a message names by absolute path, as Herdr's attach button writes them.
fn image_paths(text: &str) -> usize {
    text.split_whitespace()
        .map(|word| {
            word.trim_matches(|c| c == '\'' || c == '"')
                .to_ascii_lowercase()
        })
        .filter(|word| {
            word.starts_with('/')
                && [".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif"]
                    .iter()
                    .any(|extension| word.ends_with(extension))
        })
        .count()
}
/// Claude Code's attachments on screen, such as `[Image #10]`.
fn attachments(screen: &str) -> usize {
    screen.matches("[Image #").count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_with_image_paths_wait_for_their_attachments() {
        let message = "Change these cards\nImage: /home/qa/.local/share/omarchy-remote/uploads/a-IMG_0031.JPEG\nFile: /tmp/notes.txt\nImage: '/tmp/b.png'";
        assert_eq!(image_paths(message), 2);
        assert_eq!(image_paths("look at image.png and /tmp/notes.txt"), 0);
        assert_eq!(attachments("❯ [Image #10]lets change\n  ⎿ [Image #9]"), 2);
        assert_eq!(attachments("no images"), 0);
    }
}
