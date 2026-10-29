//! Work agents leave running after their turns: a render started with `nohup … &`, a server, a
//! long build. Every process of a turn carries `CORRAL_PLACE`, its conversation, agent, and
//! thread, and keeps it in whatever it starts; whatever still carries it once the turn is over
//! is that agent's background work there, which the app shows apart from a turn under way.
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
impl Corral {
    /// Looks for agents' background work now and every few seconds, and tells the app when what
    /// is running changes. A place counts once it is seen twice, so a turn's last processes
    /// exiting as it ends are not counted.
    pub(crate) fn watch_background(&self) {
        if !cfg!(target_os = "linux") {
            return;
        }
        let corral = self.clone();
        tokio::spawn(async move {
            let mut before: HashMap<TurnKey, String> = HashMap::new();
            loop {
                let found = tokio::task::spawn_blocking(tagged)
                    .await
                    .unwrap_or_default();
                let mut now: HashMap<TurnKey, String> = HashMap::new();
                let changed = {
                    let mut state = corral.state.lock().unwrap();
                    for (place, processes) in found {
                        if state.turns.contains_key(&place)
                            || !state.conversations.contains_key(&place.0)
                        {
                            continue;
                        }
                        now.insert(place, summary(&processes));
                    }
                    let steady: HashMap<TurnKey, String> = now
                        .iter()
                        .filter(|(place, _)| before.contains_key(*place))
                        .map(|(p, c)| (p.clone(), c.clone()))
                        .collect();
                    let changed = steady != state.background;
                    state.background = steady;
                    changed
                };
                before = now;
                if changed {
                    let list = list(&corral.state.lock().unwrap());
                    corral.emit(json!({"type":"background","background":list}));
                }
                tokio::time::sleep(EVERY).await;
            }
        });
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
}
