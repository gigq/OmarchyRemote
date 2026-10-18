//! Canvas history: when a turn ends, its page is copied to `.history/<turn>/` in the session's
//! folder, with `.history/<turn>.json` naming where Claude's session stood, so the app can step
//! back through earlier pages and continue the conversation from any of them.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const HISTORY: &str = ".history";
/// A page larger than this, with its files, is not kept.
const MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Where a turn ended: the Claude session and its last message, and how many transcript entries
/// the conversation had.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub session: String,
    pub uuid: String,
    pub entries: usize,
}

/// Whether a folder entry is part of the page: not the transcript, its attachments, or hidden.
fn page_file(name: &str) -> bool {
    !name.starts_with('.') && !name.starts_with("chat.md") && name != "attachments"
}
fn copy(from: &Path, to: &Path, top: bool, depth: u8, budget: &mut u64) -> anyhow::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)?.flatten() {
        let name = entry.file_name();
        if top && !page_file(&name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type()?;
        if kind.is_dir() && depth > 0 {
            copy(&entry.path(), &to.join(&name), false, depth - 1, budget)?;
        } else if kind.is_file() {
            let size = entry.metadata()?.len();
            anyhow::ensure!(size <= *budget, "The page is too large to keep");
            *budget -= size;
            fs::copy(entry.path(), to.join(&name))?;
        }
    }
    Ok(())
}
fn history(folder: &Path) -> PathBuf {
    folder.join(HISTORY)
}
/// Keeps the page as it is at the end of `turn`.
pub fn snapshot(folder: &Path, turn: usize, point: &Point) -> anyhow::Result<()> {
    let dir = history(folder);
    let target = dir.join(turn.to_string());
    let _ = fs::remove_dir_all(&target);
    let mut budget = MAX_BYTES;
    if let Err(e) = copy(folder, &target, true, 6, &mut budget) {
        let _ = fs::remove_dir_all(&target);
        let _ = fs::remove_file(dir.join(format!("{turn}.json")));
        return Err(e);
    }
    fs::write(dir.join(format!("{turn}.json")), serde_json::to_vec(point)?)?;
    Ok(())
}
/// The turns with a page kept, oldest first, each with a version that changes if it is replaced.
pub fn turns(folder: &Path) -> Value {
    let Ok(entries) = fs::read_dir(history(folder)) else {
        return json!([]);
    };
    let mut turns: Vec<(usize, u64)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let turn = name.strip_suffix(".json")?.parse().ok()?;
            let modified = e.metadata().ok()?.modified().ok()?;
            let version = modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64;
            Some((turn, version))
        })
        .collect();
    turns.sort();
    turns
        .into_iter()
        .map(|(turn, version)| json!({"turn":turn,"version":version}))
        .collect()
}
/// The folder a kept page is served from.
pub fn page(folder: &Path, turn: u32) -> PathBuf {
    history(folder).join(turn.to_string())
}
/// Puts the page back as it was at the end of `turn` and forgets the turns after it; returns
/// where that turn ended.
pub fn restore(folder: &Path, turn: usize) -> anyhow::Result<Point> {
    let dir = history(folder);
    let point: Point = serde_json::from_slice(&fs::read(dir.join(format!("{turn}.json")))?)?;
    anyhow::ensure!(!point.uuid.is_empty(), "That page cannot be continued from");
    let kept = dir.join(turn.to_string());
    anyhow::ensure!(kept.is_dir(), "That page is no longer kept");
    for entry in fs::read_dir(folder)?.flatten() {
        if !page_file(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(entry.path())?;
        } else {
            fs::remove_file(entry.path())?;
        }
    }
    let mut unlimited = u64::MAX;
    copy(&kept, folder, true, 6, &mut unlimited)?;
    for entry in fs::read_dir(&dir)?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let later = name
            .trim_end_matches(".json")
            .parse::<usize>()
            .is_ok_and(|t| t > turn);
        if later {
            let _ = fs::remove_dir_all(entry.path());
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(point)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_are_kept_by_turn_and_restored_forgetting_later_turns() {
        let folder = std::env::temp_dir().join(format!("canvas-history-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(folder.join("attachments")).unwrap();
        fs::write(folder.join("chat.md"), "transcript").unwrap();
        fs::write(folder.join("attachments/photo.jpg"), "photo").unwrap();
        fs::write(folder.join("index.html"), "first").unwrap();
        let point = |n: usize| Point {
            session: "s".into(),
            uuid: format!("u{n}"),
            entries: n * 2,
        };
        snapshot(&folder, 1, &point(1)).unwrap();
        fs::write(folder.join("index.html"), "second").unwrap();
        fs::create_dir_all(folder.join("data")).unwrap();
        fs::write(folder.join("data/rows.json"), "[]").unwrap();
        snapshot(&folder, 2, &point(2)).unwrap();
        // Only the page is kept: not the transcript or attachments.
        assert!(!page(&folder, 1).join("chat.md").exists());
        assert!(!page(&folder, 1).join("attachments").exists());
        assert_eq!(
            fs::read_to_string(page(&folder, 2).join("data/rows.json")).unwrap(),
            "[]"
        );
        let kept: Vec<u64> = turns(&folder)
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["turn"].as_u64().unwrap())
            .collect();
        assert_eq!(kept, [1, 2]);
        assert_eq!(restore(&folder, 1).unwrap(), point(1));
        assert_eq!(
            fs::read_to_string(folder.join("index.html")).unwrap(),
            "first"
        );
        assert!(!folder.join("data").exists());
        assert_eq!(
            fs::read_to_string(folder.join("chat.md")).unwrap(),
            "transcript"
        );
        assert!(folder.join("attachments/photo.jpg").exists());
        assert_eq!(turns(&folder).as_array().unwrap().len(), 1);
        assert!(restore(&folder, 2).is_err());
        fs::remove_dir_all(folder).unwrap();
    }
}
