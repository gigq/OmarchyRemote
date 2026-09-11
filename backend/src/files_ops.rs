//! Search and reviewed file actions share the browser's home/secret boundary.
use crate::files::{MAX_BYTES, err, name, resolve, root};
use anyhow::{Result, bail};
use axum::{
    Json,
    extract::Query,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Cursor, Read, Write},
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, PermissionsExt},
    },
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
static WRITES: Mutex<()> = Mutex::new(());
const TEXT_LIMIT: usize = 1024 * 1024;
fn bytes(path: &Path, limit: usize) -> Result<Vec<u8>> {
    if !path.is_file() {
        bail!("Choose a regular file")
    }
    let mut data = Vec::new();
    fs::File::open(path)?
        .take((limit + 1) as u64)
        .read_to_end(&mut data)?;
    if data.len() > limit {
        bail!("File exceeds the size limit")
    }
    Ok(data)
}
fn digest(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}
#[derive(Deserialize)]
pub struct Search {
    #[serde(default)]
    path: String,
    query: String,
    #[serde(default)]
    mode: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    regex: bool,
    #[serde(default)]
    sensitive: bool,
    #[serde(default)]
    glob: String,
}
fn fuzzy(haystack: &str, needle: &str) -> Option<usize> {
    let haystack = haystack.to_lowercase();
    let mut score = 0;
    for term in needle.to_lowercase().split_whitespace() {
        let mut from = 0;
        for c in term.chars() {
            let p = haystack[from..].find(c)?;
            score += p;
            from += p + c.len_utf8();
        }
    }
    Some(score)
}
fn search_at(home: &Path, q: Search) -> Result<Value> {
    if q.query.is_empty() || q.query.len() > 256 {
        bail!("Enter a search of 1–256 characters")
    }
    if !["names", "contents", "everywhere", "fuzzy"].contains(&q.mode.as_str()) {
        bail!("Unknown search scope")
    }
    let scope = if ["everywhere", "fuzzy"].contains(&q.mode.as_str()) {
        home.to_owned()
    } else {
        resolve(home, &q.path)?
    };
    if !scope.is_dir() {
        bail!("Choose a folder")
    }
    let pattern = if q.regex {
        q.query.clone()
    } else {
        regex::escape(&q.query)
    };
    let matcher = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!q.sensitive)
        .size_limit(1024 * 1024)
        .build()?;
    let glob = if q.glob.is_empty() {
        None
    } else {
        Some(globset::Glob::new(&q.glob)?.compile_matcher())
    };
    let start = Instant::now();
    let mut scanned = 0;
    let mut total_bytes = 0;
    let mut hits = Vec::new();
    let mut truncated = false;
    let preferred = if ["everywhere", "fuzzy"].contains(&q.mode.as_str()) {
        resolve(home, &q.path)
            .ok()
            .filter(|p| p.is_dir() && p != &scope)
    } else {
        None
    };
    let mut roots = Vec::new();
    if let Some(path) = &preferred {
        roots.push(path.clone());
    }
    roots.push(scope.clone());
    let walker = roots.into_iter().flat_map(|walk_root| {
        let home_pass = walk_root == scope;
        let mut walk = walkdir::WalkDir::new(walk_root)
            .follow_links(false)
            .min_depth(1)
            .sort_by_key(|e| {
                let name = e.file_name().to_string_lossy();
                (
                    if name == "git" {
                        0
                    } else if name.starts_with('.') {
                        2
                    } else {
                        1
                    },
                    name.into_owned(),
                )
            });
        if q.mode == "names" {
            walk = walk.max_depth(1);
        }
        let preferred = preferred.clone();
        walk.into_iter().filter_entry(move |e| {
            e.depth() == 0
                || ((q.hidden || !e.file_name().to_string_lossy().starts_with('.'))
                    && !(home_pass && preferred.as_deref() == Some(e.path()))
                    && !(e.file_type().is_dir()
                        && [".git", "node_modules", "target", ".cache"]
                            .contains(&e.file_name().to_string_lossy().as_ref())))
        })
    });
    for item in walker {
        scanned += 1;
        if scanned > 50000 || start.elapsed() > Duration::from_secs(3) {
            truncated = true;
            break;
        }
        let Ok(item) = item else { continue };
        if item.file_type().is_symlink() {
            continue;
        }
        let Ok(path) = resolve(home, &item.path().to_string_lossy()) else {
            continue;
        };
        let filename = item.file_name().to_string_lossy().into_owned();
        if let Some(g) = &glob {
            if !g.is_match(&filename) && !g.is_match(path.strip_prefix(&scope)?) {
                continue;
            }
        }
        let Ok(meta) = item.metadata() else { continue };
        if !meta.is_file() && !meta.is_dir() {
            continue;
        }
        let rel = path.strip_prefix(&scope)?.to_string_lossy();
        let mut score = 0;
        let name_match = if q.mode == "fuzzy" {
            if let Some(s) = fuzzy(&rel, &q.query) {
                score = s;
                true
            } else {
                false
            }
        } else {
            matcher.is_match(&filename)
        };
        let mut lines = Vec::new();
        if ["contents", "everywhere"].contains(&q.mode.as_str())
            && meta.is_file()
            && meta.len() <= TEXT_LIMIT as u64
        {
            if total_bytes >= 32 * 1024 * 1024 {
                truncated = true;
            } else if let Ok(data) = bytes(&path, TEXT_LIMIT) {
                total_bytes += data.len();
                if !data.contains(&0) {
                    if let Ok(text) = std::str::from_utf8(&data) {
                        for (n, line) in text.lines().enumerate() {
                            if matcher.is_match(line) {
                                lines.push(json!({"number":n+1,"text":line.chars().take(500).collect::<String>()}));
                                if lines.len() == 8 {
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        if (!lines.is_empty()) || (name_match && q.mode != "contents") {
            hits.push(json!({"name":filename,"path":path,"directory":meta.is_dir(),"size":meta.len(),"lines":lines,"score":score}));
            if hits.len() >= 100 {
                truncated = true;
                break;
            }
        }
    }
    if q.mode == "fuzzy" {
        hits.sort_by_key(|v| v["score"].as_u64().unwrap_or(0))
    }
    Ok(
        json!({"entries":hits,"scanned":scanned,"truncated":truncated,"elapsed_ms":start.elapsed().as_millis(),"scope":scope}),
    )
}
pub async fn search(Query(q): Query<Search>) -> Response {
    match tokio::task::spawn_blocking(move || search_at(&root()?, q)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
#[derive(Deserialize)]
pub struct TextPath {
    path: String,
}
pub async fn text(Query(q): Query<TextPath>) -> Response {
    match tokio::task::spawn_blocking(move||->Result<Value>{let path=resolve(&root()?,&q.path)?;let data=bytes(&path,TEXT_LIMIT)?;let text=std::str::from_utf8(&data)?;if data.contains(&0){bail!("Binary files cannot be edited")};let meta=fs::metadata(&path)?;Ok(json!({"text":text,"version":digest(&data),"mode":format!("{:o}",meta.mode()&0o777),"uid":meta.uid(),"modified":meta.mtime()}))}).await{Ok(Ok(v))=>Json(v).into_response(),Ok(Err(e))=>err(e),Err(e)=>err(e)}
}
#[derive(Deserialize)]
pub struct Save {
    path: String,
    text: String,
    version: String,
}
fn save_at(home: &Path, q: Save) -> Result<Value> {
    let _guard = WRITES.lock().unwrap();
    let path = resolve(home, &q.path)?;
    if q.text.len() > TEXT_LIMIT {
        bail!("Editing is limited to 1 MiB")
    }
    let old = bytes(&path, TEXT_LIMIT)?;
    if digest(&old) != q.version {
        bail!("File changed on the host. Reopen it before saving; your draft has been kept.")
    }
    let meta = fs::metadata(&path)?;
    let temp = path.with_file_name(format!(".omarchy-edit-{}", uuid::Uuid::new_v4()));
    let result = (|| -> Result<()> {
        crate::uploads::write_new(&temp, q.text.as_bytes())?;
        fs::set_permissions(&temp, fs::Permissions::from_mode(meta.mode() & 0o777))?;
        if digest(&bytes(&path, TEXT_LIMIT)?) != q.version {
            bail!("File changed on the host; reopen before saving")
        }
        fs::rename(&temp, &path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result?;
    Ok(json!({"version":digest(q.text.as_bytes())}))
}
pub async fn save(Json(q): Json<Save>) -> Response {
    match tokio::task::spawn_blocking(move || save_at(&root()?, q)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
#[derive(Deserialize)]
pub struct Action {
    action: String,
    paths: Vec<String>,
    #[serde(default)]
    destination: String,
    #[serde(default)]
    name: String,
}
fn selected(home: &Path, values: &[String]) -> Result<Vec<PathBuf>> {
    if values.is_empty() || values.len() > 100 {
        bail!("Select between 1 and 100 items")
    }
    let mut paths = Vec::new();
    for v in values {
        let path = resolve(home, v)?;
        if path == home
            || home
                .join(".config/omarchy-remote/backend.env")
                .starts_with(&path)
        {
            bail!("This folder is reserved for the host service")
        }
        let supplied = if Path::new(v).is_absolute() {
            PathBuf::from(v)
        } else {
            home.join(v)
        };
        if fs::symlink_metadata(&supplied)?.file_type().is_symlink() {
            bail!("Open the original item before changing or archiving a symbolic link")
        }
        paths.push(path)
    }
    paths.sort();
    paths.dedup();
    let all = paths.clone();
    paths.retain(|p| !all.iter().any(|other| other != p && p.starts_with(other)));
    Ok(paths)
}
fn tree(home: &Path, path: &Path) -> Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    let mut count = 0;
    for e in walkdir::WalkDir::new(path).follow_links(false) {
        let e = e?;
        if e.file_type().is_symlink() {
            bail!("Copy/archive does not follow symbolic links")
        }
        let target = resolve(home, &e.path().to_string_lossy())?;
        let m = fs::metadata(&target)?;
        if !m.is_file() && !m.is_dir() {
            bail!("Unsupported special file")
        }
        count += if m.is_file() { m.len() } else { 0 };
        if count > MAX_BYTES as u64 || result.len() >= 10000 {
            bail!("Selection exceeds 25 MiB or 10,000 entries")
        }
        result.push(target)
    }
    Ok(result)
}
fn rename_new(from: &Path, to: &Path) -> Result<()> {
    let from = std::ffi::CString::new(from.as_os_str().as_bytes())?;
    let to = std::ffi::CString::new(to.as_os_str().as_bytes())?;
    if unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    } != 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
fn copy_tree(home: &Path, from: &Path, to: &Path) -> Result<()> {
    let entries = tree(home, from)?;
    // Stage privately on the destination filesystem, then publish without overwrite.
    let stage = to
        .parent()
        .unwrap()
        .join(format!(".omarchy-copy-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&stage)?;
    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700))?;
    let payload = stage.join("item");
    let result = (|| -> Result<()> {
        let mut permissions = Vec::new();
        for source in entries {
            let dest = if source == from {
                payload.clone()
            } else {
                payload.join(source.strip_prefix(from)?)
            };
            if source.is_dir() {
                fs::create_dir(&dest)?;
            } else {
                crate::uploads::write_new(&dest, &bytes(&source, MAX_BYTES)?)?;
            }
            permissions.push((dest, fs::metadata(&source)?.permissions()));
        }
        // Children are populated before restoring potentially read-only directories.
        for (dest, mode) in permissions.into_iter().rev() {
            fs::set_permissions(dest, mode)?;
        }
        rename_new(&payload, to)
    })();
    // Restore owner access in our private staging tree so failed copies can be removed.
    if result.is_err() {
        for entry in walkdir::WalkDir::new(&stage)
            .into_iter()
            .filter_map(Result::ok)
        {
            if entry.file_type().is_dir() {
                let _ = fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o700));
            }
        }
    }
    let _ = fs::remove_dir_all(&stage);
    result
}
fn operate_at(home: &Path, q: Action) -> Result<Value> {
    let _guard = WRITES.lock().unwrap();
    if !["move", "copy", "rename", "trash"].contains(&q.action.as_str()) {
        bail!("Unknown file action")
    }
    let sources = selected(home, &q.paths)?;
    if q.action == "rename" && sources.len() != 1 {
        bail!("Rename one item at a time")
    }
    let mut plan = Vec::new();
    for source in sources {
        let dest = if q.action == "trash" {
            None
        } else {
            let folder = if q.action == "rename" {
                source.parent().unwrap().to_owned()
            } else {
                resolve(home, &q.destination)?
            };
            if !folder.is_dir() {
                bail!("Choose a destination folder")
            }
            let dest = folder.join(if q.action == "rename" {
                name(&q.name)?
            } else {
                source
                    .file_name()
                    .unwrap()
                    .to_str()
                    .ok_or_else(|| anyhow::anyhow!("Unsupported name"))?
            });
            if dest == home.join(".config/omarchy-remote/backend.env")
                || dest.starts_with(&source)
                || fs::symlink_metadata(&dest).is_ok()
            {
                bail!("Destination exists or is inside the selected item")
            }
            Some(dest)
        };
        if q.action == "copy" {
            tree(home, &source)?;
        }
        plan.push((source, dest));
    }
    let mut completed = Vec::new();
    let mut errors = Vec::new();
    for (source, dest) in plan {
        let result = match q.action.as_str() {
            "copy" => copy_tree(home, &source, dest.as_ref().unwrap()),
            "trash" => std::process::Command::new("/usr/bin/gio")
                .args(["trash", "--"])
                .arg(&source)
                .output()
                .map_err(Into::into)
                .and_then(|o| {
                    if o.status.success() {
                        Ok(())
                    } else {
                        bail!("Could not move item to Trash")
                    }
                }),
            _ => rename_new(&source, dest.as_ref().unwrap()),
        };
        match result {
            Ok(()) => completed.push(source),
            Err(e) => errors.push(json!({"path":source,"error":e.to_string()})),
        }
    }
    Ok(json!({"completed":completed,"errors":errors}))
}
pub async fn operate(Json(q): Json<Action>) -> Response {
    match tokio::task::spawn_blocking(move || operate_at(&root()?, q)).await {
        Ok(Ok(v)) => Json(v).into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}
#[derive(Deserialize)]
pub struct Selection {
    paths: Vec<String>,
}
fn archive_at(home: &Path, q: Selection) -> Result<Vec<u8>> {
    let sources = selected(home, &q.paths)?;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default();
    let mut total = 0;
    for source in sources {
        for item in tree(home, &source)? {
            let rel = item.strip_prefix(home)?.to_string_lossy();
            if item.is_dir() {
                writer.add_directory(format!("{rel}/"), options)?
            } else {
                let data = bytes(&item, MAX_BYTES)?;
                total += data.len();
                if total > MAX_BYTES {
                    bail!("ZIP selection exceeds 25 MiB")
                }
                writer.start_file(rel, options)?;
                writer.write_all(&data)?
            }
        }
    }
    let output = writer.finish()?.into_inner();
    if output.len() > MAX_BYTES {
        bail!("ZIP exceeds 25 MiB")
    };
    Ok(output)
}
pub async fn archive(Json(q): Json<Selection>) -> Response {
    match tokio::task::spawn_blocking(move || archive_at(&root()?, q)).await {
        Ok(Ok(v)) => (
            [
                ("content-type", "application/zip"),
                ("cache-control", "no-store"),
                ("content-disposition", "attachment; filename=files.zip"),
            ],
            v,
        )
            .into_response(),
        Ok(Err(e)) => err(e),
        Err(e) => err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> PathBuf {
        let p = std::env::temp_dir().join(format!("files-redesign-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(p.join("src")).unwrap();
        fs::create_dir(p.join("dest")).unwrap();
        fs::write(p.join("src/hello.rs"), b"pub fn hello() {}\nneedle here\n").unwrap();
        p
    }
    #[test]
    fn search_modes_and_globs_use_real_names_and_lines() {
        let home = fixture();
        for mode in ["names", "contents", "everywhere", "fuzzy"] {
            let q = Search {
                path: "src".into(),
                query: if mode == "contents" || mode == "everywhere" {
                    "needle".into()
                } else {
                    "hel".into()
                },
                mode: mode.into(),
                hidden: false,
                regex: false,
                sensitive: false,
                glob: "*.rs".into(),
            };
            let r = search_at(&home, q).unwrap();
            assert_eq!(r["entries"].as_array().unwrap().len(), 1);
            if mode == "contents" {
                assert_eq!(r["entries"][0]["lines"][0]["number"], 2)
            }
        }
        fs::remove_dir_all(home).unwrap()
    }
    #[test]
    fn copy_move_rename_and_zip_never_replace_existing_files() {
        let home = fixture();
        let action = |kind: &str, path: &str, dest: &str, new: &str| Action {
            action: kind.into(),
            paths: vec![path.into()],
            destination: dest.into(),
            name: new.into(),
        };
        operate_at(&home, action("copy", "src/hello.rs", "dest", "")).unwrap();
        assert!(operate_at(&home, action("copy", "src/hello.rs", "dest", "")).is_err());
        operate_at(&home, action("rename", "dest/hello.rs", "", "renamed.rs")).unwrap();
        assert!(home.join("dest/renamed.rs").exists());
        operate_at(&home, action("move", "dest/renamed.rs", "src", "")).unwrap();
        assert!(home.join("src/renamed.rs").exists());
        let data = archive_at(
            &home,
            Selection {
                paths: vec!["src".into()],
            },
        )
        .unwrap();
        let mut zip = zip::ZipArchive::new(Cursor::new(data)).unwrap();
        assert!(zip.by_name("src/hello.rs").is_ok());
        assert!(operate_at(&home, action("copy", "src", "src", "")).is_err());
        fs::remove_dir_all(home).unwrap();
    }
    #[test]
    fn edits_detect_conflicts_and_operations_reject_secret_aliases() {
        let home = fixture();
        let old = bytes(&home.join("src/hello.rs"), TEXT_LIMIT).unwrap();
        let version = digest(&old);
        save_at(
            &home,
            Save {
                path: "src/hello.rs".into(),
                text: "saved".into(),
                version: version.clone(),
            },
        )
        .unwrap();
        assert!(
            save_at(
                &home,
                Save {
                    path: "src/hello.rs".into(),
                    text: "stale".into(),
                    version
                }
            )
            .is_err()
        );
        assert_eq!(fs::read(home.join("src/hello.rs")).unwrap(), b"saved");
        fs::create_dir_all(home.join(".config/omarchy-remote")).unwrap();
        fs::write(
            home.join(".config/omarchy-remote/backend.env"),
            b"fixture only",
        )
        .unwrap();
        fs::hard_link(
            home.join(".config/omarchy-remote/backend.env"),
            home.join("src/alias"),
        )
        .unwrap();
        assert!(tree(&home, &home.join("src")).is_err());
        assert!(selected(&home, &[".config".into()]).is_err());
        assert!(selected(&home, &["src/alias".into()]).is_err());
        assert!(resolve(&home, "/").is_err());
        fs::remove_dir_all(home).unwrap();
    }
}
