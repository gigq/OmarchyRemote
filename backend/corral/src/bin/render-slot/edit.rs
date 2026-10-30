//! A documentary's picture, in pieces at once. Moving Records' editor (`tools/edit.py <ep>`, its
//! own copy in each project) draws every frame from the cut and the footage alone and renders
//! any stretch with `--range a,b` to a file of its choosing with `--out`, frame for frame as the
//! whole picture would have it. So a whole picture is cut on whole seconds, the pieces run at
//! once here through the queue and on the Macs, and they are joined where the editor would have
//! written it.
//!
//! Each copy of the editor works out its length, frame rate and file its own way, so it is asked:
//! the editor runs, up to the moment it would start its encoder, inside a small Python wrapper
//! that reports them. An editor that ends before then (a mode with no picture) runs as it is.
//!
//! A Mac renders in its copy of the project, with only the files the episode reads: the wrapper
//! runs the editor over the episode once with blank footage and notes every file it opens. While
//! a piece renders there, the wrapper notes any file it looked for and did not find; one this
//! machine has is sent, and the piece runs again. The Macs draw the same frames as here (Pillow
//! lays out text with raqm on both, which the Macs' `raqm` tag says), so a picture's pieces can
//! come from both.
use super::blender::{entries, fetch, sync};
use super::split::{Board, Piece, Place, cut, finish, me, took, work};
use super::*;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};

/// Pictures shorter than this render in one piece.
const SHORTEST: f64 = 60.0;
/// No piece is shorter than this, so loading the cut and seeking the footage stays a small part
/// of each.
const PIECE: f64 = 30.0;
/// What a piece asks for: the editor, its encoder's six threads, and the footage's decoders.
const PIECE_CORES: usize = 6;
/// Options that already make the editor render a part, or no picture.
const PARTIAL: [&str; 7] = [
    "--range", "--stills", "--sheet", "--report", "--ranges", "--help", "-h",
];
/// Files in the editor's own folders larger than this are not sent unless it reads them.
const LARGEST_SENT: u64 = 50_000_000;
/// The wrapper around the editor, as `python -c WRAP --render-slot=MODE tools/edit.py <ep> …`:
/// `probe` runs it until it would start encoding and prints what it would render (its length as
/// Python reads it, so the last frame is the editor's own, its frame rate, and its file); `survey`
/// then draws a frame every quarter second with blank footage and adds the files it read; and
/// `watch:FILE` renders as asked and writes to FILE what it looked for and did not find.
const WRAP: &str = r#"
import atexit, io, json, os, subprocess, sys
mode = sys.argv[1].split('=', 1)[1]
script = os.path.abspath(sys.argv[2])
sys.argv = sys.argv[2:]
sys.path.insert(0, os.path.dirname(script))
ROOT = os.path.dirname(os.path.dirname(script))
used = set()
def note(path):
    try:
        path = os.path.abspath(os.fsdecode(path))
    except TypeError:
        return
    if path.startswith(ROOT + os.sep):
        used.add(path)
sys.addaudithook(lambda event, args: note(args[0]) if event == 'open' and isinstance(args[0], (str, bytes, os.PathLike)) else None)
class Ready(Exception):
    pass
class Blank:
    def read(self, n=-1):
        return bytes(max(n, 0))
    def close(self):
        pass
class Stand:
    def __init__(self):
        self.stdout, self.stdin, self.stderr, self.returncode, self.pid = Blank(), io.BytesIO(), Blank(), None, 0
    def poll(self):
        return None
    def wait(self, *args, **kwargs):
        self.returncode = 0
        return 0
    def kill(self):
        pass
    terminate = kill
    def communicate(self, *args, **kwargs):
        return b'', b''
real = subprocess.Popen
def popen(command, *args, **kwargs):
    if isinstance(command, (list, tuple)):
        words = [os.fsdecode(w) if isinstance(w, (bytes, os.PathLike)) else str(w) for w in command]
        pairs = list(zip(words, words[1:]))
        if not mode.startswith('watch') and ('-i', '-') in pairs:
            raise Ready
        for flag, value in pairs:
            if flag == '-i' and value != '-':
                note(value)
        if mode == 'survey' and os.path.basename(words[0]).startswith('ffmpeg') and words[-1] in ('-', 'pipe:', 'pipe:1'):
            return Stand()
    return real(command, *args, **kwargs)
