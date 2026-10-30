//! `render-slot`: runs a heavy job (a Blender render, an ffmpeg encode or upscale, a headless
//! Chrome render, Whisper) when this machine's render queue gives it a turn, and shows the queue.
use corral::queue;
use std::process::{Command, ExitCode};

const USAGE: &str = "render-slot: heavy jobs take turns for this machine's cores and GPU.

  render-slot run [--cores N] [--gpu] [--label TEXT] -- COMMAND [ARGS...]
      Waits for this machine's render queue to give the job its turn, first come, first served,
      then runs it held to N cores (default 4; match the job's own threads, as ffmpeg -threads N)
      at a lower priority. --gpu waits for a seat on the GPU as well (Blender, GPU upscales).
      Its exit status is the command's.
  render-slot status [--json]
      What is running and what waits, with each job's place in line.
  render-slot COMMAND [ARGS...]
      As run, with the defaults: how the old render-slot.sh was called.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("status") => status(args.iter().any(|a| a == "--json")),
        Some("run") => run(&args[1..]),
        // Options first, as `run` takes them; otherwise the command itself.
        Some(first) if first.starts_with("--") => run(&args),
        Some(_) => run(&[String::from("--")]
            .into_iter()
            .chain(args)
            .collect::<Vec<_>>()),
    }
}

fn fail(message: &str) -> ExitCode {
    eprintln!("render-slot: {message}");
    ExitCode::from(2)
}

fn run(args: &[String]) -> ExitCode {
    let mut cores = queue::CORES;
    let mut gpu = false;
    let mut label = String::new();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--" => {
                i += 1;
                break;
            }
            "--gpu" => gpu = true,
            "--cores" | "--label" if i + 1 < args.len() => {
                if args[i] == "--cores" {
                    let Ok(n) = args[i + 1].parse() else {
                        return fail("--cores takes a number");
                    };
                    cores = n;
                } else {
                    label = args[i + 1].clone();
                }
                i += 1;
            }
            other if other.starts_with("--") => return fail(&format!("unknown option {other}")),
            _ => break,
        }
        i += 1;
    }
    let command = &args[i..];
    if command.is_empty() {
        return fail("give the command to run after --");
    }
    let place = match queue::take(queue::ticket(command, &label, cores, gpu), |ahead| {
        queue::say(&format!("waiting: {ahead} in line before this job"));
    }) {
        Ok(place) => place,
        Err(e) => return fail(&format!("could not join the queue: {e}")),
    };
    queue::say(&format!(
        "got a turn on {} cores{}: {}",
        place.ticket.cpus.len().max(place.ticket.cores),
        if gpu { " and the GPU" } else { "" },
        command.join(" ")
    ));
    let mut job = Command::new(&command[0]);
    job.args(&command[1..]);
    for (key, value) in settings_env() {
        if std::env::var_os(&key).is_none() {
            job.env(key, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        let cpus = place.ticket.cpus.clone();
        let fd = place.lock.as_raw_fd();
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            job.pre_exec(move || {
                if !cpus.is_empty() {
                    let mut set: libc::cpu_set_t = std::mem::zeroed();
                    for cpu in &cpus {
                        libc::CPU_SET(*cpu, &mut set);
                    }
                    libc::sched_setaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &set);
                }
                libc::setpriority(libc::PRIO_PROCESS, 0, 10);
                // The job keeps its place in the queue for as long as it runs.
                let flags = libc::fcntl(fd, libc::F_GETFD);
                libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC);
                Ok(())
            });
        }
        // This process becomes the job, holding its ticket until it ends.
        let error = job.exec();
        fail(&format!("could not run {}: {error}", command[0]))
    }
    #[cfg(not(unix))]
    {
        let status = job.status();
        drop(place);
        match status {
            Ok(s) => ExitCode::from(s.code().unwrap_or(1).clamp(0, 255) as u8),
            Err(e) => fail(&format!("could not run {}: {e}", command[0])),
        }
    }
}

/// Environment the machine's settings give every job, such as which GPU to use.
fn settings_env() -> Vec<(String, String)> {
    corral::home_dir()
        .and_then(|h| std::fs::read(h.join(".config/render-slot.json")).ok())
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["env"].as_object().cloned())
        .map(|env| {
            env.into_iter()
                .filter_map(|(k, v)| Some((k, v.as_str()?.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

/// How long ago a time was, as "12 min".
fn ago(time: &str) -> String {
    let secs = queue::seconds_since(time);
    match secs {
        0..60 => format!("{secs} s"),
        60..3600 => format!("{} min", secs / 60),
        _ => format!("{} h {} min", secs / 3600, secs % 3600 / 60),
    }
}
fn status(json: bool) -> ExitCode {
    let now = queue::snapshot();
    if json {
        println!("{}", serde_json::to_string_pretty(&now).unwrap_or_default());
        return ExitCode::SUCCESS;
    }
    let used: usize = now
        .jobs
        .iter()
        .filter(|j| j.running)
        .map(|j| j.ticket.cores)
        .sum::<usize>()
        + now.legacy * queue::CORES;
    println!(
        "{} of {} cores in use, {} GPU seat{}{}",
        used,
        now.budget.cores,
        now.budget.gpus,
        if now.budget.gpus == 1 { "" } else { "s" },
        if now.legacy > 0 {
            format!("; {} job(s) from before the queue", now.legacy)
        } else {
            String::new()
        }
    );
    if now.jobs.is_empty() {
        println!("Nothing queued.");
    }
    for job in &now.jobs {
        let t = &job.ticket;
        let what = if t.label.is_empty() {
            &t.command
        } else {
            &t.label
        };
        let folder = t
            .cwd
            .rsplit(['/', '\\'])
            .find(|p| !p.is_empty())
            .unwrap_or("");
        println!(
            "{:<16} {:>2} cores{} {:<20} {}",
            if job.running {
                format!("running {}", ago(&t.started))
            } else {
                format!("#{} {}", job.position, ago(&t.since))
            },
            t.cores,
            if t.gpu { " +GPU" } else { "     " },
            folder,
            what.chars().take(90).collect::<String>()
        );
    }
    ExitCode::SUCCESS
}
