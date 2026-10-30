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
    /// The frames, as spans from first to last: one, or a list (`1-99,124-521`).
    spans: Vec<(u64, u64)>,
    cwd: PathBuf,
    root: PathBuf,
    allowed: Allowed,
    label: String,
}
/// The project a render belongs to: the nearest folder up from `cwd` with an `AGENTS.md`.
/// A `--frames` value's spans: `A-B`, or several, comma-separated. A single frame, a step, or
/// spans out of order: not one to split.
fn spans(value: &str) -> Option<Vec<(u64, u64)>> {
    let mut spans: Vec<(u64, u64)> = Vec::new();
    for part in value.split(',') {
        let (a, b) = part.trim().split_once('-')?;
        let (a, b): (u64, u64) = (a.parse().ok()?, b.parse().ok()?);
        if b < a || spans.last().is_some_and(|(_, end)| a <= *end) {
            return None;
        }
        spans.push((a, b));
    }
    (!spans.is_empty()).then_some(spans)
}
/// `count` ranges of the spans' frames, each span cut in proportion to its length, so no range
/// crosses from one span to the next.
fn ranges(spans: &[(u64, u64)], count: usize) -> Vec<Piece> {
    let total: u64 = spans.iter().map(|(a, b)| b - a + 1).sum();
    let mut pieces = Vec::new();
    for (a, b) in spans {
        let length = b - a + 1;
        let share = ((count as u64 * length).div_ceil(total)).clamp(1, length) as usize;
        for k in 0..share as u64 {
            pieces.push(Piece {
                n: pieces.len(),
                from: a + length * k / share as u64,
                to: Some(a + length * (k + 1) / share as u64 - 1),
                frames: true,
            });
        }
    }
    pieces
}
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
    let spans = spans(args.get(frames_at)?)?;
    if spans.iter().map(|(a, b)| b - a + 1).sum::<u64>() < FEWEST {
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
        spans,
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
            let jobs: Vec<&serde_json::Value> =
                q["jobs"].as_array().into_iter().flatten().collect();
            let busy = jobs
                .iter()
                .filter(|j| j["running"] == true && j["gpu"] == true)
                .count() as u64;
            // Free means nothing in line either: a long render between its ranges is not.
            let waiting = jobs.iter().any(|j| j["running"] == false);
            Some(Farmer {
                machine,
                tags,
                gpu_free: busy < seats && !waiting,
            })
        })
        .filter(|f| f.tags.iter().any(|t| t == "blender"))
        .collect()
}
/// The groups a render can go to, in the order to try them: gerty alone, or the Macs together.
/// Gerty comes first while its GPU is free; a group that fails before it renders a frame gives
/// way to the next.
fn groups(allowed: Allowed, windows: bool) -> Vec<Vec<Farmer>> {
    if allowed == Allowed::Here {
        return Vec::new();
    }
    let (mut gerty, macs): (Vec<Farmer>, Vec<Farmer>) = farmers()
        .into_iter()
        .filter(|f| f.tags.iter().any(|t| t == "optix" || t == "metal"))
        .partition(|f| f.tags.iter().any(|t| t == "optix"));
    gerty.truncate(if windows { 1 } else { 0 });
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
/// Run before the script here: it renders nothing, and at the script's first render prints every
/// file the render has read, those Python opened and those Blender loaded (scenes, linked
/// libraries, images, sounds, fonts), then quits.
const SURVEY: &str = r#"
import atexit, json, os, sys, bpy
used = set()
def note(path):
    try:
        used.add(os.path.abspath(os.fsdecode(path)))
    except TypeError:
        pass
sys.addaudithook(lambda event, args: note(args[0]) if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)) else None)
said = []
def report(live=True):
    if said:
        return
    said.append(True)
    # Modules it imported, which Python finds without an open the hook sees.
    for module in list(sys.modules.values()):
        if getattr(module, '__file__', None):
            note(module.__file__)
    # Blender's data is gone by the time Python exits: asking for it then crashes.
    if live:
        for path in bpy.utils.blend_paths(absolute=True, packed=False, local=False):
            note(path)
        if bpy.data.filepath:
            note(bpy.data.filepath)
    print('RENDER-SLOT-SURVEY ' + json.dumps(sorted(p for p in used if os.path.isfile(p))), flush=True)