subprocess.Popen = popen
try:
    import cv2
    imread = cv2.imread
    def read_image(path, *args, **kwargs):
        note(path)
        return imread(path, *args, **kwargs)
    cv2.imread = read_image
except ImportError:
    pass
try:
    from PIL import ImageFont
    truetype = ImageFont.truetype
    def font(path=None, *args, **kwargs):
        if isinstance(path, (str, bytes, os.PathLike)):
            note(path)
        return truetype(path, *args, **kwargs)
    ImageFont.truetype = font
except ImportError:
    pass
for name in ('exists', 'isfile'):
    def checked(path, check=getattr(os.path, name)):
        note(path)
        return check(path)
    setattr(os.path, name, checked)
def relative(paths):
    return sorted(os.path.relpath(p, ROOT).replace(os.sep, '/') for p in paths)
if mode.startswith('watch:'):
    missing = os.path.abspath(mode[6:])
    atexit.register(lambda: open(missing, 'w').write(json.dumps(relative(p for p in used if not os.path.exists(p)))))
found = {'__name__': '__main__', '__file__': script}
try:
    exec(compile(open(script).read(), script, 'exec'), found)
except Ready:
    report = {'dur': repr(float(found['DUR'])), 'fps': found['FPS'], 'out': os.path.abspath(found['out'])}
    if mode == 'survey':
        fps, dur = found['FPS'], float(found['DUR'])
        for n in range(0, int(round(dur * fps)), max(1, round(fps / 4))):
            image, key = found['frame_at'](n / fps)
            if 'close_old' in found:
                found['close_old'](key)
        report['files'] = relative(p for p in used if os.path.isfile(p))
    print('RENDER-SLOT-PROBE ' + json.dumps(report), flush=True)
"#;

/// A whole picture to render in pieces: the command as given, and what the editor says of it.
pub(crate) struct Edit {
    /// The command, without an `--out` of its own (each piece has one).
    command: Vec<String>,
    /// Where the editor is in the command.
    script_at: usize,
    episode: String,
    /// The project: the editor's folder's folder.
    root: PathBuf,
    cwd: PathBuf,
    /// The picture's length, as the editor's Python wrote it.
    dur: String,
    fps: f64,
    out: PathBuf,
    label: String,
}

/// The editor's whole picture, if that is what `command` renders.
pub(crate) fn job(command: &[String], label: &str) -> Option<Edit> {
    job_in(command, label, std::env::current_dir().ok()?)
}
fn job_in(command: &[String], label: &str, cwd: PathBuf) -> Option<Edit> {
    if std::env::var("RENDER_SPLIT").is_ok_and(|v| v == "0") {
        return None;
    }
    let script_at = command.iter().position(|a| {
        let path = Path::new(a);
        path.file_name().is_some_and(|n| n == "edit.py")
            && path
                .parent()
                .and_then(|p| p.file_name())
                .is_some_and(|n| n == "tools")
    })?;
    // Run by Python itself (`python`, `python3`, or `uv run … python`).
    let python = Path::new(command.get(script_at.checked_sub(1)?)?)
        .file_name()?
        .to_string_lossy()
        .starts_with("python");
    let episode = command.get(script_at + 1)?;
    if !python || episode.starts_with('-') {
        return None;
    }
    let root = std::fs::canonicalize(cwd.join(&command[script_at]))
        .ok()?
        .parent()?
        .parent()?
        .to_path_buf();
    if !root.join("video").join(episode).join("cut.py").is_file() {
        return None;
    }
    let rest = &command[script_at + 2..];
    if rest.iter().any(|a| PARTIAL.contains(&a.as_str())) {
        return None;
    }
    let probe = ask_editor(&wrapped(command, script_at, "probe"), &cwd)?;
    let dur = probe["dur"].as_str()?.to_owned();
    let fps = probe["fps"].as_f64()?;
    if dur.parse::<f64>().ok()? < SHORTEST || fps <= 0.0 {
        return None;
    }
    Some(Edit {
        command: without_out(command, script_at),
        script_at,
        episode: episode.clone(),
        root,
        cwd,
        dur,
        fps,
        out: PathBuf::from(probe["out"].as_str()?),
        label: if label.is_empty() {
            "picture".into()
        } else {
            label.to_owned()
        },
    })
}

