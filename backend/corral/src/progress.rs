//! How far along a running job is, read from its log, and about how long it has left: Blender's
//! saved frames against the frame range it was given, ffmpeg's `time=` against the length of what
//! it encodes, and the house Chrome renderer's `frames` count. A job whose log says none of these
//! has no estimate rather than a made-up one.
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::LazyLock,
};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    /// How much is done, from 0 to 1.
    pub done: f64,
    /// Seconds left, about.
    pub left: u64,
    /// What it counts, as a person reads it: "36 of 3606 frames".
    pub counted: String,
}

/// What a log says so far: its start, where the totals are, and its end, where the latest is.
pub struct Log {
    pub head: String,
    pub tail: String,
}
const WINDOW: u64 = 64 * 1024;
pub fn read(path: &Path) -> Option<Log> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mut head = vec![0; size.min(WINDOW) as usize];
    file.read_exact(&mut head).ok()?;
    let mut tail = Vec::new();
    file.seek(SeekFrom::Start(size.saturating_sub(WINDOW)))
        .ok()?;
    file.read_to_end(&mut tail).ok()?;
    Some(Log {
        head: String::from_utf8_lossy(&head).into_owned(),
        tail: String::from_utf8_lossy(&tail).into_owned(),
    })
}
/// Where a running job writes: the log its ticket names, or on Linux the file its output goes to.
pub fn log_of(pid: u32, named: &str) -> Option<PathBuf> {
    if !named.is_empty() {
        return Some(PathBuf::from(named));
    }
    [1, 2].into_iter().find_map(|fd| {
        let path = std::fs::read_link(format!("/proc/{pid}/fd/{fd}")).ok()?;
        path.is_file().then_some(path)
    })
}

/// How far along a job is, from its command, its log, and how long it has run.
pub fn estimate(command: &str, log: &Log, elapsed: u64) -> Option<Progress> {
    // The program's name, from a path that may have spaces in it (`C:\\Program Files\\…\\blender.exe`):
    // what comes before its first option.
    let program = command
        .split(" -")
        .next()
        .unwrap_or_default()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if program.starts_with("ffmpeg") {
        ffmpeg(command, log, elapsed)
    } else if program.starts_with("blender") {
        blender(command, log, elapsed)
    } else {
        frames(log, elapsed)
    }
}
/// A finished share of the work at the pace so far.
fn at_pace(done: f64, elapsed: u64, counted: String) -> Option<Progress> {
    if done.is_nan() || done <= 0.0 || elapsed == 0 {
        return None;
    }
    let done = done.min(1.0);
    Some(Progress {
        done,
        left: (elapsed as f64 * (1.0 - done) / done).round() as u64,
        counted,
    })
}

static CHROME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(\d+)/(\d+) frames").unwrap());
/// The house Chrome renderer's "  1200/9000 frames · 300 s".
fn frames(log: &Log, elapsed: u64) -> Option<Progress> {
    let last = CHROME.captures_iter(&log.tail).last()?;
    let (done, total): (f64, f64) = (last[1].parse().ok()?, last[2].parse().ok()?);
    at_pace(
        done / total,
        elapsed,
        format!("{} of {} frames", &last[1], &last[2]),
    )
}

static DURATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)").unwrap());
static TIME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"time=(-?\d+):(\d+):(\d+(?:\.\d+)?)").unwrap());
static SPEED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"speed=\s*(\d+(?:\.\d+)?)x").unwrap());
fn clock(h: &str, m: &str, s: &str) -> Option<f64> {
    Some(h.parse::<f64>().ok()? * 3600.0 + m.parse::<f64>().ok()? * 60.0 + s.parse::<f64>().ok()?)
}
/// Seconds as ffmpeg takes them: `90`, `1:30`, or `00:01:30.5`.
fn seconds(text: &str) -> Option<f64> {
    let parts: Vec<&str> = text.split(':').collect();
    match parts.as_slice() {
        [s] => s.parse().ok(),
        [m, s] => clock("0", m, s),
        [h, m, s] => clock(h, m, s),
        _ => None,
    }
}
/// ffmpeg's latest `time=` against how long the output will be: `-t`, else the first input's length.
fn ffmpeg(command: &str, log: &Log, elapsed: u64) -> Option<Progress> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let length = words
        .windows(2)
        .find(|w| w[0] == "-t")
        .and_then(|w| seconds(w[1]))
        .or_else(|| {
            let d = DURATION.captures(&log.head)?;
            clock(&d[1], &d[2], &d[3])
        })?;
    let t = TIME.captures_iter(&log.tail).last()?;
    let at = clock(&t[1], &t[2], &t[3])?.max(0.0);
    if length <= 0.0 {
        return None;
    }
    let done = (at / length).min(1.0);
    let counted = format!("{} of {}", minutes(at), minutes(length));
    let speed = SPEED
        .captures_iter(&log.tail)
        .last()
        .and_then(|s| s[1].parse::<f64>().ok())
        .filter(|s| *s > 0.0);
    match speed {
        Some(speed) if done > 0.0 => Some(Progress {
            done,
            left: ((length - at).max(0.0) / speed).round() as u64,
            counted,
        }),
        _ => at_pace(done, elapsed, counted),
    }
}
fn minutes(s: f64) -> String {
    let s = s.round() as u64;
    format!("{}:{:02}", s / 60, s % 60)
}

