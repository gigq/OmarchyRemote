//! Read-only CodexBar telemetry shared by the app and its Home widget.
use anyhow::Result;
use serde_json::{Value, json};
use std::time::Duration;
use tokio::process::Command;

// Explicit telemetry fields: never forward CLI diagnostics, auth, account identifiers,
// arbitrary new fields, or raw provider errors to a client.
fn telemetry(value: &Value, depth: usize) -> Value {
    if depth > 12 {
        return Value::Null;
    }
    match value {
        Value::Object(map) => {
            let allowed = "primary secondary tertiary extraRateWindows title window usedPercent windowMinutes resetsAt resetDescription usageUnavailableReason updatedAt dataConfidence loginMethod providerCost used limit remaining currencyCode period balanceUpdatedAt resetsAt credits events date service creditsUsed balanceReadSucceeded balanceIsWorkspace creditsAvailable codexCreditLimit codexResetCredits availableCount status granted_at expires_at redeem_started_at redeemed_at reset_type description subscriptionExpiresAt subscriptionRenewsAt details label value kind rows unit format indicator url pace stage deltaPercent expectedUsedPercent willLastToReset etaSeconds runOutProbability summary source version provider sessionTokens sessionCostUSD historyDays historyCoverageIsEstablished last30DaysTokens last30DaysCostUSD meteredCostUSD daily inputTokens outputTokens cacheReadTokens cacheCreationTokens totalTokens totalCost modelsUsed modelBreakdowns modelName cost totals provenance coverage incompleteRequestCount observedRecords estimatedRecords excludedRecords startDate endDate priced unpriced unmetered estimated nextRegenAmount personalUsed balance balanceIsUnavailable remainingPercent secondaryValue progress total usageValue chart points timestamp";
            Value::Object(
                map.iter()
                    .filter(|(key, _)| allowed.split_whitespace().any(|k| k == key.as_str()))
                    .map(|(key, value)| (key.clone(), telemetry(value, depth + 1)))
                    .collect(),
            )
        }
        Value::Array(rows) => Value::Array(
            rows.iter()
                .take(400)
                .map(|v| telemetry(v, depth + 1))
                .collect(),
        ),
        Value::String(text) => Value::String(text.chars().take(4096).collect()),
        _ => value.clone(),
    }
}

pub fn provider(provider: &str, raw: Value) -> Value {
    let entry = raw.as_array().and_then(|a| a.first()).unwrap_or(&raw);
    if !entry.is_object() {
        return json!({"id":provider,"windows":[],"details":{},"error":"Usage unavailable"});
    }
    let usage = &entry["usage"];
    let mut windows = Vec::new();
    for (key, label) in [
        ("primary", "Session"),
        ("secondary", "Weekly"),
        ("tertiary", "Other"),
    ] {
        let w = &usage[key];
        if w.is_object() {
            windows.push(json!({"label":label,"used_percent":w["usedPercent"].as_f64().map(|n| n.clamp(0.0,100.0)),"resets_at":w["resetsAt"],"minutes":w["windowMinutes"],"description":w["resetDescription"]}));
        }
    }
    if let Some(extra) = usage["extraRateWindows"].as_array() {
        for e in extra.iter().take(100) {
            windows.push(json!({"label":e["title"],"used_percent":e["window"]["usedPercent"].as_f64().map(|n| n.clamp(0.0,100.0)),"resets_at":e["window"]["resetsAt"],"minutes":e["window"]["windowMinutes"]}));
        }
    }
    let mut details = telemetry(entry, 0);
    // `usage` is a top-level envelope, not a recursively accepted key.
    details["usage"] = telemetry(usage, 0);
    json!({"id":provider,"windows":windows,"details":details,"updated_at":usage["updatedAt"],"error":if usage.is_null() || !entry["error"].is_null() {Some("Usage unavailable")} else {None}})
}

async fn command(args: &[&str]) -> Result<Value> {
    let output = tokio::time::timeout(
        Duration::from_secs(45),
        Command::new("/usr/bin/codexbar")
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub async fn query(id: &str) -> Result<Value> {
    let source = if id == "claude" { "oauth" } else { "auto" };
    let raw = command(&[
        "usage",
        "--provider",
        id,
        "--source",
        source,
        "--format",
        "json",
        "--json-only",
        "--status",
    ])
    .await?;
    Ok(provider(id, raw))
}

pub async fn costs() -> Result<Value> {
    let raw = command(&[
        "cost",
        "--provider",
        "both",
        "--format",
        "json",
        "--json-only",
    ])
    .await?;
    let rows = raw.as_array().map(Vec::as_slice).unwrap_or(&[]);
    Ok(Value::Array(
        rows.iter()
            .filter(|r| matches!(r["provider"].as_str(), Some("codex" | "claude")))
            .map(|r| {
                let mut safe = telemetry(r, 0);
                if !r["error"].is_null() {
                    safe["error"] = json!("Cost history unavailable");
                }
                safe
            })
            .collect(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exports_resets_and_costs_without_credentials_or_unknown_fields() {
        let value = provider(
            "codex",
            json!([{"usage":{"accountEmail":"private@example.com","identity":{"token":"secret"},"primary":null,"secondary":{"usedPercent":63},"codexResetCredits":{"availableCount":2,"credits":[{"id":"secret-redemption-id","status":"available","expires_at":"2030-10-01T00:00:00Z","title":"Weekly reset"}]}},"credits":{"remaining":0,"balanceReadSucceeded":true},"diagnostic":"secret","unknown":"secret"}]),
        );
        assert_eq!(provider("codex", json!([]))["error"], "Usage unavailable");
        assert_eq!(
            provider("codex", json!("invalid"))["error"],
            "Usage unavailable"
        );
        assert_eq!(value["windows"][0]["used_percent"], 63.0);
        assert_eq!(
            value["details"]["usage"]["codexResetCredits"]["availableCount"],
            2
        );
        assert_eq!(value["details"]["credits"]["remaining"], 0);
        assert!(!value.to_string().contains("private"));
        assert!(!value.to_string().contains("secret"));
        assert_eq!(
            provider("claude", json!([{"error":{"message":"secret"}}]))["error"],
            "Usage unavailable"
        );
    }
}