real = bpy.ops.render
class Render:
    def __getattr__(self, name):
        if name != 'render':
            return getattr(real, name)
        def first(*args, **kwargs):
            report()
            os._exit(0)
        return first
bpy.ops.render = Render()
atexit.register(report, False)
"#;
/// Run before the script on a farm machine, with `UP` (the project copy's top, from the folder
/// the render runs in) and `OUT` (a file there) set: writes to `OUT` each file of the project the
/// render looked for and did not find, Python's and Blender's (a missing image renders pink).
const WATCH: &str = r#"
import atexit, json, os, sys, bpy
ROOT = os.path.normpath(os.path.join(os.getcwd(), UP))
used = set()
def note(path):
    try:
        used.add(os.path.abspath(os.fsdecode(path)))
    except TypeError:
        pass
sys.addaudithook(lambda event, args: note(args[0]) if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)) else None)
def check(live=True):
    # Blender's data is gone by the time Python exits: asking for it then crashes.
    if live:
        for path in bpy.utils.blend_paths(absolute=True, packed=False, local=False):
            note(path)
    missing = sorted(os.path.relpath(p, ROOT).replace(os.sep, '/') for p in used if p.startswith(ROOT + os.sep) and not os.path.exists(p))
    with open(os.path.join(ROOT, OUT), 'w') as f:
        json.dump(missing, f)
