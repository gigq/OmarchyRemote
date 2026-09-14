//! Home-directory file browser, sharing the authenticated host gateway and upload writer.
use anyhow::{Result, bail};
use axum::{
    Json,
    body::Bytes,
    extract::Query,
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    fs,
    io::Read,
    os::unix::fs::{DirBuilderExt, MetadataExt},
    path::{Path, PathBuf},
};
pub const MAX_BYTES: usize = 25 * 1024 * 1024;
#[derive(Deserialize)]
pub struct Location {
    #[serde(default)]
    path: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    name: String,
}
pub(crate) fn root() -> Result<PathBuf> {
    Ok(fs::canonicalize(
        std::env::var_os("HOME").ok_or_else(|| anyhow::anyhow!("Home unavailable"))?,
    )?)
}
pub(crate) fn resolve(root: &Path, value: &str) -> Result<PathBuf> {
    let requested = Path::new(value);
    let path = fs::canonicalize(if requested.is_absolute() {
        requested.to_owned()
    } else {
        root.join(requested)
    })?;
    if !path.starts_with(root) {
        bail!("Choose a folder inside your home directory")
    }
    // The gateway's proxy secret must never become client content, including via aliases.
    let secret = root.join(".config/omarchy-remote/backend.env");
    if path == secret {
        bail!("This file is reserved for the host service")
    }
    if let (Ok(a), Ok(b)) = (fs::metadata(&path), fs::metadata(&secret))
        && a.dev() == b.dev()
        && a.ino() == b.ino()
    {
        bail!("This file is reserved for the host service")
    }
    Ok(path)
}
pub(crate) fn name(value: &str) -> Result<&str> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || value.contains(['/', '\\', '\0'])
        || value.chars().any(char::is_control)
    {
        bail!("Choose a simple file or folder name")
    }
    Ok(value)
}
fn listing(root: &Path, q: &Location) -> Result<Value> {
    let path = resolve(root, &q.path)?;
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path)? {
        let entry = entry?;
        let filename = entry.file_name().to_string_lossy().into_owned();
        if !q.hidden && filename.starts_with('.') {
            continue;
        }
        let Ok(target) = resolve(root, &entry.path().to_string_lossy()) else {
            continue;
        };
        let Ok(meta) = fs::metadata(&target) else {
            continue;
        };
        if !meta.is_dir() && !meta.is_file() {
            continue;
        }
        entries.push(json!({"name":filename,"path":entry.path(),"directory":meta.is_dir(),"size":meta.len(),"mode":format!("{:o}",meta.mode() & 0o777),"uid":meta.uid(),"count":if meta.is_dir(){fs::read_dir(&target).ok().map(|v|v.take(10001).count())}else{None},"modified":meta.modified().ok().and_then(|t|t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d|d.as_secs())}));
        if entries.len() > 10000 {
            bail!("Folder has too many items; choose a smaller folder")
        }
    }
    entries.sort_by(|a, b| {
        b["directory"]
            .as_bool()
            .cmp(&a["directory"].as_bool())
            .then_with(|| {
                a["name"]
                    .as_str()
                    .unwrap()
                    .to_lowercase()
                    .cmp(&b["name"].as_str().unwrap().to_lowercase())
            })
    });
    Ok(
        json!({"root":root,"path":path,"parent":if path==root{None}else{path.parent()},"entries":entries}),
    )
}
pub(crate) fn err(e: impl std::fmt::Display) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({"error":e.to_string()})),
    )
        .into_response()
}
pub async fn list(Query(q): Query<Location>) -> Response {
    match tokio::task::spawn_blocking(move || listing(&root()?, &q)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
pub async fn upload(Query(q): Query<Location>, bytes: Bytes) -> Response {
    match tokio::task::spawn_blocking(move || -> Result<Value> {
        let root = root()?;
        let folder = resolve(&root, &q.path)?;
        if !folder.is_dir() {
            bail!("Choose a folder")
        }
        let path = folder.join(name(&q.name)?);
        if path == root.join(".config/omarchy-remote/backend.env") {
            bail!("This file is reserved for the host service")
        }
        crate::uploads::write_new(&path, &bytes)?;
        Ok(json!({"path":path}))
    })
    .await
    {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
pub async fn mkdir(Json(q): Json<Location>) -> Response {
    match tokio::task::spawn_blocking(move || -> Result<Value> {
        let root = root()?;
        let path = resolve(&root, &q.path)?.join(name(&q.name)?);
        if path == root.join(".config/omarchy-remote/backend.env") {
            bail!("This file is reserved for the host service")
        }
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(json!({"path":path}))
    })
    .await
    {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
pub async fn content(Query(q): Query<Location>) -> Response {
    match tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
        let path = resolve(&root()?, &q.path)?;
        if !fs::metadata(&path)?.is_file() {
            bail!("Choose a regular file")
        }
        let mut file = fs::File::open(path)?;
        if !file.metadata()?.is_file() {
            bail!("Choose a regular file")
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_BYTES {
            bail!("Files over 25 MiB cannot be previewed or downloaded here")
        }
        Ok(bytes)
    })
    .await
    {
        Ok(Ok(bytes)) => (
            [
                (header::CONTENT_TYPE, "application/octet-stream"),
                (header::CONTENT_DISPOSITION, "attachment"),
                (header::CACHE_CONTROL, "no-store"),
                (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            ],
            bytes,
        )
            .into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_and_names_stay_inside_home() {
        let dir = std::env::temp_dir().join(format!("files-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        fs::create_dir_all(dir.join(".config/omarchy-remote")).unwrap();
        fs::write(dir.join(".config/omarchy-remote/backend.env"), b"test only").unwrap();
        std::os::unix::fs::symlink("/", dir.join("outside")).unwrap();
        std::os::unix::fs::symlink(
            dir.join(".config/omarchy-remote/backend.env"),
            dir.join("alias"),
        )
        .unwrap();
        assert!(resolve(&dir, "outside/etc/passwd").is_err());
        assert!(resolve(&dir, "../").is_err());
        assert!(resolve(&dir, "alias").is_err());
        assert!(name("../bad").is_err());
        assert!(name("ok.png").is_ok());
        crate::uploads::write_new(&dir.join("test"), b"first").unwrap();
        assert!(crate::uploads::write_new(&dir.join("test"), b"second").is_err());
        assert_eq!(fs::read(dir.join("test")).unwrap(), b"first");
        fs::remove_dir_all(dir).unwrap();
    }
}