/// `command` with the wrapper around its editor, in `mode`.
fn wrapped(command: &[String], script_at: usize, mode: &str) -> Vec<String> {
    let mut words = command[..script_at].to_vec();
    words.extend(["-c".into(), WRAP.into(), format!("--render-slot={mode}")]);
    words.extend(command[script_at..].iter().cloned());
    words
}

/// What the wrapped editor reported, run as `words` in `cwd`.
fn ask_editor(words: &[String], cwd: &Path) -> Option<serde_json::Value> {
    let report = Command::new(&words[0])
        .args(&words[1..])
        .current_dir(cwd)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let said = String::from_utf8_lossy(&report.stdout);
    let line = said
        .lines()
        .find_map(|l| l.strip_prefix("RENDER-SLOT-PROBE "))?;
    serde_json::from_str(line).ok()
}

/// `command` without its `--out FILE`: the editor takes the first it is given, and each piece
/// names its own.
fn without_out(command: &[String], script_at: usize) -> Vec<String> {
    let mut kept = command[..script_at].to_vec();
    let mut rest = command[script_at..].iter();
    while let Some(arg) = rest.next() {
        if arg == "--out" {
            rest.next();
        } else {
            kept.push(arg.clone());
        }
    }
    kept
}

/// The frames the editor renders from `a` to `b` seconds, counted as it counts them.
fn frames(seconds: f64, fps: f64) -> u64 {
    (seconds * fps).round_ties_even() as u64
}

/// The Macs of the farm that can render a piece, and how many each takes at once.
fn macs() -> Vec<(Machine, usize)> {
    hosts()
        .into_iter()
        .filter_map(|machine| {
            let farm = ask(&machine, "/api/corral/farm", None).ok()?;
            let tags: Vec<&str> = farm["tags"]
                .as_array()?
                .iter()
                .filter_map(|t| t.as_str())
                .collect();
            let fits = ["macos", "uv", "ffmpeg", "raqm"]
                .iter()
                .all(|t| tags.contains(t));
            let cores = farm["queue"]["budget"]["cores"].as_u64().unwrap_or(0) as usize;
            fits.then_some((machine, (cores / PIECE_CORES).max(1)))
        })
        .collect()
}

