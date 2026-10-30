//! `render-slot`: runs a heavy job (a Blender render, an ffmpeg encode or upscale, a headless
//! Chrome render, Whisper) when this machine's render queue gives it a turn, and shows the queue.
mod blender;
mod edit;
mod split;

use corral::queue;
use std::path::Path;
use std::process::{Command, ExitCode};

const USAGE: &str = "render-slot: heavy jobs take turns for this machine's cores and GPU.

  render-slot run [--cores N] [--gpu] [--label TEXT] -- COMMAND [ARGS...]
      Waits for this machine's render queue to give the job its turn, first come, first served,
      then runs it held to N cores (default 4; match the job's own threads, as ffmpeg -threads N)
      at a lower priority. --gpu waits for a seat on the GPU as well (Blender, GPU upscales).
      Its exit status is the command's.
  render-slot run --on MACHINE | --needs TAG,TAG [--in PATH]... [--out PATH]... [...] -- COMMAND
      Runs the job on another machine of the farm, through its queue: --on names it, --needs
      picks the least busy one with every tag (as blender,cuda; `render-slot machines` lists
      them), tars included. --in paths (files or folders, relative to here) go with the job, and
      --out paths come back here when it ends. The command runs in the job's folder there, so
      give it those relative paths, and a program by name (blender, ffmpeg, node).
  render-slot machines
      The farm: each machine, whether it answers, its tags, and how busy its queue is.
  render-slot status [--json]
      What is running and what waits here, with each job's place in line.
  render-slot COMMAND [ARGS...]
      As run, with the defaults: how the old render-slot.sh was called.

Linked as `blender` ahead of Blender on the path, it sends a background render (-b with -a, -f,
or a script's --frames) through the queue with the GPU, where its frames split across the farm;
Blender with a window, a background run that renders nothing, and Blender inside a queued job run
as they are.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let called = std::env::args().next().unwrap_or_default();
    if Path::new(&called)
        .file_stem()
        .is_some_and(|n| n.eq_ignore_ascii_case("blender"))
    {
        return as_blender(&args);
    }
    match args.first().map(String::as_str) {
        None | Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
        Some("status") => status(args.iter().any(|a| a == "--json")),
        Some("machines") => machines(),
        Some("run") => run(&args[1..]),
        // Options first, as `run` takes them; otherwise the command itself.
        Some(first) if first.starts_with("--") => run(&args),
        Some(_) => run(&[String::from("--")]
            .into_iter()
            .chain(args)
            .collect::<Vec<_>>()),
    }
}

/// Blender, through the queue when it renders in the background.
fn as_blender(args: &[String]) -> ExitCode {
    let Some(real) = next_on_path("blender") else {
        return fail("no Blender on the path after this one");
    };
    let (options, script) = match args.iter().position(|a| a == "--") {
        Some(at) => (&args[..at], &args[at..]),
        None => (args, &[][..]),
    };
    let background = options.iter().any(|a| a == "-b" || a == "--background");
    let renders = options
        .iter()
        .any(|a| ["-a", "--render-anim", "-f", "--render-frame"].contains(&a.as_str()))
        || script.iter().any(|a| a == "--frames");
    if std::env::var_os(JOB).is_some() || !background || !renders {
        let mut blender = Command::new(&real);
        blender.args(args);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let error = blender.exec();
            return fail(&format!("could not run {}: {error}", real.display()));
        }
        #[cfg(not(unix))]
        return ExitCode::from(
            blender
                .status()
                .ok()
                .and_then(|s| s.code())
                .unwrap_or(1)
                .clamp(0, 255) as u8,
        );
    }
    // What it renders, for the queue: the script, or else the scene.
    let named = options
        .iter()
        .position(|a| a == "-P" || a == "--python")
        .and_then(|at| options.get(at + 1))
        .or_else(|| options.iter().find(|a| a.ends_with(".blend")))
        .and_then(|p| Path::new(p).file_name())
        .map_or_else(String::new, |n| format!(" · {}", n.to_string_lossy()));
    let mut queued = vec![
        "--gpu".to_owned(),
        "--label".into(),
        format!("Blender{named}"),
        "--".into(),
        real.to_string_lossy().into_owned(),
    ];
    queued.extend(args.iter().cloned());
    run(&queued)
}
/// Set in a queued job's environment, so a program inside it is not queued again.
const JOB: &str = "RENDER_SLOT_JOB";
/// The first `program` on the path that is not this one.
fn next_on_path(program: &str) -> Option<std::path::PathBuf> {
    let me = std::env::current_exe()
        .ok()
        .and_then(|p| std::fs::canonicalize(p).ok());
    let names = [program.to_owned(), format!("{program}.exe")];
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|dir| names.iter().map(move |n| dir.join(n)))
        .find(|candidate| {
            candidate.is_file() && std::fs::canonicalize(candidate).ok().as_ref() != me.as_ref()
        })
}

