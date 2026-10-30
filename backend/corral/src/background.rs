//! Work agents leave running after their turns: a render started with `nohup … &`, a server, a
//! long build. Every process of a turn carries `CORRAL_PLACE`, its conversation, agent, and
//! thread, and keeps it in whatever it starts; whatever still carries it once the turn is over
//! is that agent's background work there, which the app shows apart from a turn under way.
//!
//! When an agent's background work has all ended, Corral says so where the agent started it and
//! wakes it there, to see how it went and tell the person. What is running is kept in
//! `background.json`, so work that ends while Corral is restarting still wakes its agent.
//!
//! On a systemd host each turn runs in a scope of its own, so that work is not stopped with the
//! service when it restarts. Processes are found through `/proc`, so this is Linux's for now.
use super::*;

/// How often running processes are looked through.
const EVERY: Duration = Duration::from_secs(5);

/// `CORRAL_PLACE` for a place.
pub(crate) fn tag((conversation, agent, thread): &TurnKey) -> String {
    format!("{conversation}\t{agent}\t{thread}")
}
fn untag(value: &str) -> Option<TurnKey> {
    let mut parts = value.splitn(3, '\t');
    Some((
        parts.next()?.to_owned(),
        parts.next()?.to_owned(),
        parts.next()?.to_owned(),
    ))
}
/// Whether turns can run in scopes of their own: a Linux host whose user systemd answers.
pub(crate) fn scoped() -> bool {
    static SCOPED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *SCOPED.get_or_init(|| {
        cfg!(target_os = "linux")
            && std::process::Command::new("systemd-run")
                .args(["--user", "--scope", "--quiet", "--collect", "--", "true"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
    })
}
/// A running process that carries a place: its id, its parent's, and its command.
struct Tagged {
    pid: u32,
    parent: u32,
    command: String,
}
/// Every running process of this account that carries a place.
fn tagged() -> HashMap<TurnKey, Vec<Tagged>> {
    let mut found: HashMap<TurnKey, Vec<Tagged>> = HashMap::new();
    for entry in fs::read_dir("/proc").into_iter().flatten().flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        // Another account's processes cannot be read, and are not an agent's.
        let Ok(environ) = fs::read(entry.path().join("environ")) else {
            continue;
        };
        let Some(place) = environ
            .split(|b| *b == 0)
            .find_map(|v| v.strip_prefix(b"CORRAL_PLACE="))
            .and_then(|v| untag(&String::from_utf8_lossy(v)))
        else {
            continue;
        };
        let stat = fs::read_to_string(entry.path().join("stat")).unwrap_or_default();
        // The parent follows the command's closing parenthesis and the state.
        let parent = stat
            .rsplit_once(')')
            .and_then(|(_, rest)| rest.split_whitespace().nth(1)?.parse().ok())
            .unwrap_or(0);
        let command = fs::read(entry.path().join("cmdline"))
            .unwrap_or_default()
            .split(|b| *b == 0)
            .filter(|w| !w.is_empty())
            .map(|w| String::from_utf8_lossy(w).into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        found.entry(place).or_default().push(Tagged {
            pid,
            parent,
            command,
        });
    }
    found
}
/// What a place's background work is, for a person to recognize: the command at the top of it.
fn summary(processes: &[Tagged]) -> String {
    let ids: Vec<u32> = processes.iter().map(|p| p.pid).collect();
    let top = processes
        .iter()
        .filter(|p| !ids.contains(&p.parent))
        .min_by_key(|p| p.pid)
        .or(processes.first());
    clip(top.map_or("", |p| p.command.as_str()), 100)
}
/// What a place's work is doing in the render queue, if it is in it: its turn, or its place in
/// line.
fn queued(queue: &crate::queue::Snapshot, place: &TurnKey, machine: &str) -> Option<String> {
    let job = queue.jobs.iter().find(|j| j.ticket.place == tag(place))?;
    let what = if job.ticket.label.is_empty() {
        clip(&job.ticket.command, 80)
    } else {
        job.ticket.label.clone()
    };
    Some(if job.running {
        format!("rendering on {machine}: {what}")
    } else {
        let n = job.position;
        let nth = match n % 10 {
            1 if n % 100 != 11 => "st",
            2 if n % 100 != 12 => "nd",
            3 if n % 100 != 13 => "rd",
            _ => "th",
        };
        format!("waiting for a render turn on {machine}, {n}{nth} in line: {what}")
    })
}
/// The background work, for the app.
pub(crate) fn list(state: &Workspace) -> Vec<Value> {
    let mut list: Vec<Value> = state
        .background
        .iter()
        .map(
            |((c, a, t), command)| json!({"conversation":c,"agent":a,"thread":t,"command":command}),
        )
        .collect();
    list.sort_by_key(|a| a.to_string());
    list
}
/// Background work being watched for its end: its command and when it was first seen, in
/// seconds since 1970.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Job {
    command: String,
    since: u64,
}
fn seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}
/// How long something ran, for a person: "40 s", "12 min", "1 h 4 min".
fn lasted(secs: u64) -> String {
    match secs {
        0..60 => format!("{secs} s"),
        60..3600 => format!("{} min", secs / 60),
        _ => format!("{} h {} min", secs / 3600, secs % 3600 / 60),
    }
}
/// Work whose processes have all ended, and is not hidden behind a turn under way there.
fn ended(
    jobs: &HashMap<String, Job>,
    running: &HashMap<TurnKey, Vec<Tagged>>,
    turns: &[TurnKey],
) -> Vec<(TurnKey, Job)> {
    jobs.iter()
        .filter_map(|(tag, job)| Some((untag(tag)?, job.clone())))
        .filter(|(place, _)| !running.contains_key(place) && !turns.contains(place))
        .collect()
}
impl Corral {
    /// Looks for agents' background work now and every few seconds, tells the app when what is
    /// running changes, and wakes an agent where its work has ended. A place counts once it is
    /// seen twice, so a turn's last processes exiting as it ends are not counted.
    pub(crate) fn watch_background(&self) {
        if !cfg!(target_os = "linux") {
            return;
        }
        let corral = self.clone();
        let saved = self.root.join("background.json");
        tokio::spawn(async move {
            let mut before: HashMap<TurnKey, String> = HashMap::new();
            let mut jobs: HashMap<String, Job> = read_json(&saved).unwrap_or_default();
            loop {
                let (found, queue) =
                    tokio::task::spawn_blocking(|| (tagged(), crate::queue::snapshot()))
                        .await
                        .unwrap_or_else(|_| (HashMap::new(), crate::queue::snapshot()));
                let mut now: HashMap<TurnKey, String> = HashMap::new();
                let (changed, done) = {
                    let mut state = corral.state.lock().unwrap();
                    for (place, processes) in &found {
                        if state.turns.contains_key(place)
                            || !state.conversations.contains_key(&place.0)
                        {
                            continue;
                        }
                        let what = queued(&queue, place, &corral.name)
                            .unwrap_or_else(|| summary(processes));
                        now.insert(place.clone(), what);
                    }
                    let steady: HashMap<TurnKey, String> = now
                        .iter()
                        .filter(|(place, _)| before.contains_key(*place))
                        .map(|(p, c)| (p.clone(), c.clone()))
                        .collect();
                    let known = jobs.clone();
                    for (place, command) in &steady {
                        let job = jobs.entry(tag(place)).or_insert(Job {
                            command: command.clone(),
                            since: seconds(),
                        });
                        job.command = command.clone();
                    }
                    let turns: Vec<TurnKey> = state.turns.keys().cloned().collect();
                    let done = ended(&jobs, &found, &turns);
                    for (place, _) in &done {
                        jobs.remove(&tag(place));
                    }
                    // Work in a conversation since deleted is forgotten.
                    jobs.retain(|t, _| {
                        untag(t).is_some_and(|p| state.conversations.contains_key(&p.0))
                    });
                    if jobs != known
                        && let Err(e) = write_json(&saved, &jobs)
                    {
                        eprintln!("corral: could not save background work: {e}");
                    }
                    let changed = steady != state.background;
                    state.background = steady;
                    (changed, done)
                };
                before = now;
                if changed {
                    let list = list(&corral.state.lock().unwrap());
                    corral.emit(json!({"type":"background","background":list}));
                }
                for ((conversation, agent, thread), job) in done {
                    corral.finished(&conversation, &agent, &thread, &job);
                }
                tokio::time::sleep(EVERY).await;
            }
        });
    }
    /// Says where an agent's background work ended that it has, and wakes the agent there.
    fn finished(&self, conversation: &str, agent: &str, thread: &str, job: &Job) {
        let name = match self.state.lock().unwrap().agents.get(agent) {
            Some(a) => a.name.clone(),
            None => return,
        };
        let note = format!(
            "Background work @{name} started has finished: `{}`, after {}.",
            job.command.replace('`', "'"),
            lasted(seconds().saturating_sub(job.since))
        );
        if self.post(conversation, CORRAL, &note, 0, thread).is_ok() {
            self.wake(conversation, agent, thread, 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_place_survives_its_tag_and_names_the_top_command() {
        let place = ("c1".to_owned(), "a1".to_owned(), String::new());
        assert_eq!(untag(&tag(&place)), Some(place));
        let processes = [
            Tagged {
                pid: 20,
                parent: 10,
                command: "bash tools/starlight_recut.sh".into(),
            },
            Tagged {
                pid: 21,
                parent: 20,
                command: "ffmpeg -i in.mp4 out.mp4".into(),
            },
        ];
        assert_eq!(summary(&processes), "bash tools/starlight_recut.sh");
    }

    #[test]
    fn work_has_ended_when_its_processes_have_and_no_turn_is_there() {
        let render = ("c1".to_owned(), "a1".to_owned(), "t1".to_owned());
        let server = ("c2".to_owned(), "a1".to_owned(), String::new());
        let job = Job {
            command: "bash render.sh".into(),
            since: 0,
        };
        let jobs = HashMap::from([(tag(&render), job.clone()), (tag(&server), job.clone())]);
        let running = HashMap::from([(
            server.clone(),
            vec![Tagged {
                pid: 9,
                parent: 1,
                command: "npm run dev".into(),
            }],
        )]);
        assert_eq!(ended(&jobs, &running, &[]), vec![(render.clone(), job)]);
        // While a turn is under way there, its processes hide the work's; it waits for the turn.
        assert!(ended(&jobs, &running, std::slice::from_ref(&render)).is_empty());
        assert_eq!(lasted(42), "42 s");
        assert_eq!(lasted(3840), "1 h 4 min");
    }
}