/// What a Mac needs to render the picture: the files the editor reads, and its own folders.
fn needed(edit: &Edit) -> Result<Vec<(String, u64, u64)>, String> {
    // A light pass, so not one to wait in line behind the pieces the Macs are here to take.
    let survey = ask_editor(&wrapped(&edit.command, edit.script_at, "survey"), &edit.cwd)
        .ok_or("the editor could not say what it reads")?;
    let mut paths: Vec<String> = survey["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| f.as_str().map(str::to_owned))
        .collect();
    for folder in ["tools".to_owned(), format!("video/{}", edit.episode)] {
        paths.extend(small_files(&edit.root, &folder));
    }
    paths.sort();
    paths.dedup();
    Ok(entries(&edit.root, &paths))
}

/// The files of a folder of the project that are small enough to send whether read or not.
fn small_files(root: &Path, folder: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut walk = vec![root.join(folder)];
    while let Some(dir) = walk.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                if entry.file_name() != "__pycache__" {
                    walk.push(entry.path());
                }
            } else if meta.len() <= LARGEST_SENT
                && let Ok(rel) = entry.path().strip_prefix(root)
            {
                found.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    found
}

/// Renders the picture in pieces here and on the Macs and joins them, and exits with how it went.
pub(crate) fn run(edit: Edit) -> ExitCode {
    let started = Instant::now();
    let duration: f64 = edit.dur.parse().unwrap_or_default();
    let slots = (queue::budget().cores / PIECE_CORES).max(1);
    // The Macs render in their copy of the project, from its top.
    let rel_root = edit
        .root
        .strip_prefix(corral::home_dir().unwrap_or_default())
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    let macs = match &rel_root {
        Some(_) if std::fs::canonicalize(&edit.cwd).is_ok_and(|c| c == edit.root) => macs(),
        _ => Vec::new(),
    };
    let room = slots + macs.iter().map(|(_, n)| n).sum::<usize>();
    let count = ((duration / PIECE) as usize).clamp(1, room * 2);
    let Some(folder) = edit.out.parent() else {
        return fail("the editor's file has no folder");
    };
    let pieces_dir = folder.join(format!(".pieces-{}", uuid::Uuid::new_v4().simple()));
    if let Err(e) = std::fs::create_dir_all(&pieces_dir) {
        return fail(&format!("could not make {}: {e}", pieces_dir.display()));
    }
    queue::say(&format!(
        "{} in {count} pieces: {} at a time here{}",
        took(Duration::from_secs_f64(duration)),
        slots.min(count),
        if macs.is_empty() {
            String::new()
        } else {
            let names: Vec<&str> = macs.iter().map(|(m, _)| m.name.as_str()).collect();
            format!(", and on {} once they have its files", names.join(", "))
        }
    ));
    let board = Mutex::new(Board::new(cut(duration, count), &edit.label));
    let rel_root = rel_root.unwrap_or_default();
    let run_piece = |place: &Place, piece: &Piece, stop: &std::sync::atomic::AtomicBool| match place
    {
        Place::Here => piece_here(&edit, piece, &pieces_dir, stop),
        Place::Mac(m) => piece_there(m, &edit, &rel_root, piece, &pieces_dir, stop),
    };
    let unfinished = || {
        let b = board.lock().unwrap();
        b.broken.is_none() && b.done.len() < count
    };
    std::thread::scope(|scope| {
        for _ in 0..slots.min(count) {
            scope.spawn(|| work(&board, &Place::Here, count, &run_piece));
        }
        if macs.is_empty() {
            return;
        }
        // Meanwhile, what the episode reads, to each Mac; each starts taking pieces once it has
        // them.
        scope.spawn(|| {
            let files = match needed(&edit) {
                Ok(files) => files,
                Err(e) => return queue::say(&format!("the Macs sit this one out: {e}")),
            };
            std::thread::scope(|each| {
                for (machine, n) in &macs {
                    let (files, rel_root, edit) = (&files, &rel_root, &edit);
                    let (board, run_piece, unfinished) = (&board, &run_piece, &unfinished);
                    each.spawn(move || {
                        if !unfinished() {
                            return;
                        }
                        match sync(machine, &edit.root, rel_root, files) {
                            Ok(sent) => queue::say(&format!(
                                "{}: has the episode's files ({sent} sent)",
                                machine.name
                            )),
                            Err(e) => {
                                return queue::say(&format!(
                                    "{} sits this one out: {e}",
                                    machine.name
                                ));
                            }
                        }
                        let place = Place::Mac(machine.clone());
                        std::thread::scope(|slot| {
                            for _ in 0..*n {
                                slot.spawn(|| work(board, &place, count, run_piece));
                            }
                        });
                    });
                }
            });
        });
    });
    let board = board.into_inner().unwrap();
    let done_in = |e: &str| {
        let _ = std::fs::remove_dir_all(&pieces_dir);
        fail(e)
    };
    if let Some(e) = board.broken {
        return done_in(&format!("the render failed at {e}"));
    }
    let mut done = board.done;
    done.sort_by_key(|(n, _, _)| *n);
    if done.len() != count || done.iter().any(|(_, f, _)| !f.is_file()) {
        return done_in("a piece went missing before the join");
    }
    // The pieces in order, into the editor's own file.
    let list = pieces_dir.join("list.txt");
    let lines: String = done
        .iter()
        .map(|(_, f, _)| format!("file '{}'\n", f.display()))
        .collect();
    let joined = pieces_dir.join("joined.mp4");
    let ok = std::fs::write(&list, lines).is_ok()
        && Command::new("ffmpeg")
            .args(["-nostdin", "-y", "-loglevel", "error", "-f", "concat"])
            .args(["-safe", "0", "-i"])
            .arg(&list)
            .args(["-map", "0:v", "-c", "copy", "-movflags", "+faststart"])
            .arg(&joined)
            .status()
            .is_ok_and(|s| s.success());
    if !ok {
        return done_in("joining the pieces failed");
    }
    // Every frame, as the whole picture would have had them.
    let want = frames(duration, edit.fps);
    let have = counted(&joined);
    if have != Some(want) {
        return done_in(&format!(
            "the joined picture has {} frames, not {want}",
            have.map_or("unknown".into(), |n| n.to_string())
        ));
    }
    if std::fs::rename(&joined, &edit.out).is_err() {
        return done_in(&format!("could not write {}", edit.out.display()));
    }
    let _ = std::fs::remove_dir_all(&pieces_dir);
    let shown = edit
        .out
        .strip_prefix(&edit.cwd)
        .unwrap_or(&edit.out)
        .display()
        .to_string();
    let mut places: Vec<&str> = done.iter().map(|(_, _, p)| p.as_str()).collect();
    places.sort();
    places.dedup();
    println!(
        "wrote {shown} · {want} frames in {count} pieces on {} · {}",
        places.join(", "),
        took(started.elapsed())
    );
    ExitCode::SUCCESS
}

/// The editor's options for a piece: from where it starts to where the next begins.
fn range(edit: &Edit, piece: &Piece) -> String {
    let to = piece.to.map_or_else(|| edit.dur.clone(), |t| t.to_string());
    format!("{},{to}", piece.from)
}

/// Whether a piece's file holds every frame it should.
fn whole_piece(edit: &Edit, piece: &Piece, file: PathBuf) -> Result<PathBuf, String> {
    let end = piece
        .to
        .map_or(edit.dur.parse().unwrap_or_default(), |t| t as f64);
    let want = frames(end, edit.fps) - frames(piece.from as f64, edit.fps);
    match counted(&file) {
        Some(n) if n == want => Ok(file),
        n => Err(format!(
            "it has {} frames, not {want}",
            n.map_or("unknown".into(), |n| n.to_string())
        )),
    }
}

/// One piece through this machine's queue, to a file of its own.
fn piece_here(
    edit: &Edit,
    piece: &Piece,
    pieces: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let file = pieces.join(format!(
        "piece-{:04}-{}.mp4",
        piece.n,
        uuid::Uuid::new_v4().simple()
    ));
    let log = file.with_extension("log");
    let output = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let errors = output.try_clone().map_err(|e| e.to_string())?;
    let mut child = me()
        .args(["run", "--cores", &PIECE_CORES.to_string(), "--label"])
        .arg(format!("{} · piece {}", edit.label, piece.n + 1))
        .arg("--")
        .args(&edit.command)
        .arg("--range")
        .arg(range(edit, piece))
        .arg("--out")
        .arg(&file)
        .current_dir(&edit.cwd)
        .stdout(output)
        .stderr(errors)
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = match finish(&mut child, stop) {
        Ok(status) => status,
        Err(e) => {
            let _ = std::fs::remove_file(&file);
            return Err(e);
        }
    };
    if !status.success() || !file.is_file() {
        let tail = std::fs::read_to_string(&log).unwrap_or_default();
        let last: Vec<&str> = tail.lines().filter(|l| !l.trim().is_empty()).collect();
        return Err(last[last.len().saturating_sub(2)..].join(" / "));
    }
    whole_piece(edit, piece, file)
}

/// One piece on a Mac, in its copy of the project; a file it looked for and this machine has is
/// sent, and the piece runs again.
fn piece_there(
    machine: &Machine,
    edit: &Edit,
    rel_root: &str,
    piece: &Piece,
    pieces: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let script = std::fs::canonicalize(edit.cwd.join(&edit.command[edit.script_at]))
        .ok()
        .and_then(|s| {
            s.strip_prefix(&edit.root)
                .ok()
                .map(|p| p.to_string_lossy().replace('\\', "/"))
        })
        .ok_or("the editor is not in the project")?;
    for _ in 0..3 {
        let name = format!(".piece-{:04}-{}", piece.n, uuid::Uuid::new_v4().simple());
        let (file, missing) = (format!("{name}.mp4"), format!("{name}.missing.json"));
        // The programs by name: the Mac knows where its own are.
        let program = Path::new(&edit.command[0]).file_name().map_or_else(
            || edit.command[0].clone(),
            |n| n.to_string_lossy().into_owned(),
        );
        let mut command = vec![program];
        command.extend(edit.command[1..edit.script_at].iter().cloned());
        command.extend([
            "-c".into(),
            WRAP.into(),
            format!("--render-slot=watch:{missing}"),
            script.clone(),
        ]);
        command.extend(edit.command[edit.script_at + 1..].iter().cloned());
        command.extend([
            "--range".into(),
            range(edit, piece),
            "--out".into(),
            file.clone(),
        ]);
        let id = uuid::Uuid::new_v4().simple().to_string();
        let jobs = format!("/api/corral/farm/jobs/{id}");
        let body = serde_json::json!({
            "command": command,
            "cores": PIECE_CORES,
            "gpu": false,
            "label": format!("{} · piece {}", edit.label, piece.n + 1),
            "place": std::env::var("CORRAL_PLACE").unwrap_or_default(),
            "dir": rel_root,
        });
        ask(machine, &format!("{jobs}/run"), Some(&body))?;
        let forget = || {
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
                forget();
                let _ = ask(
                    machine,
                    "/api/corral/farm/tidy",
                    Some(
                        &serde_json::json!({"dir": rel_root, "paths": format!("{file}\n{missing}")}),
                    ),
                );
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
        forget();
        let landing = pieces.join(&name[1..]);
        std::fs::create_dir_all(&landing).map_err(|e| e.to_string())?;
        // The piece, and what it could not find; a failed one leaves no picture.
        let back = fetch(
            machine,
            rel_root,
            &[file.clone(), missing.clone()],
            &landing,
        );
        let wanted: Vec<String> = std::fs::read_to_string(landing.join(&missing))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        let have = entries(&edit.root, &wanted);
        if !have.is_empty() {
            let _ = std::fs::remove_dir_all(&landing);
            sync(machine, &edit.root, rel_root, &have)?;
            queue::say(&format!(
                "{}: sent {} file{} piece {} looked for; it runs again",
                machine.name,
                have.len(),
                if have.len() == 1 { "" } else { "s" },
                piece.n + 1
            ));
            continue;
        }
        if code != 0 || !back || !landing.join(&file).is_file() {
            let _ = std::fs::remove_dir_all(&landing);
            let last: Vec<&str> = log.lines().filter(|l| !l.trim().is_empty()).collect();
            return Err(last[last.len().saturating_sub(2)..].join(" / "));
        }
        let kept = pieces.join(format!("{}.mp4", &name[1..]));
        std::fs::rename(landing.join(&file), &kept).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&landing);
        return whole_piece(edit, piece, kept);
    }
    Err("it kept looking for files".into())
}

/// How many frames a video file holds.
fn counted(path: &Path) -> Option<u64> {
    let out = Command::new("ffprobe")
        .args(["-v", "error", "-select_streams", "v:0", "-count_packets"])
        .args(["-show_entries", "stream=nb_read_packets", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_whole_picture_drops_its_own_out_and_counts_frames_as_python_does() {
        let command: Vec<String> = [
            "uv",
            "run",
            "python",
            "tools/edit.py",
            "dust",
            "--out",
            "x.mp4",
            "--modern",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(
            without_out(&command, 3),
            ["uv", "run", "python", "tools/edit.py", "dust", "--modern"]
        );
        assert_eq!(frames(575.6333333333333, 30.0), 17269);
        assert_eq!(frames(30.0, 120.0), 3600);
        // Halves round to even, as Python's round() does.
        assert_eq!(frames(0.5, 5.0), 2);
        assert_eq!(frames(0.5, 3.0), 2);
    }

    /// A project with an editor shaped as the house's: it works out its length and file, then
    /// encodes; each frame reads a clip through ffmpeg, and from 10 s on a still as well.
    fn project() -> PathBuf {
        let root = std::env::temp_dir().join(format!("edit-{}", uuid::Uuid::new_v4().simple()));
        for dir in ["tools", "video/dust", "archive/clips", "archive/unused"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            "video/dust/cut.py",
            "archive/clips/a.mp4",
            "archive/still.jpg",
            "archive/unused/b.mp4",
        ] {
            std::fs::write(root.join(file), "x").unwrap();
        }
        std::fs::write(
            root.join("tools/edit.py"),
            r#"import os, subprocess, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = sys.argv[1:]
EP = args[0]
opt = lambda k, d=None: args[args.index('--' + k) + 1] if '--' + k in args else d
if '--stills' in args or '--quiet' in args:
    sys.exit()
FPS = 30
DUR = 575.6333333333333
def frame_at(t):
    try:
        subprocess.Popen(['ffmpeg', '-i', os.path.join(ROOT, 'archive/clips/a.mp4'), '-f', 'rawvideo', '-'], stdout=subprocess.PIPE)
    except OSError:
        pass
    if t >= 10:
        open(os.path.join(ROOT, 'archive/still.jpg')).read()
    return None, 0
out = opt('out', os.path.join(ROOT, 'out', f'_{EP}-picture.mp4'))
try:
    enc = subprocess.Popen(['ffmpeg', '-f', 'rawvideo', '-i', '-', out], stdin=subprocess.PIPE)
except OSError:
    enc = None
a, b = map(float, opt('range', '0,1').split(','))
frame_at(b)
"#,
        )
        .unwrap();
        root
    }

    fn python() -> Option<String> {
        let out = Command::new("which").arg("python3").output().ok()?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        (!path.is_empty()).then_some(path)
    }

    #[test]
    fn the_editor_says_what_it_would_render_and_other_modes_run_as_they_are() {
        let Some(python) = python() else {
            return;
        };
        let root = project();
        let job = |command: &[String], label: &str| job_in(command, label, root.clone());
        let command = |rest: &[&str]| -> Vec<String> {
            [python.as_str(), "tools/edit.py", "dust"]
                .iter()
                .chain(rest)
                .map(|s| s.to_string())
                .collect()
        };
        let whole = job(&command(&[]), "").unwrap();
        assert_eq!((whole.dur.as_str(), whole.fps), ("575.6333333333333", 30.0));
        assert_eq!(
            whole.out,
            std::fs::canonicalize(&root)
                .unwrap()
                .join("out/_dust-picture.mp4")
        );
        let named = job(&command(&["--out", "elsewhere.mp4"]), "").unwrap();
        assert!(named.out.ends_with("elsewhere.mp4"));
        assert!(!named.command.contains(&"--out".to_string()));
        // A part, or a mode with no picture: as it is.
        assert!(job(&command(&["--range", "30,60"]), "").is_none());
        assert!(job(&command(&["--stills", "12.5"]), "").is_none());
        assert!(job(&command(&["--quiet"]), "").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_survey_finds_the_files_an_episode_reads_and_only_those() {
        let Some(python) = python() else {
            return;
        };
        let root = project();
        let command: Vec<String> = [python.as_str(), "tools/edit.py", "dust"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let survey = ask_editor(&wrapped(&command, 1, "survey"), &root).unwrap();
        let files: Vec<&str> = survey["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f.as_str())
            .collect();
        assert!(files.contains(&"archive/clips/a.mp4"), "{files:?}");
        assert!(files.contains(&"archive/still.jpg"), "{files:?}");
        assert!(files.contains(&"tools/edit.py"), "{files:?}");
        assert!(!files.contains(&"archive/unused/b.mp4"), "{files:?}");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_watched_piece_says_what_it_could_not_find() {
        let Some(python) = python() else {
            return;
        };
        let root = project();
        std::fs::remove_file(root.join("archive/still.jpg")).unwrap();
        let missing = root.join("missing.json");
        // It runs for real, with no ffmpeg to find: only what it looked for counts.
        let words: Vec<String> = [
            python.as_str(),
            "-c",
            WRAP,
            &format!("--render-slot=watch:{}", missing.display()),
            "tools/edit.py",
            "dust",
            "--range",
            "0,20",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        let _ = Command::new(&words[0])
            .args(&words[1..])
            .current_dir(&root)
            .env("PATH", "/nonexistent")
            .stderr(std::process::Stdio::null())
            .status();
        let said: Vec<String> =
            serde_json::from_str(&std::fs::read_to_string(&missing).unwrap()).unwrap();
        assert_eq!(said, ["archive/still.jpg"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
