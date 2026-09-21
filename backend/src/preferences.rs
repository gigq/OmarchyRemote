//! Host catalog and per-device preference backups. PTYs and browser cookies stay elsewhere.
use crate::{ApiError, App, error};
use anyhow::{Result, bail};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::Path as FilePath,
    sync::{Arc, Mutex},
};

pub const KEYS: &[&str] = &[
    "omarchy-theme",
    "omarchy-wallpapers",
    "omarchy-home-pins",
    "omarchy-widgets",
    "omarchy-widget-catalog",
    "omarchy-widget-current",
    "omarchy-weather-location",
    "omarchy-weather-unit-mode",
    "omarchy-codexbar-provider",
    "omarchy-herdr-fit",
    "omarchy-files-mode",
    "omarchy-inbox-dismissed",
    "omarchy-inbox-muted",
    "omarchy-layout-phone",
    "omarchy-layout-desk",
    "omarchy-focus-follows-pointer",
];
pub type Shared = Arc<Mutex<Store>>;
pub struct Store {
    db: Connection,
}
#[derive(Clone, Deserialize, Serialize)]
pub struct WebApp {
    pub id: String,
    pub name: String,
    pub url: String,
}
#[derive(Deserialize)]
pub struct AppChange {
    pub action: String,
    pub app: Option<WebApp>,
    pub id: Option<String>,
}
#[derive(Deserialize)]
pub struct DeviceChange {
    pub name: String,
    pub revision: i64,
    pub changes: BTreeMap<String, Option<String>>,
}
#[derive(Debug)]
struct Conflict;
impl std::fmt::Display for Conflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Backup changed; refresh and retry")
    }
}
impl std::error::Error for Conflict {}
fn valid_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
fn valid_app(app: &WebApp) -> bool {
    app.id.strip_prefix("webapp-").is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 72
            && id
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    }) && !app.name.trim().is_empty()
        && app.name.chars().count() <= 40
        && app.url.len() <= 4096
        && app.url.parse::<axum::http::Uri>().is_ok_and(|url| {
            matches!(url.scheme_str(), Some("http" | "https"))
                && url.host().is_some_and(|h| !h.is_empty())
                && !url.authority().unwrap().as_str().contains('@')
        })
}
impl Store {
    pub fn open(path: &FilePath) -> Result<Self> {
        use std::os::unix::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(path)?;
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "FULL")?;
        let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
        if version > 1 {
            bail!("Settings database is from a newer app version")
        }
        db.execute_batch("BEGIN; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS webapps(id TEXT PRIMARY KEY,name TEXT NOT NULL,url TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,revision INTEGER NOT NULL,settings TEXT NOT NULL,updated_at INTEGER NOT NULL);
            PRAGMA user_version=1; COMMIT;")?;
        db.execute(
            "INSERT OR IGNORE INTO meta VALUES('host_id',?1)",
            [uuid::Uuid::new_v4().to_string()],
        )?;
        Ok(Self { db })
    }
    fn catalog(&self) -> Result<Value> {
        let mut statement = self
            .db
            .prepare("SELECT id,name,url FROM webapps WHERE deleted=0 ORDER BY updated_at,id")?;
        let apps = statement
            .query_map([], |r| {
                Ok(WebApp {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    url: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let host: String =
            self.db
                .query_row("SELECT value FROM meta WHERE key='host_id'", [], |r| {
                    r.get(0)
                })?;
        Ok(json!({"schema":1,"host_id":host,"webapps":apps}))
    }
    fn change_app(&mut self, q: AppChange) -> Result<Value> {
        let tx = self.db.transaction()?;
        match q.action.as_str() {
            "install" | "import" => {
                let app = q.app.ok_or_else(|| anyhow::anyhow!("Missing web app"))?;
                if !valid_app(&app) {
                    bail!(
                        "Use a name of up to 40 characters and an http or https URL without credentials"
                    )
                }
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM webapps WHERE id=?1)",
                    [&app.id],
                    |r| r.get(0),
                )?;
                // Tombstones deliberately prevent a stale/offline device from reinstalling a removed ID.
                if !exists {
                    let count: i64 =
                        tx.query_row("SELECT count(*) FROM webapps WHERE deleted=0", [], |r| {
                            r.get(0)
                        })?;
                    if count >= 50 {
                        bail!("Maximum 50 web apps; uninstall an app first")
                    }
                    tx.execute(
                        "INSERT INTO webapps VALUES(?1,?2,?3,0,unixepoch())",
                        params![app.id, app.name.trim(), app.url],
                    )?;
                }
            }
            "remove" => {
                let id = q.id.ok_or_else(|| anyhow::anyhow!("Missing web app ID"))?;
                if !valid_app(&WebApp {
                    id: id.clone(),
                    name: "x".into(),
                    url: "https://example.com".into(),
                }) {
                    bail!("Invalid web app ID")
                }
                tx.execute("INSERT INTO webapps VALUES(?1,'','',1,unixepoch()) ON CONFLICT(id) DO UPDATE SET deleted=1,updated_at=unixepoch()",[id])?;
            }
            _ => bail!("Unknown catalog action"),
        }
        tx.commit()?;
        self.catalog()
    }
    fn device(&self, id: &str) -> Result<Value> {
        if !valid_id(id) {
            bail!("Invalid device ID")
        }
        let data = self
            .db
            .query_row(
                "SELECT name,revision,settings,updated_at FROM devices WHERE id=?1",
                [id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, i64>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;
        Ok(match data {
            Some((name, revision, values, updated_at)) => {
                json!({"id":id,"name":name,"revision":revision,"values":serde_json::from_str::<Value>(&values)?,"updated_at":updated_at})
            }
            None => json!({"id":id,"name":"","revision":0,"values":{},"updated_at":null}),
        })
    }
    fn devices(&self) -> Result<Value> {
        let mut statement = self.db.prepare(
            "SELECT id,name,revision,updated_at FROM devices ORDER BY updated_at DESC,id",
        )?;
        let devices=statement.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"revision":r.get::<_,i64>(2)?,"updated_at":r.get::<_,i64>(3)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(json!({"devices":devices}))
    }
    fn save_device(&mut self, id: &str, q: DeviceChange) -> Result<Value> {
        if q.revision < 0
            || q.revision == i64::MAX
            || !valid_id(id)
            || q.name.trim().is_empty()
            || q.name.chars().count() > 80
            || q.changes.len() > KEYS.len()
        {
            bail!("Invalid device settings")
        }
        for (key, value) in &q.changes {
            if !KEYS.contains(&key.as_str()) || value.as_ref().is_some_and(|v| v.len() > 32768) {
                bail!("Unsupported or oversized preference")
            }
        }
        let current = self.device(id)?;
        if current["revision"].as_i64() != Some(q.revision) {
            return Err(Conflict.into());
        }
        let mut values: BTreeMap<String, String> =
            serde_json::from_value(current["values"].clone())?;
        for (key, value) in q.changes {
            if let Some(value) = value {
                values.insert(key, value);
            } else {
                values.remove(&key);
            }
        }
        let data = serde_json::to_string(&values)?;
        if data.len() > 131072 {
            bail!("Device settings are too large")
        }
        self.db.execute("INSERT INTO devices VALUES(?1,?2,?3,?4,unixepoch()) ON CONFLICT(id) DO UPDATE SET name=excluded.name,revision=excluded.revision,settings=excluded.settings,updated_at=excluded.updated_at",params![id,q.name.trim(),q.revision+1,data])?;
        self.device(id)
    }
}
async fn run(
    app: App,
    f: impl FnOnce(&mut Store) -> Result<Value> + Send + 'static,
) -> Result<Json<Value>, ApiError> {
    tokio::task::spawn_blocking(move || f(&mut app.preferences.lock().unwrap()))
        .await
        .map_err(error)?
        .map(Json)
        .map_err(|e| {
            let status = if e.is::<Conflict>() {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            (status, Json(json!({"error":e.to_string()})))
        })
}
pub async fn snapshot(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    run(app, |s| s.catalog()).await
}
pub async fn change(
    State(app): State<App>,
    Json(q): Json<AppChange>,
) -> Result<Json<Value>, ApiError> {
    run(app, |s| s.change_app(q)).await
}
pub async fn devices(State(app): State<App>) -> Result<Json<Value>, ApiError> {
    run(app, |s| s.devices()).await
}
pub async fn device(
    State(app): State<App>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    run(app, move |s| s.device(&id)).await
}
pub async fn save(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(q): Json<DeviceChange>,
) -> Result<Json<Value>, ApiError> {
    run(app, move |s| s.save_device(&id, q)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_catalog_tombstones_and_isolated_device_backups() {
        let dir = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("settings.sqlite3");
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        let web = WebApp {
            id: format!("webapp-{}", uuid::Uuid::new_v4()),
            name: "Example".into(),
            url: "https://example.com/".into(),
        };
        {
            let mut s = Store::open(&path).unwrap();
            s.change_app(AppChange {
                action: "install".into(),
                app: Some(web.clone()),
                id: None,
            })
            .unwrap();
            let change = || DeviceChange {
                name: "iPad".into(),
                revision: 0,
                changes: BTreeMap::from([
                    ("omarchy-theme".into(), Some("tokyo-night".into())),
                    (
                        "omarchy-widget-catalog".into(),
                        Some("[\"weather\",\"herdr\"]".into()),
                    ),
                ]),
            };
            s.save_device(&a, change()).unwrap();
            assert!(s.save_device(&a, change()).unwrap_err().is::<Conflict>());
            assert_eq!(s.device(&b).unwrap()["values"], json!({}));
        }
        let mut s = Store::open(&path).unwrap();
        assert_eq!(s.catalog().unwrap()["webapps"].as_array().unwrap().len(), 1);
        assert_eq!(
            s.device(&a).unwrap()["values"]["omarchy-theme"],
            "tokyo-night"
        );
        assert_eq!(
            s.device(&a).unwrap()["values"]["omarchy-widget-catalog"],
            "[\"weather\",\"herdr\"]"
        );
        s.change_app(AppChange {
            action: "remove".into(),
            app: None,
            id: Some(web.id.clone()),
        })
        .unwrap();
        s.change_app(AppChange {
            action: "import".into(),
            app: Some(web),
            id: None,
        })
        .unwrap();
        assert_eq!(s.catalog().unwrap()["webapps"], json!([]));
        let bad = DeviceChange {
            name: "Bad".into(),
            revision: 0,
            changes: BTreeMap::from([("cookies".into(), Some("secret".into()))]),
        };
        assert!(s.save_device(&b, bad).is_err());
        assert!(!valid_app(&WebApp {
            id: "webapp-test".into(),
            name: "Bad".into(),
            url: "https://password@example.com/".into()
        }));
        drop(s);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