bpy.app.handlers.render_pre.append(bpy.app.handlers.persistent(lambda *args: check()))
atexit.register(check, False)
"#;
/// `source` as one `--python-expr`, with `names` set first: a single line, however the machine's
/// shell or Windows passes it on.
fn python_expr(source: &str, names: &[(&str, &str)]) -> String {
    let mut code = String::new();
    for (name, value) in names {
        code.push_str(&format!(
            "{name} = {}\n",
            serde_json::to_string(value).unwrap_or_default()
        ));
    }
    code.push_str(source);
    format!("exec({})", serde_json::to_string(&code).unwrap_or_default())
}
/// The files a render reads, found by running it here up to its first render; with the script
/// and the files beside it, which Blender reads without Python seeing. None if it cannot tell.
fn survey(job: &Job) -> Option<Vec<PathBuf>> {
    let mut args = job.args.clone();
    args.splice(
        job.script_at..job.script_at,
        ["--python-expr".to_owned(), SURVEY.to_owned()],
    );
    // `blender` on the path may be render-slot's own door: this run is not a render to queue.
    let out = Command::new("blender")
        .env(super::JOB, "survey")
        .args(&args)
        .current_dir(&job.cwd)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let said = String::from_utf8_lossy(&out.stdout);
    let line = said
        .lines()
        .find_map(|l| l.strip_prefix("RENDER-SLOT-SURVEY "))?;
    let mut files: Vec<PathBuf> = serde_json::from_str::<Vec<String>>(line)
        .ok()?
        .into_iter()
        .map(PathBuf::from)
        .collect();
    let script = job.cwd.join(&job.args[job.script_at + 1]);
    if let Some(dir) = script.parent() {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if entry
                .metadata()
                .is_ok_and(|m| m.is_file() && m.len() <= BESIDE_SCRIPT)
            {
                files.push(entry.path());
            }
        }
    }
    files.push(script);
    files.sort();
    files.dedup();
    Some(files)
}
/// Whether Python source imports a module Windows does not have.
fn unix_only(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        ["resource", "fcntl", "termios", "pwd", "grp"]
            .iter()
            .any(|m| {
                line.starts_with(&format!("import {m}"))
                    && line[7 + m.len()..]
                        .chars()
                        .next()
                        .is_none_or(|c| !c.is_alphanumeric() && c != '_')
                    || line.starts_with(&format!("from {m} import"))
            })
            || line.starts_with("import ") && line.contains(", resource")
    })
}
/// Files beside the script larger than this go only if the render reads them.
const BESIDE_SCRIPT: u64 = 50_000_000;
/// The folder to copy: the project, or, when the render reads files elsewhere in the home
/// folder (shared assets), the nearest folder that holds them all, short of the home folder.
fn widen(root: &Path, files: &[PathBuf], home: &Path) -> PathBuf {
    let mut wide = root.to_path_buf();
    for file in files.iter().filter(|f| f.starts_with(home)) {
        while !file.starts_with(&wide) && wide.pop() {}
    }
    if wide.starts_with(home) && wide != home {
        wide
    } else {
        root.to_path_buf()
    }
}
/// Each of `paths` (relative to `root`) that this machine has, with its size and when it
/// changed, for a sync.
pub(crate) fn entries(root: &Path, paths: &[String]) -> Vec<(String, u64, u64)> {
    paths
        .iter()
        .filter_map(|p| {
            let meta = std::fs::metadata(root.join(p)).ok()?;
            let changed = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs();
            meta.is_file().then(|| (p.clone(), meta.len(), changed))
        })
        .collect()
}
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
    let read = survey(&job);
    // A script that loads a module only Linux and macOS have does not run on gerty.
    let windows = !read.iter().flatten().any(|f| {
        f.extension().is_some_and(|e| e == "py")
            && std::fs::read_to_string(f).is_ok_and(|text| unix_only(&text))
    });
    let groups = groups(job.allowed, windows);
    if groups.is_empty() {
        return None;
    }
    let home = corral::home_dir().unwrap_or_default();
    // Only what the render reads goes; the whole project, if that cannot be told.
    let (root, files) = match read {
        Some(read) => {
            let root = widen(&job.root, &read, &home);
            let rel: Vec<String> = read
                .iter()
                .filter_map(|f| f.strip_prefix(&root).ok())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .collect();
            let files = entries(&root, &rel);
            let size: u64 = files.iter().map(|(_, n, _)| n).sum();
            queue::say(&format!(
                "it reads {} files ({:.1} GB)",
                files.len(),
                size as f64 / 1e9
            ));
            (root, files)
        }
        None => {
            queue::say("could not tell what it reads; the project goes as it is");
            (job.root.clone(), listing(&job.root))
        }
    };
    let rel_root = root
        .strip_prefix(&home)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let rel_cwd = job
        .cwd
        .strip_prefix(&root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    let total: u64 = job.spans.iter().map(|(a, b)| b - a + 1).sum();
    let frames = job.args[job.frames_at].clone();
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
                    let (files, root, rel) = (&files, &root, &rel_root);
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
            ranges(&job.spans, count)
        });
        let count = pieces.len();
        let names: Vec<&str> = ready.iter().map(|f| f.machine.name.as_str()).collect();
        queue::say(&format!(
            "frames {frames} in {} range{} on {}",
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
            range(
                farmer, &job, &root, &rel_root, &rel_cwd, piece, &landing, stop,
            )
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
            made += place_files(folder, &root);
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
        args[job.frames_at] = format!("{}-{}", piece.from, piece.to.unwrap_or(piece.from));
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
        "rendered frames {frames} · {} files back from {} · {}m{:02}s",
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
    if let Some(at) = log.lines().find(|l| l.contains("crash.txt")) {
        return format!("Blender crashed ({})", at.trim());
    }
    let lines: Vec<&str> = log
        .lines()
        .map(str::trim)
        .filter(|l| {
            !l.is_empty()
                && !l.starts_with("[render-slot]")
                && *l != "Blender quit"
                && !l.starts_with("Blender ")
                && !l.starts_with("Error: script failed")
        })
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
pub(crate) fn sync(
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
#[allow(clippy::too_many_arguments)]
fn range(
    farmer: &Farmer,
    job: &Job,
    root: &Path,
    rel_root: &str,
    rel_cwd: &str,
    piece: &Piece,
    landing: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let machine = &farmer.machine;
    let mut args = job.args.clone();
    args[job.frames_at] = format!("{}-{}", piece.from, piece.to.unwrap_or(piece.from));
    let dir = if rel_cwd.is_empty() {
        rel_root.to_owned()
    } else {
        format!("{rel_root}/{rel_cwd}")
    };
    // From the folder it runs in, back to the copy's top.
    let up = if rel_cwd.is_empty() {
        ".".to_owned()
    } else {
        vec![".."; rel_cwd.split('/').count()].join("/")
    };
    // A file it looks for and this machine has is sent, and the range runs again.
    for _ in 0..3 {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let missing = format!(".piece-{id}.missing.json");
        let mut command = vec!["blender".to_owned()];
        command.extend(args[..job.script_at].iter().cloned());
        // A script that raises fails the run: Blender otherwise exits 0.
        command.extend(["--python-exit-code".to_owned(), "1".to_owned()]);
        command.extend(["--python-expr".to_owned(), gpu_setup(farmer)]);
        command.extend([
            "--python-expr".to_owned(),
            python_expr(WATCH, &[("UP", &up), ("OUT", &missing)]),
        ]);
        command.extend(args[job.script_at..].iter().cloned());
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
        // What the range made (whatever changed in the copy since it started), and what it
        // could not find; both come back, which also clears them from the copy.
        let changed = ask(
            machine,
            &format!("/api/corral/farm/changed?dir={}&job={id}", encode(rel_root)),
            None,
        );
        cleanup();
        let mut made: Vec<String> = changed?["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| f.as_str().map(str::to_owned))
            .collect();
        let folder = landing.join(format!("{}-{id}", piece.n));
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let back = made.is_empty() || fetch(machine, rel_root, &made, &folder);
        let wanted: Vec<String> = std::fs::read_to_string(folder.join(&missing))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let _ = std::fs::remove_file(folder.join(&missing));
        made.retain(|m| *m != missing);
        let have = entries(root, &wanted);
        if !have.is_empty() {
            let _ = std::fs::remove_dir_all(&folder);
            sync(machine, root, rel_root, &have)?;
            queue::say(&format!(
                "{}: sent {} file{} {} looked for; it runs again",
                machine.name,
                have.len(),
                if have.len() == 1 { "" } else { "s" },
                piece.span()
            ));
            continue;
        }
        if code != 0 || made.is_empty() || !back {
            let _ = std::fs::remove_dir_all(&folder);
            return Err(if code != 0 {
                why(&log)
            } else if made.is_empty() {
                format!("it made no files: {}", why(&log))
            } else {
                "its files did not come back".into()
            });
        }
        return Ok(folder);
    }
    Err("it kept looking for files".into())
}

/// Brings `paths` of a machine's project copy into `folder`, and removes them there.
pub(crate) fn fetch(machine: &Machine, rel_root: &str, paths: &[String], folder: &Path) -> bool {
    let body = serde_json::json!({"dir": rel_root, "paths": paths.join("\n")});
    let request = std::env::temp_dir().join(format!(
        "render-slot-{}.json",
        uuid::Uuid::new_v4().simple()
    ));
    if std::fs::write(&request, body.to_string()).is_err() {
        return false;
    }
    let data = format!("data-binary = \"@{}\"", request.display());
    let Ok(options) = Options::new(
        machine,
        "/api/corral/farm/fetch",
        &["header = \"Content-Type: application/json\"", &data],
    ) else {
        let _ = std::fs::remove_file(&request);
        return false;
    };
    let fetched = Command::new("curl")
        .arg("--config")
        .arg(&options.0)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .and_then(|mut curl| {
            let out = curl.stdout.take().expect("piped");
            let tar = Command::new("tar")
                .args(["-xf", "-"])
                .current_dir(folder)
                .stdin(out)
                .status()?;
            Ok(curl.wait()?.success() && tar.success())
        })
        .unwrap_or(false);
    let _ = std::fs::remove_file(&request);
    let _ = ask(
        machine,
        "/api/corral/farm/tidy",
        Some(&serde_json::json!({"dir": rel_root, "paths": paths.join("\n")})),
    );
    fetched
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
        assert_eq!((eevee.spans, eevee.allowed), (vec![(0, 367)], Allowed::Any));
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
    fn the_copy_widens_to_shared_files_but_never_to_home() {
        let home = Path::new("/home/me");
        let root = Path::new("/home/me/git/show/episode");
        let inside = [PathBuf::from("/home/me/git/show/episode/scene.blend")];
        assert_eq!(widen(root, &inside, home), root);
        let shared = [
            PathBuf::from("/home/me/git/show/episode/scene.blend"),
            PathBuf::from("/home/me/git/show/assets/wood.png"),
            PathBuf::from("/usr/share/blender/brushes.blend"),
        ];
        assert_eq!(widen(root, &shared, home), Path::new("/home/me/git/show"));
        let elsewhere = [PathBuf::from("/home/me/Downloads/wood.png")];
        assert_eq!(widen(root, &elsewhere, home), root);
    }

    #[test]
    fn scripts_that_need_unix_are_kept_off_windows() {
        assert!(unix_only("import bpy\n    import resource\n"));
        assert!(unix_only("from fcntl import flock"));
        assert!(unix_only("import os, resource"));
        assert!(!unix_only("import resources_pack\nimport bpy"));
        assert!(!unix_only("# import resource someday"));
    }

    #[test]
    fn python_for_blender_is_one_line_with_its_values_set() {
        let expr = python_expr(
            "print(UP, OUT)\n",
            &[("UP", "../.."), ("OUT", "a \"b\".json")],
        );
        assert!(!expr.contains('\n'));
        assert!(expr.starts_with("exec(\"") && expr.ends_with("\")"));
        assert!(expr.contains(r#"UP = \"../..\""#), "{expr}");
    }

    #[test]
    fn a_list_of_spans_is_cut_within_each_span() {
        assert_eq!(spans("1-99,124-521"), Some(vec![(1, 99), (124, 521)]));
        for not_one in ["5", "1-99,50-60", "9-1", "1-9,x"] {
            assert_eq!(spans(not_one), None, "{not_one}");
        }
        let pieces = ranges(&[(1, 99), (124, 521)], 6);
        let cut: Vec<(u64, u64)> = pieces.iter().map(|p| (p.from, p.to.unwrap())).collect();
        // Every frame once, in order, and none across the gap.
        let frames: Vec<u64> = cut.iter().flat_map(|&(a, b)| a..=b).collect();
        let wanted: Vec<u64> = (1..=99).chain(124..=521).collect();
        assert_eq!(frames, wanted);
        assert!(cut.iter().all(|&(a, b)| b <= 99 || a >= 124));
        assert!(pieces.iter().enumerate().all(|(n, p)| p.n == n));
    }

    #[test]
    fn a_failed_range_says_its_error() {
        let log = "Blender 5.2.1 LTS (hash x)\nTraceback (most recent call last):\n  File \"render.py\", line 4\nModuleNotFoundError: No module named 'resource'\nError: script failed, file: 'render.py', exiting.\n\nBlender quit\n";
        assert_eq!(why(log), "ModuleNotFoundError: No module named 'resource'");
        assert_eq!(
            why("one\ntwo\nthree\nfour\nBlender quit\n"),
            "two / three / four"
        );
        // Not the command line it echoes, which may hold the word.
        assert_eq!(
            why(
                "[render-slot] got a turn: x TypeError\nSegmentation fault\nWriting: /tmp/blender.crash.txt\n"
            ),
            "Blender crashed (Writing: /tmp/blender.crash.txt)"
        );
        assert_eq!(
            why("[render-slot] got a turn: x TypeError\nreal trouble\n"),
            "real trouble"
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
