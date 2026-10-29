//! An agent's other turns. One agent can be at work in several places at once, a session in each
//! that cannot see the others, often in the same folder. So each turn is told what the agent's
//! other turns are doing: what they were asked, their latest step, and the files they have
//! changed, which Corral reads from their tool calls. `corral working` shows more, and with
//! `corral wait` a turn that would change the same files can end and be woken when they finish.
use super::*;

/// A turn keeps this many of its steps, and this many of the files it changed.
const STEPS: usize = 8;
const FILES: usize = 40;

/// One thing a turn did: what it is doing now, and any files it changed doing it.
#[derive(Default)]
pub(crate) struct Step {
    pub status: Option<String>,
    pub files: Vec<String>,
}
/// Where a place is, for an agent: "#web", or "a thread in #web".
fn where_(state: &Workspace, (conversation, _, thread): &TurnKey) -> Option<String> {
    let c = state.conversations.get(conversation)?;
    Some(if thread.is_empty() {
        place(c)
    } else {
        format!("a thread in {}", place(c))
    })
}
/// Files as a person reads them: under the home folder as `~/…`, and only so many.
fn listed(files: &[String], most: usize) -> String {
    let mut shown: Vec<String> = files.iter().take(most).map(|f| tilde(f)).collect();
    if files.len() > most {
        shown.push(format!("{} more", files.len() - most));
    }
    shown.join(", ")
}
/// The agent's turns under way other than `here`.
fn others<'a>(state: &'a Workspace, agent: &str, here: &TurnKey) -> Vec<(&'a TurnKey, &'a Turn)> {
    let mut turns: Vec<(&TurnKey, &Turn)> = state
        .turns
        .iter()
        .filter(|(key, _)| key.1 == agent && *key != here)
        .collect();
    turns.sort_by(|a, b| a.1.started.cmp(&b.1.started));
    turns
}
/// What a turn's <corral> block says about the agent's other turns and background work, if any.
pub(crate) fn note(state: &Workspace, agent: &str, here: &TurnKey) -> String {
    let mut lines: Vec<String> = others(state, agent, here)
        .into_iter()
        .filter_map(|(key, turn)| {
            let mut line = format!("- In {}", where_(state, key)?);
            if !turn.asked.is_empty() {
                line.push_str(&format!(", asked: {}", turn.asked));
            }
            line.push_str(&format!(". Now: {}", turn.status));
            if !turn.files.is_empty() {
                line.push_str(&format!(". Has changed: {}", listed(&turn.files, 8)));
            }
            Some(line + ".")
        })
        .collect();
    for (key, command) in state.background.iter().filter(|(k, _)| k.1 == agent) {
        if let Some(at) = where_(state, key) {
            lines.push(format!(
                "- In {at}, left running in the background: {command}"
            ));
        }
    }
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "\nYou are at work in other places right now too, each a separate session of yours that cannot see this one (`corral working` shows more):\n{}\n",
        lines.join("\n")
    )
}
/// `corral working`: the agent's other turns in full, and its background work.
pub(crate) fn report(state: &Workspace, agent: &str, here: &TurnKey) -> String {
    let mut out: Vec<String> = Vec::new();
    for (key, turn) in others(state, agent, here) {
        let Some(at) = where_(state, key) else {
            continue;
        };
        let mut block = format!(
            "In {at} (conversation {}{}), since {}:",
            key.0,
            if key.2.is_empty() {
                String::new()
            } else {
                format!(", thread {}", key.2)
            },
            turn.started.get(11..16).unwrap_or(&turn.started)
        );
        if !turn.asked.is_empty() {
            block.push_str(&format!("\n  asked: {}", turn.asked));
        }
        block.push_str(&format!("\n  now: {}", turn.status));
        if turn.steps.len() > 1 {
            block.push_str(&format!("\n  steps: {}", turn.steps.join(" → ")));
        }
        block.push_str(&format!(
            "\n  changed: {}",
            if turn.files.is_empty() {
                "nothing yet".into()
            } else {
                listed(&turn.files, FILES)
            }
        ));
        out.push(block);
    }
    for (key, command) in state.background.iter().filter(|(k, _)| k.1 == agent) {
        if let Some(at) = where_(state, key) {
            out.push(format!(
                "In {at}, left running in the background: {command}"
            ));
        }
    }
    if out.is_empty() {
        "Nothing else of yours is running: this is your only turn.".into()
    } else {
        out.join("\n\n")
    }
}
impl Corral {
    /// A turn's step: what it is doing, for the app, and what it changed, for its other turns.
    pub(crate) fn progress(&self, (conversation, agent, thread): &TurnKey, step: Step) {
        let status = {
            let mut state = self.state.lock().unwrap();
            let Some(turn) =
                state
                    .turns
                    .get_mut(&(conversation.clone(), agent.clone(), thread.clone()))
            else {
                return;
            };
            for file in step.files {
                if !turn.files.contains(&file) && turn.files.len() < FILES {
                    turn.files.push(file);
                }
            }
            let Some(status) = step.status else {
                return;
            };
            turn.status = status.clone();
            turn.steps.push(clip(&status, 60));
            let extra = turn.steps.len().saturating_sub(STEPS);
            turn.steps.drain(..extra);
            status
        };
        self.emit(json!({"type":"status","conversation":conversation,"agent":agent,"thread":thread,"status":status}));
    }
    /// `corral wait`: wakes `here` when each of the agent's other turns ends. Returns where those
    /// are, or none.
    pub(crate) fn wait(&self, agent: &str, here: &TurnKey) -> Vec<String> {
        let mut state = self.state.lock().unwrap();
        let keys: Vec<TurnKey> = others(&state, agent, here)
            .into_iter()
            .map(|(k, _)| k.clone())
            .collect();
        let places: Vec<String> = keys.iter().filter_map(|k| where_(&state, k)).collect();
        for key in keys {
            if let Some(turn) = state.turns.get_mut(&key)
                && !turn.waiters.contains(here)
            {
                turn.waiters.push(here.clone());
            }
        }
        places
    }
    /// A turn has ended, or was stopped: each place that waits on it hears so and is woken.
    pub(crate) fn release(&self, ended: &TurnKey, waiters: Vec<TurnKey>, stopped: bool) {
        let (name, at) = {
            let state = self.state.lock().unwrap();
            (
                state.agents.get(&ended.1).map(|a| a.name.clone()),
                where_(&state, ended),
            )
        };
        let (Some(name), Some(at)) = (name, at) else {
            return;
        };
        for (conversation, agent, thread) in waiters {
            let note = format!(
                "@{name}'s turn in {at}, which it was waiting on, {}.",
                if stopped {
                    "was stopped"
                } else {
                    "has finished"
                }
            );
            if self.post(&conversation, CORRAL, &note, 0, &thread).is_ok() {
                self.wake(&conversation, &agent, &thread, 1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_turn_hears_what_the_agents_other_turns_are_doing() {
        let mut state = Workspace::default();
        for (id, name) in [("c1", "web"), ("c2", "docs")] {
            state.conversations.insert(
                id.into(),
                Conversation {
                    id: id.into(),
                    kind: "channel".into(),
                    name: name.into(),
                    ..Conversation::default()
                },
            );
        }
        let here = ("c1".to_owned(), "a1".to_owned(), String::new());
        let there = ("c2".to_owned(), "a1".to_owned(), "t1".to_owned());
        let someone = ("c2".to_owned(), "a2".to_owned(), String::new());
        assert_eq!(note(&state, "a1", &here), "");
        state.turns.insert(
            there.clone(),
            Turn {
                status: "Edit · tools/edit.py".into(),
                asked: "@you: fix the cannon".into(),
                files: vec!["/x/tools/edit.py".into()],
                steps: vec!["Read · tools/edit.py".into(), "Edit · tools/edit.py".into()],
                started: "2026-10-29T15:00:00.000Z".into(),
                ..Turn::default()
            },
        );
        state.turns.insert(someone, Turn::default());
        state.turns.insert(here.clone(), Turn::default());
        let told = note(&state, "a1", &here);
        assert!(told.contains("- In a thread in #docs, asked: @you: fix the cannon. Now: Edit · tools/edit.py. Has changed: /x/tools/edit.py."));
        // Only its own turns, and not this one.
        assert_eq!(told.matches("- In").count(), 1);
        let full = report(&state, "a1", &here);
        assert!(full.contains("steps: Read · tools/edit.py → Edit · tools/edit.py"));
        assert!(full.contains("thread t1"));
        assert!(report(&state, "a1", &there).starts_with("In #web"));
        let alone = ("c2".to_owned(), "a2".to_owned(), String::new());
        assert_eq!(
            report(&state, "a2", &alone),
            "Nothing else of yours is running: this is your only turn."
        );
    }
}
