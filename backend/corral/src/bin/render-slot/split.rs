//! One long render, spread across the farm. A Chrome frame renderer of the house template (it takes
//! `--from`/`--to`, `--audio-only`, `--keep-audio`, and `--print-segments`) renders any stretch of
//! a video on its own, every frame from the page's clock, so a full render can be cut into pieces
//! that run at once, here and on the Macs, and be joined after. Nobody asks for it: `render-slot`
//! sees such a render and does it.
//!
//! The soundtrack is mixed once, here, as the renderer would. The video is cut on whole seconds
//! into pieces, more than there are places to run them, and each machine is handed the next piece
//! whenever it has room for one (tars several at once, a Mac one), so a busy machine takes fewer.
//! A Mac renders in its copy of the project, synced with rsync, with Playwright's Chrome for macOS
//! where the renderer looks for Chrome on Linux; a piece that fails there runs here instead. The
//! pieces' pictures are joined under the one mix, as the renderer joins its own workers'.
use super::*;
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Videos shorter than this render in one piece.
const SHORTEST: f64 = 40.0;
/// No piece is shorter than this, so starting Chrome stays a small part of each.
const PIECE: f64 = 15.0;
/// What a piece asks for: the renderer's three workers, each with an encoder.
const PIECE_CORES: usize = 6;

/// A render that can be split: the renderer, the video, and the options it was given.
pub(crate) struct Render {
    node: String,
    /// The script, relative to the project folder.
    script: String,
    root: PathBuf,
    id: String,
    extra: Vec<String>,
    keep_audio: bool,
    label: String,
}
/// What the renderer's options say a render is about, if it is a whole video that can be split.
pub(crate) fn render(command: &[String], label: &str) -> Option<Render> {
    if std::env::var("RENDER_SPLIT").is_ok_and(|v| v == "0") || command.len() < 3 {
        return None;
    }
    let program = Path::new(&command[0])
        .file_name()?
        .to_string_lossy()
        .into_owned();
    if program != "node" && program != "node.exe" {
        return None;
    }
    let script = std::fs::canonicalize(&command[1]).ok()?;
    let text = std::fs::read_to_string(&script).ok()?;
    if !["print-segments", "keep-audio", "audio-only", "opt('from'"]
        .iter()
        .all(|mark| text.contains(mark))
    {
        return None;
    }
    let id = command[2].clone();
    if id.starts_with('-') {
        return None;
    }
    // A stretch, stills, the mix alone: those run as they are.
    let rest = &command[3..];
    let partial = [
        "--from",
        "--to",
        "--stills",
        "--sheet",
        "--audio-only",
        "--print-segments",
        "--remux",
    ];
    if rest.iter().any(|a| partial.contains(&a.as_str())) {
        return None;
    }
    let mut extra = Vec::new();
    let mut keep_audio = false;
    let mut i = 0;
    while i < rest.len() {
        match rest[i].as_str() {
            "--workers" => i += 1,
            "--keep-audio" => keep_audio = true,
            other => extra.push(other.to_owned()),
        }
        i += 1;
    }
    // The renderer's folder is the project's: `tools/render.mjs` in it.
    let root = script.parent()?.parent()?.to_path_buf();
    if !root.join("video").join(&id).is_dir() {
        return None;
    }
    Some(Render {
        node: command[0].clone(),
        script: script
            .strip_prefix(&root)
            .ok()?
            .to_string_lossy()
            .into_owned(),
        root,
        id,
        extra,
        keep_audio,
        label: if label.is_empty() {
            "render".into()
        } else {
            label.to_owned()
        },
    })
}

/// A place a piece can run, and how many it runs at once.
#[derive(Clone)]
pub(crate) enum Place {
    Here,
    Mac(Machine),
}
impl Place {
    pub fn name(&self) -> String {
        match self {
            Place::Here => here(),
            Place::Mac(m) => m.name.clone(),
        }
    }
}
/// A stretch of a render: seconds of a video, the last running to the end, or frames.
#[derive(Clone)]
pub(crate) struct Piece {
    pub n: usize,
    pub from: u64,
    pub to: Option<u64>,
    pub frames: bool,
}
impl Piece {
    pub fn span(&self) -> String {
        match (self.to, self.frames) {
            (Some(to), true) => format!("frames {}–{}", self.from, to),
            (Some(to), false) => format!("{}–{} s", self.from, to),
            (None, _) => format!("{} s–end", self.from),
        }
    }
}