fn fail(message: &str) -> ExitCode {
    eprintln!("render-slot: {message}");
    ExitCode::from(2)
}

fn run(args: &[String]) -> ExitCode {
    let mut cores = queue::CORES;
    let mut gpu = false;
    let mut label = String::new();
    let (mut on, mut needs) = (String::new(), Vec::<String>::new());
    let (mut inputs, mut outputs) = (Vec::<String>::new(), Vec::<String>::new());
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--" => {
                i += 1;
                break;
            }
            "--gpu" => gpu = true,
            "--cores" | "--label" | "--on" | "--needs" | "--in" | "--out" if i + 1 < args.len() => {
                let value = args[i + 1].clone();
                match args[i].as_str() {
                    "--cores" => {
                        let Ok(n) = value.parse() else {
                            return fail("--cores takes a number");
                        };
                        cores = n;
                    }
                    "--label" => label = value,
                    "--on" => on = value,
                    "--needs" => needs.extend(
                        value
                            .split(',')
                            .map(|t| t.trim().to_lowercase())
                            .filter(|t| !t.is_empty()),
                    ),
                    "--in" => inputs.push(value),
                    _ => outputs.push(value),
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
    if !on.is_empty() || !needs.is_empty() {
        let job = Remote {
            command: command.to_vec(),
            cores,
            gpu,
            label: label.clone(),
            inputs,
            outputs,
        };
        match pick(&on, &needs) {
            Ok(Some(machine)) => return send(&machine, &job),
            // This machine fits best: the job runs here, as any other.
            Ok(None) => {}
            Err(e) => return fail(&e),
        }
    } else if !inputs.is_empty() || !outputs.is_empty() {
        return fail("--in and --out are for a job sent with --on or --needs");
    } else if let Some(render) = split::render(command, &label) {
        // A whole video from a renderer that can render any stretch: across the farm.
        return split::run(render);
    } else if let Some(job) = blender::job(command, &label) {
        // A Blender script's frames: across one group of the farm, unless it runs here.
        if let Some(code) = blender::run(job) {
            return code;
        }
    } else if let Some(edit) = edit::job(command, &label) {
        // A documentary's whole picture: in pieces side by side here.
        return edit::run(edit);
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
    job.args(&command[1..]).env(JOB, &place.ticket.id);
    for (key, value) in settings_env() {
        if std::env::var_os(&key).is_none() {
            job.env(key, value);
        }
    }
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        #[cfg_attr(not(target_os = "linux"), allow(unused_variables))]
        let cpus = place.ticket.cpus.clone();
        let fd = place.lock.as_raw_fd();
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            job.pre_exec(move || {
                // Only Linux can hold a process to some processors; elsewhere the budget holds.
                #[cfg(target_os = "linux")]
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
    span(queue::seconds_since(time))
}
fn span(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs} s"),
        60..3600 => format!("{} min", secs / 60),
        3600..172_800 => format!("{} h {} min", secs / 3600, secs % 3600 / 60),
        _ => format!("{} days {} h", secs / 86_400, secs % 86_400 / 3600),
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
        if let Some(p) = &job.progress {
            println!("{:<16} {}, about {} left", "", p.counted, span(p.left));
        }
    }
    ExitCode::SUCCESS
}

// ---- The farm: sending a job to another machine ----

/// Another machine of the farm, as this one's Corral lists it in `~/Corral/hosts.json`.
#[derive(Clone, serde::Deserialize)]
struct Machine {
    name: String,
    url: String,
    key: String,
}
struct Remote {
    command: Vec<String>,
    cores: usize,
    gpu: bool,
    label: String,
    inputs: Vec<String>,
    outputs: Vec<String>,
}
fn hosts() -> Vec<Machine> {
    corral::default_root()
        .ok()
        .and_then(|r| std::fs::read(r.join("hosts.json")).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
/// This machine's name, as the farm knows it.
fn here() -> String {
    std::env::var("RENDER_MACHINE")
        .or_else(|_| std::env::var("OMARCHY_HOST_NAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_lowercase())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "here".into())
}
/// A file of curl options, readable by this account only, as the key must be; gone when dropped.
struct Options(std::path::PathBuf);
impl Options {
    fn new(machine: &Machine, path: &str, extra: &[&str]) -> std::io::Result<Options> {
        use std::io::Write;
        let path_on_disk = std::env::temp_dir().join(format!(
            "render-slot-{}.curl",
            uuid::Uuid::new_v4().simple()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path_on_disk)?;
        let quoted = |t: &str| format!("\"{}\"", t.replace('\\', "\\\\").replace('"', "\\\""));
        let mut lines = vec![
            format!(
                "url = {}",
                quoted(&format!("{}{path}", machine.url.trim_end_matches('/')))
            ),
            format!(
                "header = {}",
                quoted(&format!("Authorization: Bearer {}", machine.key))
            ),
            "silent".into(),
            "show-error".into(),
            "fail-with-body".into(),
        ];
        lines.extend(extra.iter().map(|l| (*l).to_owned()));
        file.write_all(lines.join("\n").as_bytes())?;
        Ok(Options(path_on_disk))
    }
}
impl Drop for Options {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}
/// Asks a machine for `path`, with an optional JSON body, and reads its JSON answer.
fn ask(
    machine: &Machine,
    path: &str,
    body: Option<&serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let mut extra = vec!["max-time = 30"];
    let data;
    if let Some(body) = body {
        extra.push("header = \"Content-Type: application/json\"");
        data = format!(
            "data-binary = \"{}\"",
            body.to_string().replace('\\', "\\\\").replace('"', "\\\"")
        );
        extra.push(&data);
    }
    let options = Options::new(machine, path, &extra).map_err(|e| e.to_string())?;
    let out = Command::new("curl")
        .arg("--config")
        .arg(&options.0)
        .output()
        .map_err(|e| format!("curl could not run: {e}"))?;
    let said: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    if !out.status.success() {
        return Err(said["error"].as_str().map_or_else(
            || {
                format!(
                    "{} did not answer ({})",
                    machine.name,
                    String::from_utf8_lossy(&out.stderr).trim()
                )
            },
            |e| format!("{}: {e}", machine.name),
        ));
    }
    Ok(said)
}
/// How busy a machine's queue is, from 0: cores in use and waiting over its budget.
fn busy(farm: &serde_json::Value) -> f64 {
    let q = &farm["queue"];
    let jobs = q["jobs"].as_array().cloned().unwrap_or_default();
    let cores: u64 = jobs.iter().filter_map(|j| j["cores"].as_u64()).sum::<u64>()
        + q["legacy"].as_u64().unwrap_or(0) * queue::CORES as u64;
    cores as f64 / q["budget"]["cores"].as_u64().unwrap_or(1).max(1) as f64
}
/// The machine a job goes to: the one named, or the least busy with every tag it needs, this
/// one included; None when that is this one.
fn pick(on: &str, needs: &[String]) -> Result<Option<Machine>, String> {
    let me = here();
    if on.eq_ignore_ascii_case(&me) {
        return Ok(None);
    }
    let hosts = hosts();
    if !on.is_empty() {
        return hosts
            .into_iter()
            .find(|h| h.name.eq_ignore_ascii_case(on))
            .map(Some)
            .ok_or_else(|| format!("{on} is not in the farm; `render-slot machines` lists it"));
    }
    let fits = |tags: &[String]| {
        needs
            .iter()
            .all(|n| tags.iter().any(|t| t.eq_ignore_ascii_case(n)))
    };
    let mut best: Option<(f64, Option<Machine>)> = None;
    if fits(&corral::farm::tags()) {
        let local = serde_json::json!({"queue": queue::snapshot()});
        best = Some((busy(&local), None));
    }
    for host in hosts {
        let Ok(farm) = ask(&host, "/api/corral/farm", None) else {
            continue;
        };
        let tags: Vec<String> = farm["tags"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|t| t.as_str().map(str::to_owned))
            .collect();
        if !fits(&tags) {
            continue;
        }
        let load = busy(&farm);
        if best.as_ref().is_none_or(|(b, _)| load < *b) {
            best = Some((load, Some(host)));
        }
    }
    best.map(|(_, m)| m).ok_or_else(|| {
        format!(
            "No machine that answers has all of: {}; `render-slot machines` lists what each has",
            needs.join(", ")
        )
    })
}
fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}
/// Sends a job to another machine: its input files, then the command, which waits its turn in
/// that machine's queue; then, once it ends, brings back its output files. Exits with its status.
fn send(machine: &Machine, job: &Remote) -> ExitCode {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let jobs = format!("/api/corral/farm/jobs/{id}");
    for path in job.inputs.iter().chain(&job.outputs) {
        if std::path::Path::new(path).is_absolute() || path.split(['/', '\\']).any(|p| p == "..") {
            return fail(&format!(
                "{path}: --in and --out take paths inside this folder"
            ));
        }
    }
    queue::say(&format!(
        "sending to {}: {}",
        machine.name,
        job.command.join(" ")
    ));
    // The input files, as a tar stream, straight into curl.
    let mut packing = vec!["-cf".to_owned(), "-".to_owned()];
    packing.extend(job.inputs.iter().cloned());
    if job.inputs.is_empty() {
        packing.extend([
            "--files-from".into(),
            if cfg!(windows) {
                "NUL".into()
            } else {
                "/dev/null".into()
            },
        ]);
    }
    let options = match Options::new(
        machine,
        &format!("{jobs}/files"),
        &[
            "data-binary = @-",
            "header = \"Content-Type: application/x-tar\"",
        ],
    ) {
        Ok(o) => o,
        Err(e) => return fail(&e.to_string()),
    };
    let sent = Command::new("tar")
        .args(&packing)
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
    match sent {
        Ok(out) if out.status.success() => {}
        Ok(out) => {
            return fail(&format!(
                "could not send the files to {}: {}{}",
                machine.name,
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Err(e) => return fail(&format!("could not send the files: {e}")),
    }
    drop(options);
    let body = serde_json::json!({
        "command": job.command,
        "cores": job.cores,
        "gpu": job.gpu,
        "label": job.label,
        "place": std::env::var("CORRAL_PLACE").unwrap_or_default(),
    });
    if let Err(e) = ask(machine, &format!("{jobs}/run"), Some(&body)) {
        return fail(&format!("could not start the job: {e}"));
    }
    // Its place in that machine's line, then its end.
    let mut told = String::new();
    let (code, log) = loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        let Ok(status) = ask(machine, &jobs, None) else {
            continue;
        };
        let state = status["state"].as_str().unwrap_or_default();
        let line = match state {
            "waiting" => format!("{}: waiting, {} in line", machine.name, status["position"]),
            "running" => format!("{}: running", machine.name),
            _ => String::new(),
        };
        if !line.is_empty() && line != told {
            queue::say(&line);
            told = line;
        }
        if state == "done" {
            break (
                status["exit"].as_i64().unwrap_or(-1),
                status["log"].as_str().unwrap_or_default().to_owned(),
            );
        }
    };
    eprint!("{log}");
    if code == 0 && !job.outputs.is_empty() {
        let paths = encode(&job.outputs.join("\n"));
        let options = match Options::new(machine, &format!("{jobs}/files?paths={paths}"), &[]) {
            Ok(o) => o,
            Err(e) => return fail(&e.to_string()),
        };
        let fetched = Command::new("curl")
            .arg("--config")
            .arg(&options.0)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut curl| {
                let out = curl.stdout.take().expect("piped");
                let tar = Command::new("tar").args(["-xf", "-"]).stdin(out).status()?;
                Ok((curl.wait()?, tar))
            });
        match fetched {
            Ok((curl, tar)) if curl.success() && tar.success() => {
                queue::say(&format!(
                    "brought back {} from {}",
                    job.outputs.join(", "),
                    machine.name
                ));
            }
            _ => {
                return fail(&format!(
                    "the job ended, but its files did not come back from {}; they are in its .cache/corral-farm/{id} folder",
                    machine.name
                ));
            }
        }
    }
    let _ = ask(
        machine,
        &format!("{jobs}/delete"),
        Some(&serde_json::json!({})),
    );
    ExitCode::from(code.clamp(0, 255) as u8)
}
/// `render-slot machines`: the farm, with what each machine has and how busy it is.
fn machines() -> ExitCode {
    let local = queue::snapshot();
    let show = |name: &str, tags: &[String], q: &serde_json::Value| {
        let jobs = q["jobs"].as_array().cloned().unwrap_or_default();
        let running = jobs.iter().filter(|j| j["running"] == true).count();
        println!(
            "{:<10} {:>2} running, {:>2} waiting, {:>2} cores for jobs   {}",
            name,
            running,
            jobs.len() - running,
            q["budget"]["cores"],
            tags.join(" ")
        );
    };
    show(&here(), &corral::farm::tags(), &serde_json::json!(local));
    for host in hosts() {
        match ask(&host, "/api/corral/farm", None) {
            Ok(farm) => {
                let tags: Vec<String> = farm["tags"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|t| t.as_str().map(str::to_owned))
                    .collect();
                show(&host.name, &tags, &farm["queue"]);
            }
            Err(e) => println!("{:<10} not reachable: {e}", host.name),
        }
    }
    ExitCode::SUCCESS
}
