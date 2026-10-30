//! A Blender render, spread across the farm. A render script run as `blender … -P script.py --
//! … --frames A-B` renders any range of frames on its own, so its frames can be cut into ranges
//! that render at once on several machines. Nobody asks for it: `render-slot` sees such a render.
//!
//! A render's frames never mix kinds of GPU, since EEVEE draws through each GPU's driver and Cycles
//! samples a little differently on OptiX, Metal, and HIP: they all render on gerty (the 5090,
//! first when its GPU is free), or all on the Macs, or here as before. A script that names OptiX
//! or CUDA goes only to gerty, one that names Metal only to the Macs, one that names HIP stays
//! here. Before the script, Blender is told the machine's GPU, which `--factory-startup` forgets.
//!
//! The project goes to each machine through Corral's own sync (only files that changed, as a tar
//! stream), without its renders, videos, archives, or Python environment. Each machine renders
//! its range in its copy, and the files it made come back to the same places here.
use super::split::{Board, Piece, Place, schedule};
use super::*;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Renders with fewer frames than this run whole.
const FEWEST: u64 = 8;
/// Folders a render does not need, which stay here: what renders make, archives, and this
/// machine's own environments. (`work/` goes: renders read song timing and audio from it.)
const SKIP_DIRS: [&str; 12] = [
    "out",
    "renders",
    "videos",
    "archive",
    "_archive",
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".cache",
    "logs",
];
const SKIP_EXTENSIONS: [&str; 5] = ["mp4", "mov", "mkv", "webm", "m4v"];

/// Which machines a render's script allows.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Allowed {
    Any,
    Gerty,
    Macs,
    Here,
}
/// A Blender render whose frames can be split.
pub(crate) struct Job {
    args: Vec<String>,
    /// Where the frame range's value is in `args`.
    frames_at: usize,
    /// Where the script's `-P` is in `args`, for the GPU's setup before it.
    script_at: usize,
    first: u64,
    last: u64,
    cwd: PathBuf,
    root: PathBuf,
    allowed: Allowed,
    label: String,
}
/// The project a render belongs to: the nearest folder up from `cwd` with an `AGENTS.md`.
fn project_root(cwd: &Path) -> PathBuf {
    let home = corral::home_dir().unwrap_or_default();
    let mut dir = cwd;
    loop {
        if dir.join("AGENTS.md").is_file() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(up) if up.starts_with(&home) && up != home => dir = up,
            _ => return cwd.to_path_buf(),
        }
    }
}
/// What a Blender command says about its render, if its frames can be split.
pub(crate) fn job(command: &[String], label: &str) -> Option<Job> {
    if std::env::var("RENDER_SPLIT").is_ok_and(|v| v == "0") {
        return None;
    }
    let program = Path::new(command.first()?)
        .file_name()?
        .to_string_lossy()
        .to_lowercase();
    if !program.starts_with("blender") {
        return None;
    }
    let args = command[1..].to_vec();
    let script_at = args.iter().position(|a| a == "-P" || a == "--python")?;
    let script = std::fs::read_to_string(args.get(script_at + 1)?).ok()?;
    let rest = args.iter().position(|a| a == "--")?;
    if args[rest..].iter().any(|a| a == "--only") {
        return None;
    }
    let frames_at = rest + args[rest..].iter().position(|a| a == "--frames")? + 1;
    let (first, last) = args.get(frames_at)?.split_once('-')?;
    let (first, last): (u64, u64) = (first.parse().ok()?, last.parse().ok()?);
    if last < first || last - first + 1 < FEWEST {
        return None;
    }
    // Paths of this machine's would mean nothing to another.
    if args.iter().any(|a| a.starts_with('/')) {
        return None;
    }
    let allowed = if script.contains("OPTIX") || script.contains("CUDA") {
        Allowed::Gerty
    } else if script.contains("METAL") {
        Allowed::Macs
    } else if script.contains("'HIP'") || script.contains("\"HIP\"") {
        Allowed::Here
    } else {
        Allowed::Any
    };
    let cwd = std::env::current_dir().ok()?;
    Some(Job {
        args,
        frames_at,
        script_at,
        first,
        last,
        root: project_root(&cwd),
        cwd,
        allowed,
        label: if label.is_empty() {
            "Blender".into()
        } else {
            label.to_owned()
        },
    })
}

