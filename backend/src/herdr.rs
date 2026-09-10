use anyhow::{Result, bail};
use serde_json::{Value, json};
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    time::timeout,
};

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
        Ok(self.call("session.snapshot", json!({})).await?["snapshot"].clone())
    }
    pub async fn read(&self, pane: &str) -> Result<Value> {
        Ok(self.call("pane.read", json!({"pane_id":pane,"source":"recent","lines":300,"format":"ansi","strip_ansi":false})).await?["read"].clone())
    }
    pub async fn input(&self, pane: &str, text: &str, keys: &[String]) -> Result<Value> {
        self.call(
            "pane.send_input",
            json!({"pane_id":pane,"text":text,"keys":keys}),
        )
        .await
    }
}