/// The frames a Blender command renders: a script's `--frames A-B[,C-D]`, or `-s A -e B` with `-a`.
fn blender_frames(command: &str) -> Option<Vec<(u64, u64)>> {
    let words: Vec<&str> = command.split_whitespace().collect();
    let after = |flag: &str| {
        words
            .windows(2)
            .find(|w| w[0] == flag)
            .map(|w| w[1].to_owned())
    };
    if let Some(spans) = after("--frames") {
        return spans
            .split(',')
            .map(|span| {
                let (a, b) = span.split_once('-').unwrap_or((span, span));
                Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
            })
            .collect::<Option<Vec<_>>>()
            .filter(|s: &Vec<(u64, u64)>| !s.is_empty() && s.iter().all(|(a, b)| a <= b));
    }
    if words.contains(&"-a") {
        let (a, b) = (after("-s")?.parse().ok()?, after("-e")?.parse().ok()?);
        return (a <= b).then(|| vec![(a, b)]);
    }
    None
}
static SAVED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?m)^(?:(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s)?.*?Saved: '[^']*?(\d+)\.\w+'").unwrap()
});
static FRA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"Fra:(\d+)").unwrap());
static SAMPLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:Sample|Rendering) (\d+)\s*/\s*(\d+)").unwrap());
/// Blender: the latest frame saved against the range, at the pace between the latest saves when
/// the log stamps them (so frames it skipped as already made do not count), else the pace so far.
fn blender(command: &str, log: &Log, elapsed: u64) -> Option<Progress> {
    let spans = blender_frames(command)?;
    let total: u64 = spans.iter().map(|(a, b)| b - a + 1).sum();
    // How many of the range come before `frame`, which is in it.
    let before = |frame: u64| -> Option<u64> {
        let mut n = 0;
        for &(a, b) in &spans {
            if (a..=b).contains(&frame) {
                return Some(n + frame - a);
            }
            n += b - a + 1;
        }
        None
    };
    // Each save: when, by the log's clock if it stamps lines, and the frame; and where it is.
    let saves: Vec<(Option<f64>, u64, usize)> = SAVED
        .captures_iter(&log.tail)
        .filter_map(|c| {
            let at = c.get(2).zip(c.get(3)).and_then(|(m, s)| {
                clock(c.get(1).map_or("0", |h| h.as_str()), m.as_str(), s.as_str())
            });
            Some((at, c[4].parse().ok()?, c.get(0)?.end()))
        })
        .collect();
    // Frames done: up to the latest saved, else before the frame Blender is on.
    let (whole, from) = match saves.last() {
        Some(&(_, frame, end)) => (before(frame)? + 1, end),
        None => {
            let frame: u64 = FRA.captures_iter(&log.tail).last()?[1].parse().ok()?;
            (before(frame)?, 0)
        }
    };
    // And into the frame under way, by its samples since then.
    let into = SAMPLE
        .captures_iter(&log.tail[from..])
        .last()
        .and_then(|s| Some(s[1].parse::<f64>().ok()? / s[2].parse::<f64>().ok()?))
        .filter(|f| f.is_finite())
        .map_or(0.0, |f| f.min(0.99));
    let done = whole as f64 + into;
    let counted = format!("{whole} of {total} frames");
    // The pace between the latest saves, by the log's own clock.
    let stamped: Vec<f64> = saves.iter().filter_map(|(at, _, _)| *at).collect();
    if stamped.len() >= 3 {
        let recent = &stamped[stamped.len().saturating_sub(9)..];
        let pace = (recent[recent.len() - 1] - recent[0]) / (recent.len() - 1) as f64;
        if pace > 0.0 {
            let since = (elapsed as f64 - recent[recent.len() - 1]).max(0.0);
            let fraction = done / total as f64;
            return Some(Progress {
                done: fraction.min(1.0),
                left: ((total as f64 - done) * pace - since).max(0.0).round() as u64,
                counted,
            });
        }
    }
    at_pace(done / total as f64, elapsed, counted)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn log(text: &str) -> Log {
        Log {
            head: text.into(),
            tail: text.into(),
        }
    }
    #[test]
    fn blender_counts_saved_frames_at_the_pace_between_them() {
        let text = "00:00.348  blend | Read blend\n\
            02:49.586  render | Saved: '/w/out/f0001.png'\nFRAME 1 169.0s\n\
            05:36.941  render | Saved: '/w/out/f0002.png'\n\
            08:23.922  render | Saved: '/w/out/f0003.png'\n\
            11:10.000  render | Saved: '/w/out/f0004.png'\n";
        let p = estimate(
            "/usr/bin/blender -b act1/scene.blend -P r.py -- --frames 1-100 --out o",
            &log(text),
            700,
        )
        .unwrap();
        assert_eq!(p.counted, "4 of 100 frames");
        assert!((p.done - 0.04).abs() < 1e-9);
        // 96 frames at about 167 s, less the 30 s since the last.
        let pace = (670.0 - 169.586) / 3.0;
        assert_eq!(p.left, (96.0 * pace - 30.0f64).round() as u64);
        // Without a range, no guess.
        assert!(estimate("blender -b a.blend -f 1", &log(text), 700).is_none());
    }
    #[test]
    fn blender_without_stamps_and_with_spans_goes_at_the_pace_so_far() {
        let text = "Fra:12 Mem:10M | Rendering\nSaved: '/w/out/0105.png'\n";
        let p = estimate(
            "blender -b a.blend -- --frames 1-10,100-189",
            &log(text),
            600,
        )
        .unwrap();
        // Frame 105 is the 16th of the range.
        assert_eq!(p.counted, "16 of 100 frames");
        assert_eq!(p.left, (600.0 * 84.0 / 16.0f64).round() as u64);
        let p = estimate(
            "blender -b a.blend -s 1 -e 50 -a",
            &log("Fra:26 Mem:1M"),
            500,
        )
        .unwrap();
        assert_eq!(p.counted, "25 of 50 frames");
        assert_eq!(p.left, 500);
    }
    #[test]
    fn ffmpeg_goes_by_time_and_speed() {
        let head = "Input #0, mov, from 'a.mp4':\n  Duration: 00:05:00.00, start: 0.000000\n";
        let tail = "frame= 100 fps=30 time=00:01:00.00 bitrate=1k speed=2.0x\rframe= 200 fps=30 time=00:02:30.00 bitrate=1k speed=1.5x\r";
        let l = Log {
            head: head.into(),
            tail: tail.into(),
        };
        let p = estimate("ffmpeg -i a.mp4 -c:v libx264 b.mp4", &l, 100).unwrap();
        assert_eq!(p.counted, "2:30 of 5:00");
        assert_eq!(p.done, 0.5);
        assert_eq!(p.left, 100);
        // `-t` sets the length.
        let p = estimate("ffmpeg -i a.mp4 -t 200 b.mp4", &l, 100).unwrap();
        assert_eq!(p.done, 0.75);
    }
    #[test]
    fn the_chrome_renderer_counts_its_frames_and_other_logs_say_nothing() {
        let text = "340.0 s · 20400 frames · 4 workers\n  300/20400 frames · 60 s\n  600/20400 frames · 120 s\n";
        let p = estimate("node tools/render.mjs ep1", &log(text), 120).unwrap();
        assert_eq!(p.counted, "600 of 20400 frames");
        assert_eq!(p.left, (120.0 * 19800.0 / 600.0f64).round() as u64);
        assert!(estimate("python whisper.py", &log("loading model"), 50).is_none());
        // A program in a folder with spaces in its name is still known.
        let windows = r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe -b a.blend -- --frames 1-10";
        assert!(estimate(windows, &log("Saved: 'C:\\out\\f0005.png'"), 50).is_some());
    }
}