/// `count` pieces of a video, on whole seconds, each starting where the last ended; the last
/// runs to the end, however long the renderer finds it to be.
pub(crate) fn cut(duration: f64, count: usize) -> Vec<Piece> {
    (0..count)
        .map(|n| Piece {
            n,
            from: (duration * n as f64 / count as f64).round() as u64,
            to: (n + 1 < count).then(|| (duration * (n + 1) as f64 / count as f64).round() as u64),
            frames: false,
        })
        .collect()
}
fn seconds(path: &Path) -> Option<f64> {
    let out = Command::new("ffprobe")
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "csv=p=0",
        ])
        .arg(path)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}
/// One kind of machine per video: macOS and Linux Chrome smooth text a shade differently, so the
/// pieces all come from the Macs when two or more can take them, or all from here. Says which.
fn one_kind(ready: Vec<(Place, usize)>) -> (Vec<(Place, usize)>, bool) {
    let (macs, here): (Vec<_>, Vec<_>) = ready
        .into_iter()
        .partition(|(p, _)| matches!(p, Place::Mac(_)));
    if macs.len() >= 2 {
        (macs, true)
    } else {
        (here, false)
    }
}
/// This machine's `render-slot`, for the runs a split render makes here, which are not split again.
pub(crate) fn me() -> Command {
    let mut command = Command::new(program());
    command.env("RENDER_SPLIT", "0");
    command
}
/// Where this program is. On Linux, one updated while a split render runs reads as
/// `… (deleted)`, and the new one is at the same place.
fn program() -> PathBuf {
    std::env::current_exe()
        .ok()
        .map(|p| {
            let path = p.to_string_lossy();
            PathBuf::from(path.strip_suffix(" (deleted)").unwrap_or(&path).to_owned())
        })
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from("render-slot"))
}

