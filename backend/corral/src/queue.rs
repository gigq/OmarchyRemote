//! A machine's render queue: heavy jobs (Blender, ffmpeg, headless Chrome, upscales, Whisper) take
//! turns for the machine's cores and GPU, first come, first served, so many agents can queue work
//! without overloading it. Each job asks for so many cores (and a GPU seat if it uses the GPU);
//! jobs start in the order they came while they fit in the machine's budget, which leaves room
//! for the person and the agents themselves. On Linux each job is held to its own cores and runs
//! at a lower priority, so a job that starts more threads than it asked for slows only itself.
//!
//! A job is a ticket in the queue's folder: `<id>.json` says what it is, and `<id>.lock` is held
//! by the job for as long as it lives, which is how others know it still does. A ticket whose lock
//! is free has no job behind it any more, and goes. Jobs started by the queue it replaced, which
//! hold one of `/tmp/render-slots/slot*.lock`, count as so many cores each until they end.
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

/// How often a waiting job looks again.
const POLL: Duration = Duration::from_secs(2);
/// Cores a job takes unless it says, and a job from the old queue is counted as.
pub const CORES: usize = 4;

/// What a ticket says about its job.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Ticket {
    pub id: String,
    pub pid: u32,
    /// The folder it runs in, its command, and a name for it, if it was given one.
    pub cwd: String,
    pub command: String,
    #[serde(default)]
    pub label: String,
    /// The Corral place that started it, from `CORRAL_PLACE`: conversation, agent, and thread.
    #[serde(default)]
    pub place: String,
    /// What it asked for: cores, and a GPU seat.
    pub cores: usize,
    #[serde(default)]
    pub gpu: bool,
    pub since: String,
    /// When it got its turn, and the processors it was given; empty while it waits.
    #[serde(default)]
    pub started: String,
    #[serde(default)]
    pub cpus: Vec<usize>,
}
/// A ticket in the queue now: running, or waiting with so many ahead of it.
#[derive(Clone, Debug, Serialize)]
pub struct Entry {
    #[serde(flatten)]
    pub ticket: Ticket,
    pub running: bool,
    /// Its place in line among those waiting, from 1.
    pub position: usize,
}
/// What a machine can give jobs at once.
#[derive(Clone, Debug, Serialize)]
pub struct Budget {
    /// Logical processors for jobs, and seats on the GPU.
    pub cores: usize,
    pub gpus: usize,
}
/// The machine's queue as it stands.
#[derive(Clone, Debug, Serialize)]
pub struct Snapshot {
    pub budget: Budget,
    /// Jobs from before this queue, still running.
    pub legacy: usize,
    pub jobs: Vec<Entry>,
}