/// A machine of the farm that answers, with what it has and whether its GPU is free now.
struct Farmer {
    machine: Machine,
    tags: Vec<String>,
    gpu_free: bool,
}
fn farmers() -> Vec<Farmer> {
    hosts()
        .into_iter()
        .filter_map(|machine| {
            let farm = ask(&machine, "/api/corral/farm", None).ok()?;
            let tags: Vec<String> = farm["tags"]
                .as_array()?
                .iter()
                .filter_map(|t| t.as_str().map(str::to_owned))
                .collect();
            let q = &farm["queue"];
            let seats = q["budget"]["gpus"].as_u64().unwrap_or(1);
            let busy = q["jobs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|j| j["running"] == true && j["gpu"] == true)
                .count() as u64;
            Some(Farmer {
                machine,
                tags,
                gpu_free: busy < seats,
            })
        })
        .filter(|f| f.tags.iter().any(|t| t == "blender"))
        .collect()
}
/// The groups a render can go to, in the order to try them: gerty alone, or the Macs together.
/// Gerty comes first while its GPU is free; a group that fails before it renders a frame gives
/// way to the next.
fn groups(allowed: Allowed) -> Vec<Vec<Farmer>> {
    if allowed == Allowed::Here {
        return Vec::new();
    }
    let (mut gerty, macs): (Vec<Farmer>, Vec<Farmer>) = farmers()
        .into_iter()
        .filter(|f| f.tags.iter().any(|t| t == "optix" || t == "metal"))
        .partition(|f| f.tags.iter().any(|t| t == "optix"));
    gerty.truncate(1);
    let free = gerty.first().is_some_and(|g| g.gpu_free);
    let order = match allowed {
        Allowed::Gerty => vec![gerty],
        Allowed::Macs => vec![macs],
        _ if free => vec![gerty, macs],
        _ => vec![macs, gerty],
    };
    order.into_iter().filter(|g| !g.is_empty()).collect()
}
/// Blender's Python, before the script, that turns on the machine's GPU for Cycles.
fn gpu_setup(farmer: &Farmer) -> String {
    let kind = if farmer.tags.iter().any(|t| t == "optix") {
        "OPTIX"
    } else {
        "METAL"
    };
    format!(
        "import bpy; p = bpy.context.preferences.addons['cycles'].preferences; \
         p.compute_device_type = '{kind}'; p.get_devices(); \
         [setattr(d, 'use', d.type == '{kind}') for d in p.devices]"
    )
}

/// Renders a Blender job's frames across a group of the farm; None when it should run here.
pub(crate) fn run(job: Job) -> Option<ExitCode> {
    let started = Instant::now();
    let groups = groups(job.allowed);
    if groups.is_empty() {
        return None;
    }
    let home = corral::home_dir().unwrap_or_default();
    let rel_root = job
        .root
        .strip_prefix(&home)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let rel_cwd = job
        .cwd
        .strip_prefix(&job.root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let files = listing(&job.root);
    let total = job.last - job.first + 1;
    let landing =
        std::env::temp_dir().join(format!("render-frames-{}", uuid::Uuid::new_v4().simple()));
    let mut left: Option<Vec<Piece>> = None;
    let mut made = 0;
    let mut used: Vec<String> = Vec::new();
    for group in &groups {
        // The project, to each machine of the group at once.
        let ready: Vec<&Farmer> = std::thread::scope(|scope| {
            let syncs: Vec<_> = group
                .iter()
                .map(|f| {
                    let (files, root, rel) = (&files, &job.root, &rel_root);
                    scope.spawn(move || match sync(&f.machine, root, rel, files) {
                        Ok(sent) => {
                            queue::say(&format!(
                                "{}: project copy up to date ({sent} sent)",
                                f.machine.name
                            ));
                            Some(f)
                        }
                        Err(e) => {
                            queue::say(&format!("{} sits this one out: {e}", f.machine.name));
                            None
                        }
                    })
                })
                .collect();
            syncs
                .into_iter()
                .filter_map(|s| s.join().ok().flatten())
                .collect()
        });
        if ready.is_empty() {
            continue;
        }
        // Twice as many ranges as machines, so one that finishes early takes another; what a
        // group before it could not render, as it was cut.
        let pieces = left.take().unwrap_or_else(|| {
            let count = ((total / FEWEST) as usize).min(ready.len() * 2).max(1);
            (0..count)
                .map(|n| Piece {
                    n,
                    from: job.first + total * n as u64 / count as u64,
                    to: Some(job.first + total * (n as u64 + 1) / count as u64 - 1),
                    frames: true,
                })
                .collect()
        });
        let count = pieces.len();
        let names: Vec<&str> = ready.iter().map(|f| f.machine.name.as_str()).collect();
        queue::say(&format!(
            "frames {}–{} in {} range{} on {}",
            job.first,
            job.last,
            count,
            if count == 1 { "" } else { "s" },
            names.join(", ")
        ));
        let board = Arc::new(Mutex::new(Board::new(pieces)));
        let places: Vec<(Place, usize)> = ready
            .iter()
            .map(|f| (Place::Mac(f.machine.clone()), 1))
            .collect();
        let by_name = |name: &str| ready.iter().find(|f| f.machine.name == name).copied();
        let run_piece = |place: &Place, piece: &Piece, stop: &std::sync::atomic::AtomicBool| {
            let Place::Mac(machine) = place else {
                return Err("a range runs on a farm machine".to_owned());
            };
            let farmer = by_name(&machine.name).ok_or("not in the group")?;
            range(farmer, &job, &rel_root, &rel_cwd, piece, &landing, stop)
        };
        // The scheduler counts every piece of the board as done before it stops.
        schedule(&board, &places, count, &run_piece);
        let mut board = std::mem::take(&mut *board.lock().unwrap());
        if let Some(e) = board.broken.take() {
            let _ = std::fs::remove_dir_all(&landing);
            return Some(fail(&format!("the render failed at {e}")));
        }
        // Only the machines whose frames came back.
        for (_, folder, name) in &board.done {
            made += place_files(folder, &job.root);
            if !used.contains(name) {
                used.push(name.clone());
            }
        }
        if board.todo.is_empty() {
            break;
        }
        // A group that rendered nothing gives way to the next; one that rendered some leaves the
        // rest here, so a video's frames do not come from two kinds of GPU and a third.
        if board.done.is_empty() {
            queue::say(&format!(
                "{} could not render it; trying the next group",
                names.join(", ")
            ));
            // It cuts the frames again for its own machines.
            left = None;
        } else {
            left = Some(board.todo);
            break;
        }
    }
    let _ = std::fs::remove_dir_all(&landing);
    if used.is_empty() {
        return None;
    }
    // Ranges no group could render, here.
    for piece in left.unwrap_or_default() {
        let mut args = job.args.clone();
        args[job.frames_at] = format!("{}-{}", piece.from, piece.to.unwrap_or(job.last));
        let status = super::split::me()
            .args(["run", "--gpu", "--cores", "4", "--label"])
            .arg(format!("{} · {}", job.label, piece.span()))
            .arg("--")
            .arg("blender")
            .args(&args)
            .status();
        if !status.is_ok_and(|s| s.success()) {
            return Some(fail(&format!("{} failed here too", piece.span())));
        }
    }
    let s = started.elapsed().as_secs();
    println!(
        "rendered frames {}–{} · {} files back from {} · {}m{:02}s",
        job.first,
        job.last,
        made,
        used.join(", "),
        s / 60,
        s % 60
    );
    Some(ExitCode::SUCCESS)
}

/// The end of a range's log that says what went wrong: its last error if it printed one, else
/// its last few lines.
fn why(log: &str) -> String {
    let lines: Vec<&str> = log
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && *l != "Blender quit" && !l.starts_with("Blender "))
        .collect();
    if let Some(error) = lines
        .iter()
        .rev()
        .find(|l| l.contains("Error") || l.starts_with("error"))
    {
        return error.to_string();
    }
    let from = lines.len().saturating_sub(3);
    lines[from..].join(" / ")
}

/// The project's files a render may need: path (with `/`), size, and when each changed.
fn listing(root: &Path) -> Vec<(String, u64, u64)> {
    let mut found = Vec::new();
    let mut walk = vec![root.to_path_buf()];
    while let Some(dir) = walk.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                if !SKIP_DIRS.contains(&name.as_str()) {
                    walk.push(entry.path());
                }
                continue;
            }
            let extension = name.rsplit('.').next().unwrap_or("").to_lowercase();
            if !meta.is_file() || SKIP_EXTENSIONS.contains(&extension.as_str()) {
                continue;
            }
            let Ok(rel) = entry
                .path()
                .strip_prefix(root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
            else {
                continue;
            };
            let changed = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            found.push((rel, meta.len(), changed));
        }
    }
    found
}
/// A body for a request, in a file, for bodies too big for curl's options.
fn post_file(
    machine: &Machine,
    path: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let file = std::env::temp_dir().join(format!(
        "render-slot-{}.json",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&file, body.to_string()).map_err(|e| e.to_string())?;
    let data = format!("data-binary = \"@{}\"", file.display());
    let options = Options::new(
        machine,
        path,
        &[
            "header = \"Content-Type: application/json\"",
            &data,
            "max-time = 600",
        ],
    )
    .map_err(|e| e.to_string());
    let out = options.and_then(|o| {
        Command::new("curl")
            .arg("--config")
            .arg(&o.0)
            .output()
            .map_err(|e| e.to_string())
    });
    let _ = std::fs::remove_file(&file);
    let out = out?;
    let said: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    if !out.status.success() {
        return Err(said["error"]
            .as_str()
            .map_or_else(|| format!("{} did not answer", machine.name), str::to_owned));
    }
    Ok(said)
}
/// Brings a machine's copy of the project up to date; returns how many files went.
fn sync(
    machine: &Machine,
    root: &Path,
    rel: &str,
    files: &[(String, u64, u64)],
) -> Result<usize, String> {
    let plan = post_file(
        machine,
        "/api/corral/farm/sync/plan",
        &serde_json::json!({"dir": rel, "files": files}),
    )?;
    let need: Vec<String> = plan["need"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| p.as_str().map(str::to_owned))
        .collect();
    if need.is_empty() {
        return Ok(0);
    }
    let list = std::env::temp_dir().join(format!(
        "render-slot-{}.list",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&list, need.join("\n")).map_err(|e| e.to_string())?;
    let options = Options::new(
        machine,
        &format!("/api/corral/farm/sync/files?dir={}", encode(rel)),
        &[
            "data-binary = @-",
            "header = \"Content-Type: application/x-tar\"",
        ],
    )
    .map_err(|e| e.to_string())?;
    let sent = Command::new("tar")
        .arg("-cf")
        .arg("-")
        .arg("-T")
        .arg(&list)
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut tar| {
            let out = tar.stdout.take().expect("piped");
            let curl = Command::new("curl")
                .arg("--config")
                .arg(&options.0)
                .stdin(out)
                .output()?;
            tar.wait()?;
            Ok(curl)
        });
    let _ = std::fs::remove_file(&list);
    match sent {
        Ok(out) if out.status.success() => Ok(need.len()),
        Ok(out) => Err(format!(
            "the files did not go: {}",
            String::from_utf8_lossy(&out.stdout).trim()
        )),
        Err(e) => Err(e.to_string()),
    }
}
/// One range of frames on one machine; returns a folder holding what it made, in the project's
/// layout.
fn range(
    farmer: &Farmer,
    job: &Job,
    rel_root: &str,
    rel_cwd: &str,
    piece: &Piece,
    landing: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let machine = &farmer.machine;
    let mut args = job.args.clone();
    args[job.frames_at] = format!("{}-{}", piece.from, piece.to.unwrap_or(job.last));
    let mut command = vec!["blender".to_owned()];
    command.extend(args[..job.script_at].iter().cloned());
    // A script that raises fails the run: Blender otherwise exits 0.
    command.extend(["--python-exit-code".to_owned(), "1".to_owned()]);
    command.extend(["--python-expr".to_owned(), gpu_setup(farmer)]);
    command.extend(args[job.script_at..].iter().cloned());
    let dir = if rel_cwd.is_empty() {
        rel_root.to_owned()
    } else {
        format!("{rel_root}/{rel_cwd}")
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    let jobs = format!("/api/corral/farm/jobs/{id}");
    let body = serde_json::json!({
        "command": command,
        "cores": 4,
        "gpu": true,
        "label": format!("{} · {}", job.label, piece.span()),
        "place": std::env::var("CORRAL_PLACE").unwrap_or_default(),
        "dir": dir,
    });
    ask(machine, &format!("{jobs}/run"), Some(&body))?;
    let cleanup = || {
        let _ = ask(
            machine,
            &format!("{jobs}/delete"),
            Some(&serde_json::json!({})),
        );
    };
    let (code, log) = loop {
        std::thread::sleep(Duration::from_secs(3));
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = ask(
                machine,
                &format!("{jobs}/stop"),
                Some(&serde_json::json!({})),
            );
            cleanup();
            return Err("stopped".into());
        }
        let Ok(status) = ask(machine, &jobs, None) else {
            continue;
        };
        if status["state"] == "done" {
            break (
                status["exit"].as_i64().unwrap_or(-1),
                status["log"].as_str().unwrap_or_default().to_owned(),
            );
        }
    };
    if code != 0 {
        cleanup();
        return Err(why(&log));
    }
    // What the range made: whatever changed in the copy since it started.
    let changed = ask(
        machine,
        &format!("/api/corral/farm/changed?dir={}&job={id}", encode(rel_root)),
        None,
    );
    cleanup();
    let made: Vec<String> = changed?["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f.as_str().map(str::to_owned))
        .collect();
    if made.is_empty() {
        return Err(format!("it made no files: {}", why(&log)));
    }
    let folder = landing.join(format!("{}-{}", piece.n, uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let body = serde_json::json!({"dir": rel_root, "paths": made.join("\n")});
    let request = std::env::temp_dir().join(format!(
        "render-slot-{}.json",
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::write(&request, body.to_string()).map_err(|e| e.to_string())?;
    let data = format!("data-binary = \"@{}\"", request.display());
    let options = Options::new(
        machine,
        "/api/corral/farm/fetch",
        &["header = \"Content-Type: application/json\"", &data],
    )
    .map_err(|e| e.to_string())?;
    let fetched = Command::new("curl")
        .arg("--config")
        .arg(&options.0)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut curl| {
            let out = curl.stdout.take().expect("piped");
            let tar = Command::new("tar")
                .args(["-xf", "-"])
                .current_dir(&folder)
                .stdin(out)
                .status()?;
            Ok(curl.wait()?.success() && tar.success())
        })
        .unwrap_or(false);
    let _ = std::fs::remove_file(&request);
    let _ = ask(
        machine,
        "/api/corral/farm/tidy",
        Some(&serde_json::json!({"dir": rel_root, "paths": made.join("\n")})),
    );
    if !fetched {
        return Err("its files did not come back".into());
    }
    Ok(folder)
}
/// Moves what a range made into the project, at the same places; returns how many files.
fn place_files(folder: &Path, root: &Path) -> usize {
    let mut moved = 0;
    let mut walk = vec![folder.to_path_buf()];
    while let Some(dir) = walk.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk.push(path);
                continue;
            }
            let Ok(rel) = path.strip_prefix(folder) else {
                continue;
            };
            // macOS's `._` sidecars, should a machine's tar still send them.
            if entry.file_name().to_string_lossy().starts_with("._") {
                let _ = std::fs::remove_file(&path);
                continue;
            }
            let target = root.join(rel);
            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if std::fs::rename(&path, &target).is_ok() || std::fs::copy(&path, &target).is_ok() {
                moved += 1;
            }
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_range_script_is_split_and_others_are_not() {
        let dir = std::env::temp_dir().join(format!("blend-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(dir.join("scripts")).unwrap();
        std::fs::write(
            dir.join("scripts/render.py"),
            "sc.render.engine = 'BLENDER_EEVEE'",
        )
        .unwrap();
        std::fs::write(
            dir.join("scripts/gerty.py"),
            "prefs.compute_device_type = 'OPTIX'",
        )
        .unwrap();
        let here = std::env::current_dir().unwrap();
        std::env::set_current_dir(&dir).unwrap();
        let command = |script: &str, rest: &[&str]| -> Vec<String> {
            ["blender", "-b", "--factory-startup", "-P", script, "--"]
                .iter()
                .chain(rest)
                .map(|s| s.to_string())
                .collect()
        };
        let eevee = job(
            &command(
                "scripts/render.py",
                &["--set", "garden", "--frames", "0-367"],
            ),
            "",
        )
        .unwrap();
        assert_eq!(
            (eevee.first, eevee.last, eevee.allowed),
            (0, 367, Allowed::Any)
        );
        assert_eq!(eevee.args[eevee.frames_at], "0-367");
        assert_eq!(eevee.args[eevee.script_at], "-P");
        let optix = job(&command("scripts/gerty.py", &["--frames", "1-647"]), "").unwrap();
        assert_eq!(optix.allowed, Allowed::Gerty);
        // A few frames, a list of frames, or none named: as it is.
        assert!(job(&command("scripts/render.py", &["--frames", "1-3"]), "").is_none());
        assert!(
            job(
                &command("scripts/render.py", &["--frames", "0-99", "--only", "5"]),
                ""
            )
            .is_none()
        );
        assert!(job(&command("scripts/render.py", &["--set", "x"]), "").is_none());
        std::env::set_current_dir(here).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_failed_range_says_its_error() {
        let log = "Blender 5.2.1 LTS (hash x)\nTraceback (most recent call last):\n  File \"render.py\", line 4\nModuleNotFoundError: No module named 'resource'\n\nBlender quit\n";
        assert_eq!(why(log), "ModuleNotFoundError: No module named 'resource'");
        assert_eq!(
            why("one\ntwo\nthree\nfour\nBlender quit\n"),
            "two / three / four"
        );
    }

    #[test]
    fn frames_come_back_without_macos_sidecars() {
        let base = std::env::temp_dir().join(format!("frames-{}", uuid::Uuid::new_v4().simple()));
        let (folder, root) = (base.join("in"), base.join("project"));
        std::fs::create_dir_all(folder.join("renders/x")).unwrap();
        std::fs::write(folder.join("renders/x/f_0001.jpg"), "frame").unwrap();
        std::fs::write(folder.join("renders/x/._f_0001.jpg"), "sidecar").unwrap();
        assert_eq!(place_files(&folder, &root), 1);
        assert!(root.join("renders/x/f_0001.jpg").exists());
        assert!(!root.join("renders/x/._f_0001.jpg").exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}
