//! Canvas history: when a turn ends, its page is copied to `.history/<turn>/` in the session's
//! folder, with `.history/<turn>.json` naming where Claude's session stood, so the app can step
//! back through earlier pages and continue the conversation from any of them.
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
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
    /// The screen the page was made for then.
    #[serde(default)]
    pub layout: String,
}

/* Layouts: `index.html` is made for the screen of the message that last changed it, a phone or
a wider one, and `index.<layout>.html` is a version redrawn for the other. A redrawn version
records the `index.html` it was made from, so a later change to the page leaves it out of date.
Both are kept in `.layouts.json`. */
pub const LAYOUTS: [&str; 2] = ["phone", "wide"];
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Layouts {
    #[serde(default)]
    pub made_for: String,
    /// Each redrawn layout, by the hash of the `index.html` it was made from.
    #[serde(default)]
    pub variants: BTreeMap<String, String>,
}
/// The layout for a device the app reports: a phone, or a tablet or computer.
pub fn layout_of(device: &str) -> &'static str {
    if device == "phone" { "phone" } else { "wide" }
}
pub fn layouts(folder: &Path) -> Layouts {
    fs::read(folder.join(".layouts.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn save_layouts(folder: &Path, layouts: &Layouts) -> anyhow::Result<()> {
    let temporary = folder.join(".layouts.json.tmp");
    fs::write(&temporary, serde_json::to_vec(layouts)?)?;
    fs::rename(temporary, folder.join(".layouts.json"))?;
    Ok(())
}
/// The page's `index.html`, by its contents.
pub fn page_hash(folder: &Path) -> Option<String> {
    let bytes = fs::read(folder.join("index.html")).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}
/// When `index.html` last changed, in milliseconds; 0 when there is none.
pub fn page_time(folder: &Path) -> u64 {
    fs::metadata(folder.join("index.html"))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as u64)
}
/// The redrawn layouts made from the page as it is now.
pub fn fresh(folder: &Path) -> Vec<String> {
    let layouts = layouts(folder);
    let Some(hash) = page_hash(folder) else {
        return Vec::new();
    };
    layouts
        .variants
        .into_iter()
        .filter(|(layout, from)| {
            *from == hash && folder.join(format!("index.{layout}.html")).is_file()
        })
        .map(|(layout, _)| layout)
        .collect()
}
/// Notes the screen the page is made for; returns it.
pub fn set_made_for(folder: &Path, layout: &str) -> String {
    let mut layouts = layouts(folder);
    if !layout.is_empty() && layouts.made_for != layout {
        layouts.made_for = layout.to_owned();
        if let Err(e) = save_layouts(folder, &layouts) {
            eprintln!("canvas: could not note the layout: {e}");
        }
    }
    layouts.made_for
}
/// A turn ended: if it changed `index.html` (last changed at `before`), the page is now made for
/// the screen of its message. Returns the screen the page is made for.
pub fn record_layout(folder: &Path, layout: &str, before: u64) -> String {
    if page_time(folder) != before {
        set_made_for(folder, layout)
    } else {
        layouts(folder).made_for
    }
}
/// A version redrawn for `layout` from the `index.html` whose hash is `from`.
pub fn add_variant(folder: &Path, layout: &str, from: &str) -> anyhow::Result<()> {
    let mut layouts = layouts(folder);
    layouts.variants.insert(layout.to_owned(), from.to_owned());
    save_layouts(folder, &layouts)
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
/// Notes a Claude session the canvas has left behind by forking, so archiving or deleting the
/// canvas takes its log along.
pub fn left(folder: &Path, session: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let dir = history(folder);
    fs::create_dir_all(&dir)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("sessions"))?;
    writeln!(file, "{session}")?;
    Ok(())
}
/// The sessions a canvas has left behind.
pub fn sessions(folder: &Path) -> Vec<String> {
    fs::read_to_string(history(folder).join("sessions"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
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
    set_made_for(folder, &point.layout);
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
    fn a_redrawn_layout_lasts_until_the_page_changes() {
        let folder = std::env::temp_dir().join(format!("canvas-layouts-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&folder).unwrap();
        assert_eq!(layout_of("phone"), "phone");
        assert_eq!(layout_of("tablet"), "wide");
        assert_eq!(layout_of("computer"), "wide");
        // A turn that writes the page makes it for its message's screen.
        let before = page_time(&folder);
        fs::write(folder.join("index.html"), "<h1>Wide</h1>").unwrap();
        assert_eq!(record_layout(&folder, "wide", before), "wide");
        // A turn that leaves the page alone keeps it as it was made.
        let before = page_time(&folder);
        assert_eq!(record_layout(&folder, "phone", before), "wide");
        assert!(fresh(&folder).is_empty());
        let from = page_hash(&folder).unwrap();
        fs::write(folder.join("index.phone.html"), "<h1>Phone</h1>").unwrap();
        add_variant(&folder, "phone", &from).unwrap();
        assert_eq!(fresh(&folder), ["phone"]);
        // The page changes: the phone version is out of date.
        fs::write(folder.join("index.html"), "<h1>Wider</h1>").unwrap();
        assert!(fresh(&folder).is_empty());
        fs::remove_dir_all(folder).unwrap();
    }

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
            layout: if n == 1 { "wide" } else { "phone" }.into(),
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
        // Going back also goes back to the screen that page was made for.
        assert_eq!(layouts(&folder).made_for, "wide");
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
        left(&folder, "a").unwrap();
        left(&folder, "b").unwrap();
        assert_eq!(sessions(&folder), ["a", "b"]);
        fs::remove_dir_all(folder).unwrap();
    }
}
