//! Read-only home widgets. One sampler serves every connected phone.
use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::{
    fs,
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

pub type Widgets = Arc<Mutex<Value>>;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
async fn command(program: &str, args: &[&str]) -> Result<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(8),
        Command::new(program).args(args).kill_on_drop(true).output(),
    )
    .await??;
    if !out.status.success() {
        return Err(anyhow!("{program} unavailable"));
    }
    Ok(String::from_utf8(out.stdout)?)
}
/// Total jiffies, idle jiffies, and core count from `/proc/stat`.
type CpuSample = (u64, u64, usize);
/// Interface name plus received and transmitted bytes.
type NetSample = (String, u64, u64);

fn cpu(text: &str) -> CpuSample {
    let values: Vec<u64> = text
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|s| s.parse().ok())
        .collect();
    (
        values.iter().sum(),
        values.get(3).copied().unwrap_or(0) + values.get(4).copied().unwrap_or(0),
        text.lines()
            .filter(|l| l.starts_with("cpu") && !l.starts_with("cpu "))
            .count(),
    )
}
fn memory(text: &str) -> (u64, u64) {
    let get = |key: &str| {
        text.lines()
            .find(|l| l.starts_with(key))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0)
            * 1024
    };
    let total = get("MemTotal:");
    (total, total.saturating_sub(get("MemAvailable:")))
}
fn network() -> NetSample {
    let route = fs::read_to_string("/proc/net/route").unwrap_or_default();
    let iface = route
        .lines()
        .find_map(|l| {
            let p: Vec<_> = l.split_whitespace().collect();
            (p.get(1) == Some(&"00000000")).then(|| p[0].to_owned())
        })
        .unwrap_or_default();
    let read = |name: &str| {
        fs::read_to_string(format!("/sys/class/net/{iface}/statistics/{name}"))
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(0)
    };
    let rx = read("rx_bytes");
    let tx = read("tx_bytes");
    (iface, rx, tx)
}
fn temperature() -> Option<f64> {
    for entry in fs::read_dir("/sys/class/hwmon").ok()?.flatten() {
        let p = entry.path();
        let name = fs::read_to_string(p.join("name")).unwrap_or_default();
        if ["coretemp", "k10temp", "cpu_thermal"].contains(&name.trim())
            && let Ok(text) = fs::read_to_string(p.join("temp1_input"))
        {
            return text.trim().parse::<f64>().ok().map(|n| n / 1000.0);
        }
    }
    None
}
fn tailscale(value: Value) -> Value {
    let mut peers: Vec<Value> = value["Peer"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .map(|p| json!({"name":p["HostName"],"ip":p["TailscaleIPs"][0],"online":p["Online"]}))
        .collect();
    peers.sort_by(|a, b| {
        b["online"]
            .as_bool()
            .cmp(&a["online"].as_bool())
            .then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    json!({"state":value["BackendState"],"host":value["Self"]["HostName"],"ip":value["Self"]["TailscaleIPs"][0],"magic_dns":value["CurrentTailnet"]["MagicDNSEnabled"],"exit_node":value["ExitNodeStatus"]["TailscaleIPs"][0],"peers":peers,"updated_at":now()})
}
pub fn start() -> Widgets {
    let state = Arc::new(Mutex::new(
        json!({"metrics":{"error":"Starting sampler"},"tailscale":{"error":"Reading Tailscale"}}),
    ));
    let usage_target = state.clone();
    tokio::spawn(async move {
        loop {
            let (codex, claude) = tokio::join!(
                crate::codexbar::query("codex"),
                crate::codexbar::query("claude")
            );
            let mut providers = Vec::new();
            for (id, result) in [("codex", codex), ("claude", claude)] {
                let mut value = result
                    .unwrap_or_else(|_| json!({"id":id,"error":"Usage unavailable","windows":[]}));
                if !value["error"].is_null() {
                    let previous = usage_target.lock().unwrap()["codexbar"]["providers"]
                        .as_array()
                        .and_then(|p| p.iter().find(|p| p["id"] == id))
                        .cloned();
                    if let Some(mut old) = previous {
                        old["error"] = value["error"].clone();
                        value = old;
                    }
                }
                providers.push(value);
            }
            usage_target.lock().unwrap()["codexbar"] =
                json!({"providers":providers,"checked_at":now()});
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
    let cost_target = state.clone();
    tokio::spawn(async move {
        loop {
            match crate::codexbar::costs().await {
                Ok(costs) => {
                    let mut state = cost_target.lock().unwrap();
                    state["codexbar_costs"] = costs;
                    state["codexbar_cost_error"] = Value::Null;
                }
                Err(_) => {
                    cost_target.lock().unwrap()["codexbar_cost_error"] =
                        json!("Cost history unavailable")
                }
            }
            tokio::time::sleep(Duration::from_secs(300)).await;
        }
    });
    let target = state.clone();
    tokio::spawn(async move {
        let mut previous: Option<(CpuSample, NetSample, Instant)> = None;
        let mut tick = 0;
        loop {
            let at = Instant::now();
            let stats = fs::read_to_string("/proc/stat");
            let mem = fs::read_to_string("/proc/meminfo");
            if let (Ok(stats), Ok(mem)) = (stats, mem) {
                let c = cpu(&stats);
                let n = network();
                let (total, used) = memory(&mem);
                let (usage, rx, tx) = previous
                    .as_ref()
                    .map(|(p, q, t)| {
                        let delta = c.0.saturating_sub(p.0);
                        let idle = c.1.saturating_sub(p.1);
                        let secs = t.elapsed().as_secs_f64().max(0.1);
                        (
                            if delta > 0 {
                                Some(100.0 * (delta.saturating_sub(idle)) as f64 / delta as f64)
                            } else {
                                None
                            },
                            if n.0 == q.0 {
                                Some(n.1.saturating_sub(q.1) as f64 / secs)
                            } else {
                                None
                            },
                            if n.0 == q.0 {
                                Some(n.2.saturating_sub(q.2) as f64 / secs)
                            } else {
                                None
                            },
                        )
                    })
                    .unwrap_or((None, None, None));
                let mut metric = json!({"host":fs::read_to_string("/proc/sys/kernel/hostname").unwrap_or_default().trim(),"cpu_percent":usage,"cores":c.2,"memory_total":total,"memory_used":used,"rx_bps":rx,"tx_bps":tx,"interface":n.0,"temperature":temperature(),"uptime":fs::read_to_string("/proc/uptime").unwrap_or_default().split_whitespace().next().and_then(|s|s.parse::<f64>().ok()),"processes":fs::read_dir("/proc").ok().map(|d|d.flatten().filter(|e|e.file_name().to_string_lossy().parse::<u32>().is_ok()).count()),"updated_at":now()});
                if let Ok(df) = command("df", &["-Pk", "/"]).await {
                    let parts: Vec<_> =
                        df.lines().last().unwrap_or("").split_whitespace().collect();
                    let val = |i: usize| {
                        parts
                            .get(i)
                            .and_then(|s| s.parse::<u64>().ok())
                            .map(|n| n * 1024)
                    };
                    metric["disk_total"] = json!(val(1));
                    metric["disk_used"] = json!(val(2));
                }
                target.lock().unwrap()["metrics"] = metric;
                previous = Some((c, n, at));
            } else {
                target.lock().unwrap()["metrics"] = json!({"error":"Host metrics unavailable"});
            }
            if tick % 5 == 0 {
                let result = command("tailscale", &["status", "--json"])
                    .await
                    .and_then(|s| Ok(tailscale(serde_json::from_str(&s)?)));
                target.lock().unwrap()["tailscale"] =
                    result.unwrap_or_else(|_| json!({"error":"Tailscale status unavailable"}));
            }
            tick += 1;
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
    state
}
pub async fn cities(name: &str) -> Result<Value> {
    if name.trim().len() < 2 || name.len() > 100 {
        return Err(anyhow!("Enter a city name"));
    }
    let text = command(
        "curl",
        &[
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "7",
            "--get",
            "https://geocoding-api.open-meteo.com/v1/search",
            "--data-urlencode",
            &format!("name={name}"),
            "--data",
            "count=5",
        ],
    )
    .await?;
    let v: Value = serde_json::from_str(&text)?;
    Ok(json!({"results":v["results"].as_array().cloned().unwrap_or_default()}))
}
pub async fn weather(lat: f64, lon: f64) -> Result<Value> {
    if !lat.is_finite() || !lon.is_finite() || lat.abs() > 90.0 || lon.abs() > 180.0 {
        return Err(anyhow!("Invalid location"));
    }
    type Cache = std::collections::HashMap<String, (Instant, Value)>;
    static CACHE: std::sync::OnceLock<tokio::sync::Mutex<Cache>> = std::sync::OnceLock::new();
    let mut cache = CACHE
        .get_or_init(|| tokio::sync::Mutex::new(Cache::new()))
        .lock()
        .await;
    let key = format!("{lat:.3},{lon:.3}");
    if let Some((time, value)) = cache.get(&key)
        && time.elapsed() < Duration::from_secs(900)
    {
        return Ok(value.clone());
    }
    let url = format!(
        "https://api.open-meteo.com/v1/forecast?latitude={lat:.3}&longitude={lon:.3}&current=temperature_2m,weather_code,wind_speed_10m&hourly=temperature_2m,precipitation_probability&daily=temperature_2m_max,temperature_2m_min&forecast_days=2&timezone=auto&timeformat=unixtime"
    );
    let text = command(
        "curl",
        &[
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "7",
            &url,
        ],
    )
    .await?;
    let mut value: Value = serde_json::from_str(&text)?;
    value["fetched_at"] = json!(now());
    if cache.len() >= 32 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), value.clone()));
    Ok(value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_linux_counters() {
        assert_eq!(
            cpu("cpu  10 0 20 70 5 0 0 0 8 0\ncpu0 1\ncpu1 2"),
            (105, 75, 2)
        );
        assert_eq!(
            memory("MemTotal: 1000 kB\nMemAvailable: 250 kB"),
            (1024000, 768000)
        );
    }
    #[test]
    fn limits_tailscale_fields() {
        let v = tailscale(
            json!({"BackendState":"Running","Self":{"HostName":"host","PublicKey":"secret"},"Peer":{"a":{"HostName":"offline","Online":false},"b":{"HostName":"online","Online":true}}}),
        );
        assert_eq!(v["peers"][0]["name"], "online");
        assert!(!v.to_string().contains("secret"));
    }
}
