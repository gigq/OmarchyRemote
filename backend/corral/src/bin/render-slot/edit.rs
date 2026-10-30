//! A documentary's picture, in pieces at once. Moving Records' editor (`tools/edit.py <ep>`, its
//! own copy in each project) draws every frame from the cut and the footage alone and renders
//! any stretch with `--range a,b` to a file of its choosing with `--out`, frame for frame as the
//! whole picture would have it. So a whole picture is cut on whole seconds, the pieces run here
//! side by side through the queue, and they are joined where the editor would have written it.
//!
//! Each copy of the editor works out its length, frame rate and file its own way, so it is asked:
//! the editor runs, up to the moment it would start its encoder, inside a small Python wrapper
//! that reports them. An editor that ends before then (a mode with no picture) runs as it is.
use super::split::{Board, Piece, Place, cut, finish, me, schedule, took};
use super::*;
use std::{
    path::{Path, PathBuf},
    sync::Mutex,
    time::Instant,
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
/// Runs the editor as asked until it would start encoding, then prints what it was about to
/// render: its length (as Python reads it, so the last frame is the editor's own), frame rate,
/// and file.
const PROBE: &str = r#"
import json, os, subprocess, sys
script = os.path.abspath(sys.argv[1])
sys.argv = sys.argv[1:]
sys.path.insert(0, os.path.dirname(script))
class Ready(Exception):
    pass
real = subprocess.Popen
def popen(command, *args, **kwargs):
    if isinstance(command, (list, tuple)) and any(command[i] == '-i' and command[i + 1] == '-' for i in range(len(command) - 1)):
        raise Ready
    return real(command, *args, **kwargs)
subprocess.Popen = popen
found = {'__name__': '__main__', '__file__': script}
try:
    exec(compile(open(script).read(), script, 'exec'), found)
except Ready:
    print('RENDER-SLOT-PROBE ' + json.dumps({'dur': repr(float(found['DUR'])), 'fps': found['FPS'], 'out': os.path.abspath(found['out'])}), flush=True)
"#;

/// A whole picture to render in pieces: the command as given, and what the editor says of it.
pub(crate) struct Edit {
    /// The command, without an `--out` of its own (each piece has one).
    command: Vec<String>,
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
    let report = Command::new(&command[0])
        .args(&command[1..script_at])
        .arg("-c")
        .arg(PROBE)
        .args(&command[script_at..])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    let said = String::from_utf8_lossy(&report.stdout);
    let line = said
        .lines()
        .find_map(|l| l.strip_prefix("RENDER-SLOT-PROBE "))?;
    let probe: serde_json::Value = serde_json::from_str(line).ok()?;
    let dur = probe["dur"].as_str()?.to_owned();
    let fps = probe["fps"].as_f64()?;
    if dur.parse::<f64>().ok()? < SHORTEST || fps <= 0.0 {
        return None;
    }
    Some(Edit {
        command: without_out(command, script_at),
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

/// Renders the picture in pieces here and joins them, and exits with how it went.
pub(crate) fn run(edit: Edit) -> ExitCode {
    let started = Instant::now();
    let duration: f64 = edit.dur.parse().unwrap_or_default();
    let slots = (queue::budget().cores / PIECE_CORES).max(1);
    let count = ((duration / PIECE) as usize).clamp(1, slots * 2);
    let Some(folder) = edit.out.parent() else {
        return fail("the editor's file has no folder");
    };
    let pieces_dir = folder.join(format!(".pieces-{}", uuid::Uuid::new_v4().simple()));
    if let Err(e) = std::fs::create_dir_all(&pieces_dir) {
        return fail(&format!("could not make {}: {e}", pieces_dir.display()));
    }
    queue::say(&format!(
        "{} in {count} pieces, {} at a time here",
        took(std::time::Duration::from_secs_f64(duration)),
        slots.min(count)
    ));
    let board = Mutex::new(Board::new(cut(duration, count)));
    let run_piece = |_: &Place, piece: &Piece, stop: &std::sync::atomic::AtomicBool| {
        piece_here(&edit, piece, &pieces_dir, stop)
    };
    schedule(
        &board,
        &[(Place::Here, slots.min(count))],
        count,
        &run_piece,
    );
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
    println!(
        "wrote {shown} · {want} frames in {count} pieces · {}",
        took(started.elapsed())
    );
    ExitCode::SUCCESS
}

/// One piece through this machine's queue, to a file of its own.
fn piece_here(
    edit: &Edit,
    piece: &Piece,
    pieces: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let file = pieces.join(format!("piece-{:04}.mp4", piece.n));
    let log = pieces.join(format!("piece-{:04}.log", piece.n));
    let to = piece.to.map_or_else(|| edit.dur.clone(), |t| t.to_string());
    let output = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let errors = output.try_clone().map_err(|e| e.to_string())?;
    let mut child = me()
        .args(["run", "--cores", &PIECE_CORES.to_string(), "--label"])
        .arg(format!("{} · piece {}", edit.label, piece.n + 1))
        .arg("--")
        .args(&edit.command)
        .arg("--range")
        .arg(format!("{},{to}", piece.from))
        .arg("--out")
        .arg(&file)
        .current_dir(&edit.cwd)
        .stdout(output)
        .stderr(errors)
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = finish(&mut child, stop)?;
    if !status.success() || !file.is_file() {
        let tail = std::fs::read_to_string(&log).unwrap_or_default();
        let last: Vec<&str> = tail.lines().filter(|l| !l.trim().is_empty()).collect();
        return Err(last[last.len().saturating_sub(2)..].join(" / "));
    }
    // The frames it should have: from its start to where the next begins.
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

    #[test]
    fn the_editor_says_what_it_would_render_and_other_modes_run_as_they_are() {
        let Ok(python) = which("python3") else {
            return;
        };
        let root = std::env::temp_dir().join(format!("edit-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("tools")).unwrap();
        std::fs::create_dir_all(root.join("video/dust")).unwrap();
        std::fs::write(root.join("video/dust/cut.py"), "").unwrap();
        // An editor shaped as the house's: it works out its length and file, then encodes.
        std::fs::write(
            root.join("tools/edit.py"),
            r#"import os, subprocess, sys
args = sys.argv[1:]
EP = args[0]
opt = lambda k, d=None: args[args.index('--' + k) + 1] if '--' + k in args else d
if '--stills' in args or '--quiet' in args:
    sys.exit()
FPS = 30
DUR = 575.6333333333333
out = opt('out', os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'out', f'_{EP}-picture.mp4'))
enc = subprocess.Popen(['ffmpeg', '-f', 'rawvideo', '-i', '-', out], stdin=subprocess.PIPE)
"#,
        )
        .unwrap();
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

    fn which(program: &str) -> Result<String, ()> {
        let out = Command::new("which")
            .arg(program)
            .output()
            .map_err(|_| ())?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_owned();
        if path.is_empty() { Err(()) } else { Ok(path) }
    }
}