/// The queue's folder: `RENDER_QUEUE_DIR`, or one in the system's temporary folder.
pub fn dir() -> PathBuf {
    std::env::var_os("RENDER_QUEUE_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("render-queue"))
}
/// The old queue's folder.
fn legacy_dir() -> PathBuf {
    std::env::var_os("RENDER_LEGACY_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp/render-slots"))
}
/// The machine's settings, `~/.config/render-slot.json`: `{"cores": 24, "gpus": 2}`.
fn settings() -> serde_json::Value {
    std::env::var_os("RENDER_SLOT_CONFIG")
        .map(PathBuf::from)
        .or_else(|| crate::home_dir().map(|h| h.join(".config/render-slot.json")))
        .and_then(|p| fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
/// What jobs may use at once: from the settings, or three quarters of the machine's processors
/// and one GPU seat.
pub fn budget() -> Budget {
    let all = std::thread::available_parallelism().map_or(4, |n| n.get());
    let s = settings();
    Budget {
        cores: s["cores"]
            .as_u64()
            .map_or(all * 3 / 4, |n| n as usize)
            .clamp(1, all),
        gpus: s["gpus"].as_u64().map_or(1, |n| n as usize),
    }
}
/// Whether another process holds `path`'s lock.
fn held(path: &Path) -> bool {
    match File::open(path) {
        Ok(file) => match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                false
            }
            Err(_) => true,
        },
        Err(_) => false,
    }
}
/// Jobs the old queue started, which still run.
fn legacy() -> usize {
    fs::read_dir(legacy_dir())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".lock"))
        .filter(|e| held(&e.path()))
        .count()
}
/// The queue's tickets in order, dropping any whose job is gone.
fn tickets(dir: &Path, prune: bool) -> Vec<Ticket> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_suffix(".json")
                .map(str::to_owned)
        })
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|id| {
            let lock = dir.join(format!("{id}.lock"));
            if !held(&lock) {
                if prune {
                    let _ = fs::remove_file(dir.join(format!("{id}.json")));
                    let _ = fs::remove_file(&lock);
                }
                return None;
            }
            serde_json::from_slice(&fs::read(dir.join(format!("{id}.json"))).ok()?).ok()
        })
        .collect()
}
/// The queue now.
pub fn snapshot() -> Snapshot {
    let mut waiting = 0;
    let jobs = tickets(&dir(), false)
        .into_iter()
        .map(|ticket| {
            let running = !ticket.started.is_empty();
            if !running {
                waiting += 1;
            }
            Entry {
                ticket,
                running,
                position: if running { 0 } else { waiting },
            }
        })
        .collect();
    Snapshot {
        budget: budget(),
        legacy: legacy(),
        jobs,
    }
}
fn write(path: &Path, ticket: &Ticket) -> anyhow::Result<()> {
    let temporary = path.with_extension("tmp");
    fs::write(&temporary, serde_json::to_vec(ticket)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}
/// The machine's logical processors, a physical core's together, as Linux numbers them.
fn processors() -> Vec<Vec<usize>> {
    let mut cores: Vec<Vec<usize>> = Vec::new();
    for entry in fs::read_dir("/sys/devices/system/cpu")
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(Ok(cpu)) = name.strip_prefix("cpu").map(str::parse::<usize>) else {
            continue;
        };
        let siblings: Vec<usize> =
            fs::read_to_string(entry.path().join("topology/thread_siblings_list"))
                .unwrap_or_default()
                .trim()
                .split(',')
                .flat_map(|part| match part.split_once('-') {
                    Some((a, b)) => {
                        let (a, b) = (a.parse().unwrap_or(cpu), b.parse().unwrap_or(cpu));
                        (a..=b).collect::<Vec<_>>()
                    }
                    None => part.parse().ok().into_iter().collect(),
                })
                .collect();
        let core = if siblings.is_empty() {
            vec![cpu]
        } else {
            siblings
        };
        if !cores.contains(&core) {
            cores.push(core);
        }
    }
    cores.sort();
    cores
}
/// `want` processors not in `taken`, whole cores first, from the top down so the first cores stay
/// for the desktop.
fn choose(want: usize, taken: &[usize]) -> Vec<usize> {
    let mut cores = processors();
    cores.reverse();
    let mut chosen: Vec<usize> = Vec::new();
    for core in &cores {
        let free: Vec<usize> = core
            .iter()
            .copied()
            .filter(|c| !taken.contains(c))
            .collect();
        if free.len() == core.len() && chosen.len() + free.len() <= want {
            chosen.extend(free);
        }
    }
    for core in &cores {
        for cpu in core {
            if chosen.len() < want && !taken.contains(cpu) && !chosen.contains(cpu) {
                chosen.push(*cpu);
            }
        }
    }
    chosen.sort();
    chosen
}
/// A job's place in the queue, held until it is dropped, or until the process holding it ends.
pub struct Place {
    pub lock: File,
    pub ticket: Ticket,
    json: PathBuf,
    lock_path: PathBuf,
}
impl Drop for Place {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.json);
        let _ = fs::remove_file(&self.lock_path);
    }
}
/// Joins the queue and waits for its turn, telling `waiting` its place in line when it changes.
/// The first job waiting starts once what it asked for is free; the rest wait behind it.
pub fn take(mut ticket: Ticket, waiting: impl Fn(usize)) -> anyhow::Result<Place> {
    let dir = dir();
    fs::create_dir_all(&dir)?;
    let budget = budget();
    ticket.cores = ticket.cores.clamp(1, budget.cores);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)?;
    ticket.id = format!("{:020}-{}", now.as_nanos(), ticket.pid);
    let lock_path = dir.join(format!("{}.lock", ticket.id));
    let lock = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&lock_path)?;
    lock.lock()?;
    let json = dir.join(format!("{}.json", ticket.id));
    write(&json, &ticket)?;
    let mut told = 0;
    loop {
        // One process at a time decides, so two cannot take the same cores.
        let gate = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join("queue.lock"))?;
        gate.lock()?;
        let all = tickets(&dir, true);
        let running: Vec<&Ticket> = all.iter().filter(|t| !t.started.is_empty()).collect();
        let ahead = all
            .iter()
            .take_while(|t| t.id != ticket.id)
            .filter(|t| t.started.is_empty())
            .count();
        let used = running.iter().map(|t| t.cores).sum::<usize>() + legacy() * CORES;
        let seats = running.iter().filter(|t| t.gpu).count();
        let fits =
            used + ticket.cores <= budget.cores && (!ticket.gpu || seats < budget.gpus.max(1));
        if ahead == 0 && (fits || running.is_empty()) {
            let taken: Vec<usize> = running.iter().flat_map(|t| t.cpus.clone()).collect();
            ticket.cpus = choose(ticket.cores, &taken);
            ticket.started = crate::now();
            write(&json, &ticket)?;
            gate.unlock()?;
            return Ok(Place {
                lock,
                ticket,
                json,
                lock_path,
            });
        }
        gate.unlock()?;
        if ahead + 1 != told {
            told = ahead + 1;
            waiting(told);
        }
        std::thread::sleep(POLL);
    }
}
/// A job's ticket as this process would make it.
pub fn ticket(command: &[String], label: &str, cores: usize, gpu: bool) -> Ticket {
    Ticket {
        pid: std::process::id(),
        cwd: std::env::current_dir()
            .map(|d| d.display().to_string())
            .unwrap_or_default(),
        command: command.join(" "),
        label: label.to_owned(),
        place: std::env::var("CORRAL_PLACE").unwrap_or_default(),
        cores,
        gpu,
        since: crate::now(),
        ..Ticket::default()
    }
}
/// A render split into pieces across the farm, as the `render-slot` sharing it out writes it while
/// it runs: in `splits/` in the queue's folder, beside a lock it holds, so one that dies is not
/// listed. How long is left is worked out from the pieces done when it is read.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Split {
    pub id: String,
    pub label: String,
    /// The Corral place that started it, and the folder it runs in.
    #[serde(default)]
    pub place: String,
    #[serde(default)]
    pub cwd: String,
    pub pieces: usize,
    pub done: usize,
    /// When it began, and when each piece under way began, in seconds since 1970.
    pub started: u64,
    pub running: Vec<u64>,
    /// How long each piece done took, in seconds.
    pub took: Vec<f64>,
    /// Seconds left, about, once a piece is done to go by.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub left: Option<u64>,
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
impl Split {
    /// About how long is left at `now`: the pieces under way finish at the pace of those done, and
    /// the rest follow as many at a time as are running now.
    pub fn left(&self, now: u64) -> Option<u64> {
        if self.took.is_empty() {
            return None;
        }
        let pace = self.took.iter().sum::<f64>() / self.took.len() as f64;
        let under_way: Vec<f64> = self
            .running
            .iter()
            .map(|&at| (pace - now.saturating_sub(at) as f64).max(0.0))
            .collect();
        let after = self.pieces.saturating_sub(self.done + self.running.len()) as f64;
        let left = if after == 0.0 {
            under_way.iter().copied().fold(0.0, f64::max)
        } else {
            let at_once = self.running.len().max(1) as f64;
            (under_way.iter().sum::<f64>() + after * pace) / at_once
        };
        Some(left.ceil() as u64)
    }
}
fn splits_dir() -> PathBuf {
    dir().join("splits")
}
/// The splits under way on this machine, each with how long it has left.
pub fn splits() -> Vec<Split> {
    splits_in(&splits_dir())
}
fn splits_in(dir: &Path) -> Vec<Split> {
    let now = now();
    let mut found: Vec<Split> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.strip_suffix(".json")?.to_owned();
            // A report being rewritten is `.tmp` until it is whole.
            if !held(&dir.join(format!("{name}.lock"))) {
                return None;
            }
            let mut split: Split = serde_json::from_slice(&fs::read(e.path()).ok()?).ok()?;
            split.left = split.left(now);
            Some(split)
        })
        .collect();
    found.sort_by_key(|s| s.started);
    found
}
/// Where a split says how it is going, for as long as this lives.
pub struct Report {
    lock: File,
    json: PathBuf,
    lock_path: PathBuf,
    pub split: Split,
}
impl Report {
    pub fn new(label: &str, pieces: usize) -> Option<Report> {
        Report::new_in(&splits_dir(), label, pieces)
    }
    fn new_in(dir: &Path, label: &str, pieces: usize) -> Option<Report> {
        fs::create_dir_all(dir).ok()?;
        let id = uuid::Uuid::new_v4().to_string();
        let lock_path = dir.join(format!("{id}.lock"));
        let lock = File::create(&lock_path).ok()?;
        lock.try_lock().ok()?;
        let report = Report {
            lock,
            json: dir.join(format!("{id}.json")),
            lock_path,
            split: Split {
                id,
                label: label.to_owned(),
                place: std::env::var("CORRAL_PLACE").unwrap_or_default(),
                cwd: std::env::current_dir()
                    .map(|d| d.display().to_string())
                    .unwrap_or_default(),
                pieces,
                started: now(),
                ..Split::default()
            },
        };
        report.write();
        Some(report)
    }
    pub fn write(&self) {
        let temporary = self.json.with_extension("tmp");
        if serde_json::to_vec(&self.split)
            .ok()
            .and_then(|b| fs::write(&temporary, b).ok())
            .is_some()
        {
            let _ = fs::rename(temporary, &self.json);
        }
    }
}
impl Drop for Report {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.json);
        let _ = self.lock.unlock();
        let _ = fs::remove_file(&self.lock_path);
    }
}
/// Seconds since a time as tickets write it (`2026-10-29T15:00:00.000Z`).
pub fn seconds_since(time: &str) -> u64 {
    let field = |a: usize, b: usize| time.get(a..b).and_then(|f| f.parse::<i64>().ok());
    let (Some(y), Some(m), Some(d), Some(h), Some(min), Some(s)) = (
        field(0, 4),
        field(5, 7),
        field(8, 10),
        field(11, 13),
        field(14, 16),
        field(17, 19),
    ) else {
        return 0;
    };
    // Days since 1970 from a civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let then = days * 86_400 + h * 3600 + min * 60 + s;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    (now - then).max(0) as u64
}
/// A line for the job's log, as the old queue wrote, for those that look for it.
pub fn say(line: &str) {
    let _ = writeln!(std::io::stderr(), "[render-slot] {line}");
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_split_has_as_long_left_as_its_pieces_at_the_pace_of_those_done() {
        let mut split = Split {
            pieces: 10,
            done: 2,
            started: 1000,
            running: vec![1500, 1550],
            took: vec![400.0, 500.0],
            ..Split::default()
        };
        // Nothing done yet: no guess.
        assert_eq!(
            Split {
                took: vec![],
                ..split.clone()
            }
            .left(1600),
            None
        );
        // Two under way, 350 s and 400 s from done at 450 s a piece; six more, two at a time.
        assert_eq!(split.left(1600), Some((350 + 400 + 6 * 450) / 2));
        // The last pieces: as long as the slowest of them.
        split.done = 8;
        assert_eq!(split.left(1600), Some(400));
        // Running over the pace counts as nearly done, never as negative.
        assert_eq!(split.left(9000), Some(0));
    }
    #[test]
    fn a_split_is_listed_while_its_report_lives() {
        let dir = std::env::temp_dir().join(format!("render-queue-test-{}", uuid::Uuid::new_v4()));
        let mut report = Report::new_in(&dir, "4K recut", 4).unwrap();
        report.split.done = 1;
        report.split.took.push(60.0);
        report.write();
        let listed = splits_in(&dir);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "4K recut");
        assert!(listed[0].left.is_some());
        drop(report);
        assert!(splits_in(&dir).is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    use super::*;

    #[test]
    fn jobs_start_in_the_order_they_came_while_they_fit_in_the_budget() {
        let dir = std::env::temp_dir().join(format!("render-queue-test-{}", uuid::Uuid::new_v4()));
        let config = dir.with_extension("json");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&config, r#"{"cores": 8, "gpus": 1}"#).unwrap();
        // SAFETY: this is the only test that uses the queue's environment.
        unsafe {
            std::env::set_var("RENDER_QUEUE_DIR", &dir);
            std::env::set_var("RENDER_SLOT_CONFIG", &config);
            std::env::set_var("RENDER_LEGACY_DIR", dir.join("none"));
        }
        let big = take(ticket(&["ffmpeg".into()], "big", 6, false), |_| {}).unwrap();
        assert_eq!(big.ticket.cpus.len(), 6);
        // Four more cores do not fit beside six, so it waits, first in line; one after it waits
        // behind it even though it would fit.
        let (sent, heard) = std::sync::mpsc::channel();
        let told = sent.clone();
        let next = std::thread::spawn(move || {
            take(ticket(&["blender".into()], "next", 4, true), move |p| {
                let _ = told.send(("next", p));
            })
            .unwrap()
        });
        assert_eq!(heard.recv_timeout(Duration::from_secs(5)), Ok(("next", 1)));
        let small = std::thread::spawn(move || {
            take(ticket(&["ffprobe".into()], "small", 1, false), move |p| {
                let _ = sent.send(("small", p));
            })
            .unwrap()
        });
        assert_eq!(heard.recv_timeout(Duration::from_secs(5)), Ok(("small", 2)));
        let now = snapshot();
        assert_eq!(now.budget.cores, 8);
        assert_eq!(
            now.jobs
                .iter()
                .map(|j| (j.ticket.label.as_str(), j.running, j.position))
                .collect::<Vec<_>>(),
            [("big", true, 0), ("next", false, 1), ("small", false, 2)]
        );
        drop(big);
        let next = next.join().unwrap();
        let small = small.join().unwrap();
        // Each has its own processors.
        assert!(
            next.ticket
                .cpus
                .iter()
                .all(|c| !small.ticket.cpus.contains(c))
        );
        drop((next, small));
        assert!(snapshot().jobs.is_empty());
        fs::remove_dir_all(dir).unwrap();
        fs::remove_file(config).unwrap();
    }

    #[test]
    fn a_tickets_time_reads_back() {
        assert!(seconds_since(&crate::now()) < 2);
        assert!(seconds_since("2026-01-01T00:00:00.000Z") > 86_400);
    }

    #[test]
    fn whole_cores_go_first() {
        let cores = processors();
        if cores.first().is_some_and(|c| c.len() == 2) {
            let two = choose(2, &[]);
            assert!(cores.contains(&two));
        }
    }
}
