use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
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
        Ok(snapshot)
    }
    /// The last `lines` lines of a pane; Herdr returns at most 1000 whatever is asked.
    pub async fn read_lines(&self, pane: &str, lines: u32) -> Result<Value> {
        Ok(self.call("pane.read", json!({"pane_id":pane,"source":"recent","lines":lines,"format":"ansi","strip_ansi":false})).await?["read"].clone())
    }
    pub async fn read(&self, pane: &str) -> Result<Value> {
        self.read_lines(pane, PANE_LINES).await
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
            return self
                .call(
                    "pane.send_input",
                    json!({"pane_id":pane,"text":text,"keys":keys}),
                )
                .await;
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
