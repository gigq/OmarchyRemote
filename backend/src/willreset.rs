//! Cached public reset news, independent of account usage and banked credits.
use anyhow::{Result, ensure};
use serde_json::{Value, json};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

fn select(value: &Value, keys: &str) -> Value {
    let mut out = serde_json::Map::new();
    for key in keys.split_whitespace() {
        if let Some(v) = value.get(key) {
            let safe = match v {
                Value::String(s) => json!(s.chars().take(8000).collect::<String>()),
                Value::Bool(_) | Value::Number(_) | Value::Null => v.clone(),
                _ => continue,
            };
            out.insert(key.into(), safe);
        }
    }
    Value::Object(out)
}

fn normalize(kind: &str, raw: &Value) -> Result<Value> {
    ensure!(raw.is_object(), "Invalid reset response");
    if kind == "forecast" {
        ensure!(
            raw.get("computed_at").is_some(),
            "Missing forecast timestamp"
        );
        let mut result = select(
            raw,
            "computed_at prob_24 prob_48 confidence confidence_note last_reset_at last_reset_url last_reset_text age_days mean_gap_days median_gap_days longest_gap_days sample wait_shorter_pct peak_label live_fetched_at answer_detail",
        );
        for key in ["prob_24", "prob_48"] {
            result[key] = raw[key]
                .as_f64()
                .filter(|n| (0.0..=100.0).contains(n))
                .map_or(Value::Null, |n| json!(n));
        }
        result["promise"] = select(
            &raw["promise"],
            "active at quote text summary url source_url expires_at",
        );
        return Ok(result);
    }
    let key = if kind == "feed" { "posts" } else { "events" };
    let rows = raw[key]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("Missing reset rows"))?;
    let rows: Vec<_> = rows.iter()
        .filter(|row| kind != "feed" || matches!(row["kind"].as_str(), Some("reset" | "banked" | "reset_preview" | "signal")))
        .take(100)
        .map(|row| select(row, "id kind banked_state announced_at summary body source_url confidence preview scope at url text explicit_reset"))
        .collect();
    Ok(json!({"items": rows, "fetched_at": raw["fetched_at"]}))
}

async fn fetch(kind: &str) -> Result<Value> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        Command::new("curl")
            .args([
                "--fail",
                "--silent",
                "--show-error",
                "--max-time",
                "15",
                "--max-filesize",
                "2097152",
                "--user-agent",
                "OmarchyRemote/1.0",
                &format!("https://willreset.com/api/{kind}"),
            ])
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(output.status.success(), "Reset source unavailable");
    normalize(kind, &serde_json::from_slice(&output.stdout)?)
}

fn store(state: &mut Value, key: &str, result: Result<Value>, now: u64) {
    if state["reset_news"].is_null() {
        state["reset_news"] = json!({"source":"https://willreset.com/"});
    }
    let entry = &mut state["reset_news"][key];
    match result {
        Ok(data) => *entry = json!({"data":data,"checked_at":now,"error":null}),
        Err(_) => {
            if entry.is_null() {
                *entry = json!({});
            }
            entry["error"] = json!("willreset.com unavailable · showing last saved data");
        }
    }
}

pub fn start(state: crate::widgets::Widgets) {
    tokio::spawn(async move {
        loop {
            let (forecast, feed, timeline) =
                tokio::join!(fetch("forecast"), fetch("feed"), fetch("timeline"));
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            {
                let mut state = state.lock().unwrap();
                for (key, value) in [
                    ("forecast", forecast),
                    ("feed", feed),
                    ("timeline", timeline),
                ] {
                    store(&mut state, key, value, now);
                }
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_posts_preserves_preview_and_unknown_odds() {
        let feed = normalize("feed", &json!({"posts":[{"kind":"other","text":"unrelated"},{"kind":"banked","text":"reset news","url":"https://x.com/thsottiaux/status/1"}]})).unwrap();
        assert_eq!(feed["items"].as_array().unwrap().len(), 1);
        let forecast = normalize(
            "forecast",
            &json!({"computed_at":"now","prob_24":null,"prob_48":130,"promise":{"active":false}}),
        )
        .unwrap();
        assert!(forecast["prob_24"].is_null());
        assert!(forecast["prob_48"].is_null());
        let timeline = normalize(
            "timeline",
            &json!({"events":[{"kind":"reset_preview","preview":true,"summary":"Soon"}]}),
        )
        .unwrap();
        assert_eq!(timeline["items"][0]["preview"], true);
        assert!(normalize("feed", &json!({})).is_err());
    }
    #[test]
    fn failure_retains_last_success_and_timestamp() {
        let mut state = json!({});
        store(&mut state, "forecast", Ok(json!({"prob_24":0})), 100);
        store(
            &mut state,
            "forecast",
            Err(anyhow::anyhow!("private diagnostic")),
            200,
        );
        assert_eq!(state["reset_news"]["forecast"]["data"]["prob_24"], 0);
        assert_eq!(state["reset_news"]["forecast"]["checked_at"], 100);
        assert!(!state.to_string().contains("private diagnostic"));
    }
}