/// Renders a whole video in pieces across the farm, and exits with how it went.
pub(crate) fn run(render: Render) -> ExitCode {
    let started = Instant::now();
    let mix = render.root.join("out").join(format!("{}.m4a", render.id));
    // The soundtrack, once, as the renderer mixes it.
    if !(render.keep_audio && mix.is_file()) {
        let status = me()
            .args(["run", "--cores", "4", "--label"])
            .arg(format!("{} · mix", render.label))
            .arg("--")
            .arg(&render.node)
            .arg(&render.script)
            .arg(&render.id)
            .arg("--audio-only")
            .args(&render.extra)
            .current_dir(&render.root)
            .status();
        if !status.is_ok_and(|s| s.success()) {
            return fail("mixing the soundtrack failed");
        }
    }
    let Some(duration) = seconds(&mix) else {
        return fail(&format!("could not read {}", mix.display()));
    };
    // Where the pieces can go: here, and every Mac of the farm that answers.
    let budget = queue::budget();
    let mut places: Vec<(Place, usize)> = vec![(Place::Here, (budget.cores / PIECE_CORES).max(1))];
    if duration >= SHORTEST {
        for host in hosts() {
            let Ok(farm) = ask(&host, "/api/corral/farm", None) else {
                continue;
            };
            let tags: Vec<&str> = farm["tags"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| t.as_str())
                .collect();
            if tags.contains(&"macos") && tags.contains(&"node") && tags.contains(&"ffmpeg") {
                let cores = farm["queue"]["budget"]["cores"].as_u64().unwrap_or(0) as usize;
                places.push((Place::Mac(host), (cores / PIECE_CORES).max(1)));
            }
        }
    }
    // Copies of the project on the Macs, in parallel; a Mac that cannot have one sits this out.
    let rel = render
        .root
        .strip_prefix(corral::home_dir().unwrap_or_default())
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let ready: Vec<(Place, usize)> = std::thread::scope(|scope| {
        let jobs: Vec<_> = places
            .iter()
            .map(|(place, slots)| {
                let (render, mix, rel) = (&render, &mix, &rel);
                scope.spawn(move || match place {
                    Place::Here => Some((place.clone(), *slots)),
                    Place::Mac(m) => match mirror(m, render, mix, rel) {
                        Ok(()) => Some((place.clone(), *slots)),
                        Err(e) => {
                            queue::say(&format!("{} sits this one out: {e}", m.name));
                            None
                        }
                    },
                })
            })
            .collect();
        jobs.into_iter()
            .filter_map(|j| j.join().ok().flatten())
            .collect()
    });
    let (ready, on_macs) = one_kind(ready);
    let slots: usize = ready.iter().map(|(_, n)| n).sum();
    // More pieces than places, so a machine that finishes early takes another.
    let count = ((duration / PIECE).floor() as usize).min(slots * 2).max(1);
    if count == 1 {
        return whole(&render);
    }
    let pieces = cut(duration, count);
    queue::say(&format!(
        "{}: {:.0} s in {} pieces across {}",
        render.id,
        duration,
        count,
        ready
            .iter()
            .map(|(p, n)| format!("{} ({n} at once)", p.name()))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    let pieces_dir =
        std::env::temp_dir().join(format!("render-pieces-{}", uuid::Uuid::new_v4().simple()));
    if let Err(e) = std::fs::create_dir_all(&pieces_dir) {
        return fail(&e.to_string());
    }
    // Each machine takes the next piece whenever it has room; one that fails on a Mac goes to
    // another Mac. Once none is left, an idle Mac takes a copy of the oldest piece still under way
    // on another, and whichever copy finishes first is used, so one slow Mac does not hold up the
    // rest.
    let board = Arc::new(Mutex::new(Board::new(pieces.clone())));
    let run = |place: &Place, piece: &Piece, stop: &std::sync::atomic::AtomicBool| match place {
        Place::Here => piece_here(&render, piece, &pieces_dir, stop),
        Place::Mac(m) => piece_there(m, &render, &rel, piece, &pieces_dir, stop),
    };
    schedule(&board, &ready, count, &run);
    let mut board = std::mem::take(&mut *board.lock().unwrap());
    if let Some(e) = board.broken.take() {
        let _ = std::fs::remove_dir_all(&pieces_dir);
        return fail(&format!("the render failed at {e}"));
    }
    let mut done = board.done;
    done.sort_by_key(|(n, _, _)| *n);
    // Every Mac gave up before the end: the whole video here, rather than a mix of the two.
    if on_macs && done.len() < count {
        let _ = std::fs::remove_dir_all(&pieces_dir);
        queue::say("the Macs could not finish it; rendering it whole here");
        return whole(&render);
    }
    // The pictures in order, under the one mix.
    if done.len() != count || done.iter().any(|(_, f, _)| !f.is_file()) {
        let _ = std::fs::remove_dir_all(&pieces_dir);
        return fail("a piece went missing before the join");
    }
    let list = pieces_dir.join("list.txt");
    let lines: String = done
        .iter()
        .map(|(_, f, _)| format!("file '{}'\n", f.display()))
        .collect();
    let video = pieces_dir.join("video.mp4");
    let out = render.root.join("out").join(format!("{}.mp4", render.id));
    let joined = std::fs::write(&list, lines).is_ok()
        && ffmpeg(
            &["-f", "concat", "-safe", "0", "-i"],
            &list,
            &["-map", "0:v", "-c", "copy"],
            &video,
        )
        && Command::new("ffmpeg")
            .args(["-nostdin", "-y", "-loglevel", "error", "-i"])
            .arg(&video)
            .arg("-i")
            .arg(&mix)
            .args([
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "copy",
                "-c:a",
                "copy",
                "-shortest",
            ])
            .arg(&out)
            .status()
            .is_ok_and(|s| s.success());
    let _ = std::fs::remove_dir_all(&pieces_dir);
    // The joined picture is as long as the soundtrack, or something went wrong.
    let length = seconds(&out).unwrap_or(0.0);
    if !joined || (length - duration).abs() > 0.5 {
        return fail(&format!(
            "joining the pieces failed: {length:.1} s of picture for {duration:.1} s of sound"
        ));
    }
    let mut by: Vec<(String, usize)> = Vec::new();
    for (_, _, name) in &done {
        match by.iter_mut().find(|(n, _)| n == name) {
            Some(entry) => entry.1 += 1,
            None => by.push((name.clone(), 1)),
        }
    }
    println!(
        "wrote out/{}.mp4 · {} pieces ({}) · {}",
        render.id,
        done.len(),
        by.iter()
            .map(|(n, c)| format!("{n} {c}"))
            .collect::<Vec<_>>()
            .join(", "),
        took(started.elapsed())
    );
    ExitCode::SUCCESS
}

/// How a piece runs on a place, as a kind of render does it: what it made, or why not.
pub(crate) type Runner<'a> =
    dyn Fn(&Place, &Piece, &std::sync::atomic::AtomicBool) -> Result<PathBuf, String> + Sync + 'a;
/// Runs the pieces on `ready`'s places, each taking the next as it has room.
pub(crate) fn schedule(board: &Mutex<Board>, ready: &[(Place, usize)], count: usize, run: &Runner) {
    std::thread::scope(|scope| {
        for (place, room) in ready {
            for _ in 0..*room {
                scope.spawn(move || work(board, place, count, run));
            }
        }
    });
}
/// Who is doing what: the pieces waiting, those under way, and those done.
#[derive(Default)]
pub(crate) struct Board {
    /// Every piece, as the render was cut.
    pub all: Vec<Piece>,
    pub todo: Vec<Piece>,
    running: Vec<Running>,
    pub done: Vec<(usize, PathBuf, String)>,
    pub broken: Option<String>,
}
impl Board {
    /// A board with every piece waiting.
    pub fn new(pieces: Vec<Piece>) -> Board {
        Board {
            all: pieces.clone(),
            todo: pieces,
            ..Board::default()
        }
    }
}
/// A copy of a piece under way: where, since when, and a flag that stops it.
struct Running {
    n: usize,
    place: String,
    since: Instant,
    stop: Arc<std::sync::atomic::AtomicBool>,
}
/// One of a machine's places for pieces: takes the next piece, or a copy of a slow one, until
/// every piece is done.
fn work(board: &Mutex<Board>, place: &Place, count: usize, run: &Runner) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let name = place.name();
    let mac = matches!(place, Place::Mac(_));
    loop {
        let next = {
            let mut b = board.lock().unwrap();
            if b.broken.is_some() || b.done.len() >= count {
                return;
            }
            let piece = b.todo.pop().or_else(|| {
                // Only a Mac takes copies: here, other agents' jobs may need the room.
                if !mac {
                    return None;
                }
                let copies = |n: usize| b.running.iter().filter(|r| r.n == n).count();
                let finished = |n: usize| b.done.iter().any(|(d, _, _)| *d == n);
                b.running
                    .iter()
                    .filter(|r| r.place != name && copies(r.n) == 1 && !finished(r.n))
                    .min_by_key(|r| r.since)
                    .and_then(|r| b.all.iter().find(|p| p.n == r.n).cloned())
            });
            piece.map(|p| {
                let stop = Arc::new(AtomicBool::new(false));
                b.running.push(Running {
                    n: p.n,
                    place: name.clone(),
                    since: Instant::now(),
                    stop: stop.clone(),
                });
                (p, stop)
            })
        };
        let Some((piece, stop)) = next else {
            std::thread::sleep(Duration::from_secs(2));
            continue;
        };
        let began = Instant::now();
        let result = run(place, &piece, &stop);
        let mut b = board.lock().unwrap();
        b.running.retain(|r| !(r.n == piece.n && r.place == name));
        let others = b.running.iter().filter(|r| r.n == piece.n).count();
        match result {
            Ok(file) if b.done.iter().any(|(n, _, _)| *n == piece.n) => {
                // A file of a piece, or a folder of its frames.
                let _ = std::fs::remove_file(&file);
                let _ = std::fs::remove_dir_all(&file);
            }
            Ok(file) => {
                queue::say(&format!(
                    "piece {}/{} ({}) on {} in {}",
                    piece.n + 1,
                    count,
                    piece.span(),
                    name,
                    took(began.elapsed())
                ));
                b.done.push((piece.n, file, name.clone()));
                // The other copy, if any, is not needed now.
                for r in b.running.iter().filter(|r| r.n == piece.n) {
                    r.stop.store(true, Ordering::Relaxed);
                }
            }
            // Stopped because the other copy finished first.
            Err(_) if stop.load(Ordering::Relaxed) => {}
            // Another copy carries on.
            Err(_) if others > 0 => {}
            Err(e) if mac => {
                queue::say(&format!(
                    "piece {} failed on {name} ({e}); it goes back in line, and {name} takes no more",
                    piece.n + 1
                ));
                b.todo.insert(0, piece);
                return;
            }
            Err(e) => {
                b.broken = Some(format!("piece {} ({}): {e}", piece.n + 1, piece.span()));
                return;
            }
        }
    }
}
pub(crate) fn took(d: Duration) -> String {
    let s = d.as_secs();
    if s < 60 {
        format!("{s} s")
    } else {
        format!("{}m{:02}s", s / 60, s % 60)
    }
}
fn ffmpeg(before: &[&str], input: &Path, after: &[&str], output: &Path) -> bool {
    Command::new("ffmpeg")
        .args(["-nostdin", "-y", "-loglevel", "error"])
        .args(before)
        .arg(input)
        .args(after)
        .arg(output)
        .status()
        .is_ok_and(|s| s.success())
}
/// The whole video here, as asked, with the soundtrack already mixed.
fn whole(render: &Render) -> ExitCode {
    let status = me()
        .args([
            "run",
            "--cores",
            &PIECE_CORES.to_string(),
            "--label",
            &render.label,
            "--",
        ])
        .arg(&render.node)
        .arg(&render.script)
        .arg(&render.id)
        .arg("--keep-audio")
        .args(&render.extra)
        .current_dir(&render.root)
        .status();
    ExitCode::from(
        status
            .ok()
            .and_then(|s| s.code())
            .unwrap_or(1)
            .clamp(0, 255) as u8,
    )
}
/// The renderer's arguments for a piece.
fn piece_args(render: &Render, piece: &Piece) -> Vec<String> {
    let mut args = vec![
        render.script.clone(),
        render.id.clone(),
        "--from".into(),
        piece.from.to_string(),
        "--to".into(),
        piece.to.map_or_else(|| "999999".into(), |t| t.to_string()),
        "--keep-audio".into(),
        "--workers".into(),
        "3".into(),
    ];
    args.extend(render.extra.iter().cloned());
    args
}
/// The file the renderer writes for a stretch: `out/<id>-<from>-<to>.mp4`, the end as it reads
/// it for the last piece.
fn piece_prefix(render: &Render, piece: &Piece) -> String {
    format!("out/{}-{}-", render.id, piece.from)
}
/// Files an earlier run of a piece left in a folder, which would be taken for this run's.
fn stale(dir: &Path, prefix: &str) -> Vec<PathBuf> {
    let (folder, start) = prefix.rsplit_once('/').unwrap_or(("", prefix));
    std::fs::read_dir(dir.join(folder))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with(start))
        .map(|e| e.path())
        .collect()
}
fn piece_here(
    render: &Render,
    piece: &Piece,
    pieces: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    for old in stale(&render.root, &piece_prefix(render, piece)) {
        let _ = std::fs::remove_file(old);
    }
    let log = pieces.join(format!("piece-{}-{}.log", piece.n, here()));
    let file = std::fs::File::create(&log).map_err(|e| e.to_string())?;
    let errors = file.try_clone().map_err(|e| e.to_string())?;
    let mut child = me()
        .args(["run", "--cores", &PIECE_CORES.to_string(), "--label"])
        .arg(format!("{} · piece {}", render.label, piece.n + 1))
        .arg("--")
        .arg(&render.node)
        .args(piece_args(render, piece))
        .current_dir(&render.root)
        .stdout(file)
        .stderr(errors)
        .spawn()
        .map_err(|e| e.to_string())?;
    let status = finish(&mut child, stop)?;
    if !status.success() {
        let tail = std::fs::read_to_string(&log).unwrap_or_default();
        return Err(tail.lines().rev().take(3).collect::<Vec<_>>().join(" / "));
    }
    // The renderer named it; move it out of the project's folder.
    let prefix = piece_prefix(render, piece);
    let (folder, start) = prefix.rsplit_once('/').unwrap_or(("", &prefix));
    let made = std::fs::read_dir(render.root.join(folder))
        .map_err(|e| e.to_string())?
        .flatten()
        .find(|e| {
            e.file_name().to_string_lossy().starts_with(start)
                && e.file_name().to_string_lossy().ends_with(".mp4")
        })
        .ok_or("the renderer wrote no file")?
        .path();
    let kept = pieces.join(format!(
        "piece-{:04}-{}-{}.mp4",
        piece.n,
        here(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::rename(&made, &kept)
        .or_else(|_| {
            std::fs::copy(&made, &kept)
                .map(|_| ())
                .and_then(|_| std::fs::remove_file(&made))
        })
        .map_err(|e| e.to_string())?;
    Ok(kept)
}
/// Waits for a piece's run here to end, or stops it once the other copy of the piece has
/// finished first.
pub(crate) fn finish(
    child: &mut std::process::Child,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<std::process::ExitStatus, String> {
    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status);
        }
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            // A polite stop, so the renderer closes its Chrome and encoders.
            #[cfg(unix)]
            // SAFETY: a signal to the piece's own process, which this one started.
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            #[cfg(not(unix))]
            let _ = child.kill();
            let _ = child.wait();
            return Err("stopped".into());
        }
        std::thread::sleep(Duration::from_secs(1));
    }
}
fn piece_there(
    machine: &Machine,
    render: &Render,
    rel: &str,
    piece: &Piece,
    pieces: &Path,
    stop: &std::sync::atomic::AtomicBool,
) -> Result<PathBuf, String> {
    let dir = rel.to_owned();
    let listing = |prefix: &str| -> Result<Vec<String>, String> {
        Ok(ask(
            machine,
            &format!(
                "/api/corral/farm/list?dir={}&prefix={}",
                encode(&dir),
                encode(prefix)
            ),
            None,
        )?["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| f.as_str().map(str::to_owned))
            .collect())
    };
    // An earlier run's file for this piece would be taken for this one's.
    let old = listing(&piece_prefix(render, piece))?;
    if !old.is_empty() {
        let _ = ask(
            machine,
            "/api/corral/farm/tidy",
            Some(&serde_json::json!({"dir": dir, "paths": old.join("\n")})),
        );
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let jobs = format!("/api/corral/farm/jobs/{id}");
    let mut command = vec![
        render
            .node
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("node")
            .to_owned(),
    ];
    command.extend(piece_args(render, piece));
    let body = serde_json::json!({
        "command": command,
        "cores": PIECE_CORES,
        "label": format!("{} · piece {}", render.label, piece.n + 1),
        "place": std::env::var("CORRAL_PLACE").unwrap_or_default(),
        // The copy's folder, under the farm's projects.
        "dir": rel,
    });
    // The job's own folder holds its log; the run itself is in the project copy.
    ask(machine, &format!("{jobs}/run"), Some(&body))?;
    let (code, log) = loop {
        std::thread::sleep(Duration::from_secs(3));
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = ask(
                machine,
                &format!("{jobs}/stop"),
                Some(&serde_json::json!({})),
            );
            let _ = ask(
                machine,
                &format!("{jobs}/delete"),
                Some(&serde_json::json!({})),
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
    let _ = ask(
        machine,
        &format!("{jobs}/delete"),
        Some(&serde_json::json!({})),
    );
    if code != 0 {
        return Err(log.lines().rev().take(3).collect::<Vec<_>>().join(" / "));
    }
    let file = listing(&piece_prefix(render, piece))?
        .into_iter()
        .find(|f| f.ends_with(".mp4"))
        .ok_or("the renderer wrote no file")?;
    // The piece, as a tar stream, into this render's folder of pieces.
    let landing = pieces.join(format!("from-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&landing).map_err(|e| e.to_string())?;
    let options = Options::new(
        machine,
        &format!("{jobs}/files?dir={}&paths={}", encode(&dir), encode(&file)),
        &[],
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
                .current_dir(&landing)
                .stdin(out)
                .status()?;
            Ok(curl.wait()?.success() && tar.success())
        })
        .unwrap_or(false);
    let _ = ask(
        machine,
        "/api/corral/farm/tidy",
        Some(&serde_json::json!({"dir": dir, "paths": file})),
    );
    if !fetched {
        return Err("its file did not come back".into());
    }
    let kept = pieces.join(format!(
        "piece-{:04}-{}-{}.mp4",
        piece.n,
        machine.name,
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::rename(landing.join(&file), &kept).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&landing);
    Ok(kept)
}
/// Brings a Mac's copy of the project up to date, with the soundtrack, and Chrome where the
/// renderer looks for it.
fn mirror(machine: &Machine, render: &Render, mix: &Path, rel: &str) -> Result<(), String> {
    if !render.root.join("node_modules/playwright-core").is_dir() {
        return Err("the project has no node_modules/playwright-core of its own".into());
    }
    let there = format!(".cache/corral-farm/projects/{rel}");
    let ssh = |script: &str| -> Result<String, String> {
        let out = Command::new("ssh")
            .args([
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=8",
                &machine.name,
                "bash",
                "-s",
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut child| {
                use std::io::Write;
                child
                    .stdin
                    .take()
                    .expect("piped")
                    .write_all(script.as_bytes())?;
                child.wait_with_output()
            })
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("ssh failed")
                .to_owned())
        }
    };
    ssh(&format!("mkdir -p ~/{there}/out"))?;
    let rsync = |args: &[&str]| -> Result<(), String> {
        let out = Command::new("rsync")
            .args(["-a", "-e", "ssh -o BatchMode=yes"])
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr)
                .lines()
                .last()
                .unwrap_or("rsync failed")
                .to_owned())
        }
    };
    let root = format!("{}/", render.root.display());
    rsync(&[
        "--delete",
        "--exclude=/out/",
        "--exclude=/.git/",
        "--exclude=/work/",
        &root,
        &format!("{}:{there}/", machine.name),
    ])?;
    rsync(&[
        &mix.display().to_string(),
        &format!("{}:{there}/out/", machine.name),
    ])?;
    // Playwright's Chrome for this version, and the Linux path the renderer looks in, pointing at it.
    ssh(&format!(
        r#"set -e
export PATH=/opt/homebrew/bin:/usr/local/bin:$PATH
cd ~/{there}
node node_modules/playwright-core/cli.js install chromium-headless-shell >/dev/null
shim=~/.cache/ms-playwright/chromium-99999/chrome-linux64
mkdir -p "$shim"
cat > "$shim/chrome" <<'SH'
#!/bin/bash
# Playwright's Chrome for macOS, where a Linux renderer looks for Chrome.
chrome=$(ls -d ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-*/chrome-headless-shell 2>/dev/null | sort -V | tail -1)
exec "$chrome" "$@"
SH
chmod +x "$shim/chrome""#
    ))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_meet_on_whole_seconds_and_the_last_runs_to_the_end() {
        let pieces = cut(340.08, 14);
        assert_eq!(pieces.len(), 14);
        assert_eq!(pieces[0].from, 0);
        for pair in pieces.windows(2) {
            assert_eq!(pair[0].to, Some(pair[1].from));
        }
        assert_eq!(pieces[13].to, None);
        assert_eq!(cut(30.0, 1)[0].to, None);
    }

    #[test]
    fn a_video_is_made_on_the_macs_or_here_never_both() {
        let mac = |name: &str| {
            (
                Place::Mac(Machine {
                    name: name.into(),
                    url: String::new(),
                    key: String::new(),
                }),
                1,
            )
        };
        let names = |places: &[(Place, usize)]| -> Vec<String> {
            places.iter().map(|(p, _)| p.name()).collect()
        };
        let (two, on_macs) = one_kind(vec![(Place::Here, 4), mac("mini"), mac("studio")]);
        assert!(on_macs);
        assert_eq!(names(&two), ["mini", "studio"]);
        let (one, on_macs) = one_kind(vec![(Place::Here, 4), mac("mini")]);
        assert!(!on_macs);
        assert_eq!(names(&one), [here()]);
    }

    #[test]
    fn only_whole_videos_from_a_renderer_that_can_render_a_stretch_are_split() {
        let root = std::env::temp_dir().join(format!("split-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(root.join("tools")).unwrap();
        std::fs::create_dir_all(root.join("video/emu-war")).unwrap();
        let script = root.join("tools/render.mjs");
        std::fs::write(&script, "opt('from') print-segments keep-audio audio-only").unwrap();
        let command = |rest: &[&str]| -> Vec<String> {
            ["node", script.to_str().unwrap()]
                .iter()
                .chain(rest)
                .map(|s| s.to_string())
                .collect()
        };
        let whole = render(
            &command(&["emu-war", "--workers", "6", "--scale", "0.5"]),
            "",
        )
        .unwrap();
        assert_eq!(
            (whole.id.as_str(), whole.script.as_str()),
            ("emu-war", "tools/render.mjs")
        );
        // Its own workers are set per piece; other options go to every piece.
        assert_eq!(whole.extra, ["--scale", "0.5"]);
        for partial in [
            ["emu-war", "--from"],
            ["emu-war", "--stills"],
            ["emu-war", "--audio-only"],
        ] {
            assert!(render(&command(&partial), "").is_none());
        }
        // A video it does not have, or a renderer without the switches, runs as it is.
        assert!(render(&command(&["no-such"]), "").is_none());
        std::fs::write(&script, "opt('from') only").unwrap();
        assert!(render(&command(&["emu-war"]), "").is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
}
