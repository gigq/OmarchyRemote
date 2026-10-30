//! Corral across hosts. Each host runs Corral with agents of its own, which work on that
//! machine. The person's Corral lists the other hosts in `hosts.json` (a name, the address of its
//! Corral, and its key from `corral key` there) and their agents join it: they show under their
//! host, and a direct message or a mention wakes them as usual. Their turn runs on their host,
//! which is sent what is new in the conversation and streams back what the agent is doing and
//! its reply; the reply is posted here, where mentions in it wake whoever it calls on. During the
//! turn the agent's `corral` command works this Corral, through the turn's token.
//!
//! Hosts are reached with curl, as the proxy's models are, with the key on curl's input.
use super::*;

/// Another host whose agents join this Corral, as `hosts.json` lists it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Host {
    pub name: String,
    /// Its Corral, such as `http://100.64.0.2:4190`.
    pub url: String,
    /// Its key, which `corral key` there prints.
    pub key: String,
    #[serde(skip)]
    online: bool,
    #[serde(skip)]
    error: String,
    #[serde(skip)]
    engines: Vec<Value>,
}
/// How often the other hosts' agents are asked for.
const POLL: Duration = Duration::from_secs(20);
/// A host's agent here: its id there, then `@host`.
pub(crate) fn remote_id(id: &str, host: &str) -> String {
    format!("{id}@{host}")
}
/// The id an agent has on its own host.
fn local_id(id: &str) -> &str {
    id.rsplit_once('@').map_or(id, |(id, _)| id)
}
/// A string for curl's config, quoted, with its escapes.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}
/// curl, set up to ask `host` for `path`, and its config, which carries the key and any body
/// on its input.
fn curl(
    host: &Host,
    path: &str,
    body: Option<&Value>,
    stream: bool,
) -> anyhow::Result<(Command, String)> {
    let mut config = vec![
        format!(
            "url = {}",
            quoted(&format!("{}{path}", host.url.trim_end_matches('/')))
        ),
        format!(
            "header = {}",
            quoted(&format!("Authorization: Bearer {}", host.key))
        ),
        "silent".into(),
        "show-error".into(),
        "connect-timeout = 8".into(),
    ];
    if let Some(body) = body {
        config.push("header = \"Content-Type: application/json\"".into());
        config.push(format!("data-binary = {}", quoted(&body.to_string())));
    }
    if stream {
        config.push("no-buffer".into());
    } else {
        config.push("max-time = 60".into());
        config.push("write-out = \"\\n%{http_code}\"".into());
    }
    let mut command = Command::new(program("curl")?);
    command
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    Ok((command, config.join("\n")))
}
/// Starts curl with its config on its input.
async fn spawn((mut command, config): (Command, String)) -> anyhow::Result<tokio::process::Child> {
    let mut child = command.spawn()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow::anyhow!("no input"))?;
    stdin.write_all(config.as_bytes()).await?;
    drop(stdin);
    Ok(child)
}
/// Asks a host for `path` and gives back its answer's bytes, or why not.
async fn ask(host: &Host, path: &str, body: Option<&Value>) -> anyhow::Result<Vec<u8>> {
    let output = spawn(curl(host, path, body, false)?)
        .await?
        .wait_with_output()
        .await?;
    if !output.status.success() {
        anyhow::bail!(
            "{} is not reachable ({})",
            host.name,
            clip(String::from_utf8_lossy(&output.stderr).trim(), 120)
        );
    }
    let out = output.stdout;
    let at = out.iter().rposition(|b| *b == b'\n').unwrap_or(0);
    let code: u16 = String::from_utf8_lossy(&out[at..])
        .trim()
        .parse()
        .unwrap_or(0);
    let body = out[..at].to_vec();
    if !(200..300).contains(&code) {
        let said: Value = serde_json::from_slice(&body).unwrap_or_default();
        anyhow::bail!(
            "{}",
            said["error"]
                .as_str()
                .map_or_else(|| format!("{} answered {code}", host.name), str::to_owned)
        );
    }
    Ok(body)
}
/// For another machine's running farm jobs that do not say how far along they are (its Corral may
/// be older than that), how far along each is from the end of its log, which the farm gives.
async fn farm_progress(host: &Host, queue: &mut Value) {
    let Some(jobs) = queue["jobs"].as_array_mut() else {
        return;
    };
    for job in jobs
        .iter_mut()
        .filter(|j| j["running"] == true && j["progress"].is_null())
    {
        // A farm job runs in a folder named for it, in `corral-farm`.
        let cwd = job["cwd"].as_str().unwrap_or_default();
        let mut parts = cwd.rsplit(['/', '\\']);
        let (Some(id), Some("corral-farm")) = (parts.next(), parts.next()) else {
            continue;
        };
        if id.len() != 32 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let Ok(status) = ask_json(host, &format!("/api/corral/farm/jobs/{id}"), None).await else {
            continue;
        };
        let tail = status["log"].as_str().unwrap_or_default().to_owned();
        let log = crate::progress::Log {
            head: tail.clone(),
            tail,
        };
        let elapsed = crate::queue::seconds_since(job["started"].as_str().unwrap_or_default());
        if let Some(p) =
            crate::progress::estimate(job["command"].as_str().unwrap_or_default(), &log, elapsed)
        {
            job["progress"] = json!(p);
        }
    }
}
async fn ask_json(host: &Host, path: &str, body: Option<&Value>) -> anyhow::Result<Value> {
    Ok(serde_json::from_slice(&ask(host, path, body).await?)?)
}
/// A picture's type, from its first bytes.
fn picture_type(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xff, 0xd8, ..] => "image/jpeg",
        [b'G', b'I', b'F', ..] => "image/gif",
        [
            b'R',
            b'I',
            b'F',
            b'F',
            _,
            _,
            _,
            _,
            b'W',
            b'E',
            b'B',
            b'P',
            ..,
        ] => "image/webp",
        _ => "image/svg+xml",
    }
}

impl Corral {
    /// Brings in the other hosts' agents: as last seen at once, then from each host now and every
    /// little while, as `hosts.json` lists them then.
    pub(crate) fn connect(&self) {
        let listed: Vec<Host> = read_json(&self.root.join("hosts.json")).unwrap_or_default();
        for host in &listed {
            if let Some(seen) =
                read_json::<Value>(&self.root.join("hosts").join(format!("{}.json", host.name)))
            {
                self.merge(&host.name, &seen);
            }
        }
        *self.hosts.lock().unwrap() = listed;
        let corral = self.clone();
        tokio::spawn(async move {
            loop {
                corral.refresh_hosts().await;
                tokio::time::sleep(POLL).await;
            }
        });
    }
    /// Asks each host for its agents, and drops those of hosts no longer listed.
    pub(crate) async fn refresh_hosts(&self) {
        let mut listed: Vec<Host> = read_json(&self.root.join("hosts.json")).unwrap_or_default();
        listed.retain(|h| valid_name(&h.name) && !h.url.is_empty());
        let mut changed = false;
        for host in &mut listed {
            match ask_json(host, "/api/corral/host", None).await {
                Ok(seen) => {
                    let cache = self.root.join("hosts");
                    let _ = fs::create_dir_all(&cache);
                    let _ = write_json(&cache.join(format!("{}.json", host.name)), &seen);
                    host.online = true;
                    host.engines = seen["engines"].as_array().cloned().unwrap_or_default();
                    changed |= self.merge(&host.name, &seen);
                }
                Err(e) => host.error = e.to_string(),
            }
        }
        {
            let mut state = self.state.lock().unwrap();
            let before = state.agents.len();
            state
                .agents
                .retain(|_, a| a.host.is_empty() || listed.iter().any(|h| h.name == a.host));
            changed |= state.agents.len() != before;
        }
        let was: Vec<(String, bool)> = self
            .hosts
            .lock()
            .unwrap()
            .iter()
            .map(|h| (h.name.clone(), h.online))
            .collect();
        changed |= was
            != listed
                .iter()
                .map(|h| (h.name.clone(), h.online))
                .collect::<Vec<_>>();
        *self.hosts.lock().unwrap() = listed;
        if changed {
            self.emit(json!({"type":"agents"}));
        }
    }
    async fn refresh_host(&self, name: &str) {
        let host = self
            .hosts
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.name == name)
            .cloned();
        if let Some(host) = host
            && let Ok(seen) = ask_json(&host, "/api/corral/host", None).await
        {
            self.merge(name, &seen);
            self.emit(json!({"type":"agents"}));
        }
    }
    /// A host's agents as it listed them, under ids of their own here. One whose name another
    /// agent here has is shown as `name-host`. Returns whether anything changed.
    pub(crate) fn merge(&self, host: &str, seen: &Value) -> bool {
        let mut state = self.state.lock().unwrap();
        let taken: Vec<String> = state
            .agents
            .values()
            .filter(|a| a.host != host)
            .map(|a| a.name.to_ascii_lowercase())
            .collect();
        let mut agents: Vec<Agent> = Vec::new();
        for value in seen["agents"].as_array().into_iter().flatten() {
            let Ok(mut agent) = serde_json::from_value::<Agent>(value.clone()) else {
                continue;
            };
            if !valid_name(&agent.name) {
                continue;
            }
            if taken.contains(&agent.name.to_ascii_lowercase()) {
                agent.name = format!("{}-{host}", agent.name);
            }
            agent.id = remote_id(&agent.id, host);
            agent.host = host.to_owned();
            if let Some(changed) = value["avatar"].as_u64() {
                state.pictures.insert(agent.id.clone(), changed);
            } else {
                state.pictures.remove(&agent.id);
            }
            agents.push(agent);
        }
        let mut before: Vec<Agent> = state
            .agents
            .values()
            .filter(|a| a.host == host)
            .cloned()
            .collect();
        before.sort_by(|a, b| a.id.cmp(&b.id));
        agents.sort_by(|a, b| a.id.cmp(&b.id));
        if before == agents {
            return false;
        }
        state.agents.retain(|_, a| a.host != host);
        for agent in agents {
            state.agents.insert(agent.id.clone(), agent);
        }
        true
    }
    fn host(&self, name: &str) -> Result<Host, String> {
        self.hosts
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.name == name)
            .cloned()
            .ok_or_else(|| format!("{name} is not in hosts.json"))
    }
    /// The render queues of the hosts whose agents are here, asked of each now.
    pub(crate) async fn host_queues(&self) -> Vec<Value> {
        let hosts = self.hosts.lock().unwrap().clone();
        let mut out = Vec::new();
        for host in hosts {
            out.push(
                match ask_json(&host, "/api/corral/renders/here", None).await {
                    Ok(mut queue) => {
                        farm_progress(&host, &mut queue).await;
                        json!({"name": host.name, "online": true, "queue": queue})
                    }
                    Err(e) => json!({"name": host.name, "online": false, "error": e.to_string()}),
                },
            );
        }
        out
    }
    /// Another host's engines, as it last listed them.
    pub(crate) fn host_engines(&self, name: &str) -> Vec<Value> {
        self.hosts
            .lock()
            .unwrap()
            .iter()
            .find(|h| h.name == name)
            .map(|h| h.engines.clone())
            .unwrap_or_default()
    }
    /// " on winbox" for an agent of another host, so agents know where each works.
    pub(crate) fn on_machine(&self, agent: &Agent) -> String {
        format!(
            " on {}",
            if agent.host.is_empty() {
                &self.name
            } else {
                &agent.host
            }
        )
    }
    /// The hosts and whether each answered, for the app.
    pub(crate) fn host_summary(&self) -> Vec<Value> {
        self.hosts
            .lock()
            .unwrap()
            .iter()
            .map(|h| json!({"name":h.name,"online":h.online,"error":h.error,"engines":h.engines}))
            .collect()
    }
    /// A turn for an agent on another host: it runs there, given what is new here, and its
    /// `corral` command works this Corral with the turn's token. Returns as `run` does.
    pub(crate) async fn remote(
        &self,
        (conversation, thread): (&str, &str),
        agent: &Agent,
        (body, ask): (String, String),
        token: &str,
        status: impl Fn(Step),
    ) -> Result<(String, String, String), String> {
        let host = self.host(&agent.host)?;
        let visit = json!({
            "home": self.name,
            "conversation": conversation,
            "thread": thread,
            "agent": local_id(&agent.id),
            "name": agent.name,
            "person": person(),
            "context": body,
            "ask": ask,
            "api": self.public.clone().unwrap_or_default(),
            "token": token,
        });
        let mut child = spawn(
            curl(&host, "/api/corral/host/turn", Some(&visit), true).map_err(|e| e.to_string())?,
        )
        .await
        .map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("no output")?;
        let mut lines = BufReader::new(stdout).lines();
        let mut reply = None;
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if event.get("status").is_some() || event.get("files").is_some() {
                status(Step {
                    status: event["status"].as_str().map(str::to_owned),
                    files: event["files"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|f| f.as_str().map(str::to_owned))
                        .collect(),
                });
            } else if let Some(text) = event["reply"].as_str() {
                reply = Some(text.to_owned());
            } else if let Some(error) = event["error"].as_str() {
                return Err(error.to_owned());
            }
        }
        let exit = child.wait().await.map_err(|e| e.to_string())?;
        match reply {
            Some(reply) => Ok((String::new(), reply, String::new())),
            None if exit.success() => Err(format!("{} ended the turn without a reply", host.name)),
            None => Err(format!("{} is not reachable", host.name)),
        }
    }
    /// An agent's picture from its host.
    pub(crate) async fn remote_picture(&self, agent: &Agent) -> Result<Response, ApiError> {
        let host = self.host(&agent.host).map_err(error)?;
        let path = format!("/api/corral/agents/{}/avatar", local_id(&agent.id));
        let bytes = ask(&host, &path, None).await.map_err(|_| not_found())?;
        Ok((
            [
                (axum::http::header::CONTENT_TYPE, picture_type(&bytes)),
                (axum::http::header::CACHE_CONTROL, "private, max-age=86400"),
            ],
            bytes,
        )
            .into_response())
    }
    /// Makes, changes, or deletes an agent on its host: `path` under its `/api/corral`.
    pub(crate) async fn on_host(
        &self,
        host: &str,
        path: &str,
        body: &Value,
    ) -> Result<Value, ApiError> {
        let found = self
            .host(host)
            .map_err(|e| refuse(StatusCode::BAD_REQUEST, &e))?;
        let answer = ask_json(&found, &format!("/api/corral{path}"), Some(body))
            .await
            .map_err(|e| refuse(StatusCode::BAD_REQUEST, &e.to_string()))?;
        self.refresh_host(host).await;
        Ok(answer)
    }
    /// A new agent on another host, as it is known here.
    pub(crate) async fn create_remote(&self, form: &AgentForm) -> Result<Agent, ApiError> {
        let name = form.name.trim().trim_start_matches('@');
        if let Some(other) = self
            .state
            .lock()
            .unwrap()
            .agents
            .values()
            .find(|a| a.name.eq_ignore_ascii_case(name))
        {
            return Err(refuse(
                StatusCode::CONFLICT,
                &format!("@{} already has that name; names ignore case", other.name),
            ));
        }
        let made = self.on_host(&form.host, "/agents", &json!(form)).await?;
        let id = remote_id(made["id"].as_str().unwrap_or_default(), &form.host);
        self.state
            .lock()
            .unwrap()
            .agents
            .get(&id)
            .cloned()
            .ok_or_else(|| error(format!("{} made the agent but does not list it", form.host)))
    }
}

// ---- What a host offers the Corral whose agents it runs: its agents, and their turns ----

impl Corral {
    /// Forgets a deleted agent's sessions in other hosts' conversations.
    pub(crate) fn forget_visits(&self, agent: &str) {
        let visits = self.root.join("visits.json");
        let _state = self.state.lock().unwrap();
        let Some(mut all) = read_json::<HashMap<String, Seat>>(&visits) else {
            return;
        };
        all.retain(|key, _| !key.ends_with(&format!(" {agent}")));
        let _ = write_json(&visits, &all);
    }
}

/// This host's agents and engines, for another host's Corral.
pub async fn host_listing(State(corral): State<Corral>) -> Json<Value> {
    let engines = corral.engines().await;
    let state = corral.state.lock().unwrap();
    let agents: Vec<Value> = state
        .agents
        .values()
        .filter(|a| a.host.is_empty())
        .map(|a| {
            let mut value = json!(a);
            value["avatar"] = json!(
                avatar(&corral.root.join("agents").join(&a.id)).map(|(_, _, changed)| changed)
            );
            value
        })
        .collect();
    Json(json!({
        "name": corral.name,
        "os": std::env::consts::OS,
        "engines": engines,
        "agents": agents,
    }))
}
/// A turn in another host's conversation, as that host sends it.
#[derive(Deserialize)]
pub struct Visit {
    /// The host whose conversation it is, the conversation, and the thread, if in one.
    home: String,
    conversation: String,
    #[serde(default)]
    thread: String,
    agent: String,
    /// The agent's name there.
    #[serde(default)]
    name: String,
    #[serde(default)]
    person: String,
    /// The <corral> block up to the agent's memory, and the request it ends with.
    context: String,
    ask: String,
    /// The agent API there, and the turn's token for it.
    #[serde(default)]
    api: String,
    #[serde(default)]
    token: String,
}
/// The session an agent of this host keeps for a conversation on another host, by host,
/// conversation, thread, and agent, in `visits.json`.
fn visit_key(visit: &Visit, agent: &str) -> String {
    format!(
        "{} {} {} {agent}",
        visit.home, visit.conversation, visit.thread
    )
}
/// Runs an agent of this host for another host's conversation, and streams back what it is
/// doing (`{"status"}`), then its reply (`{"reply"}`) or why it has none (`{"error"}`), a line
/// each. If the other host hangs up, as Stop does, the turn ends.
pub async fn host_turn(
    State(corral): State<Corral>,
    Json(visit): Json<Visit>,
) -> Result<Response, ApiError> {
    let agent = corral
        .state
        .lock()
        .unwrap()
        .agents
        .get(&visit.agent)
        .filter(|a| a.host.is_empty())
        .cloned()
        .ok_or_else(not_found)?;
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let key = visit_key(&visit, &agent.id);
        let visits = corral.root.join("visits.json");
        let seat = read_json::<HashMap<String, Seat>>(&visits)
            .unwrap_or_default()
            .remove(&key)
            .unwrap_or_default();
        let memory =
            fs::read_to_string(corral.root.join("agents").join(&agent.id).join("memory.md"))
                .unwrap_or_default();
        let prompt = finish(&visit.context, &memory, &visit.ask);
        let mut shown = agent.clone();
        if valid_name(&visit.name) {
            shown.name = visit.name.clone();
        }
        let person = if visit.person.trim().is_empty() {
            person()
        } else {
            visit.person.clone()
        };
        let api = if visit.api.is_empty() {
            corral.api.clone()
        } else {
            visit.api.clone()
        };
        let job = Job {
            place: (
                format!("{}:{}", visit.home, visit.conversation),
                agent.id.clone(),
                visit.thread.clone(),
            ),
            agent: &shown,
            seat: &seat,
            fork: None,
            prompt: &prompt,
            brief: brief(
                &shown,
                &person,
                &corral.root,
                &corral.name,
                Some(&visit.home),
            ),
            api: &api,
            token: &visit.token,
        };
        let status = tx.clone();
        let run = corral.run(job, move |step: Step| {
            let _ = status.send(json!({"status": step.status, "files": step.files}));
        });
        tokio::select! {
            outcome = run => match outcome {
                Ok((session, reply, _)) => {
                    {
                        let _state = corral.state.lock().unwrap();
                        let mut all: HashMap<String, Seat> = read_json(&visits).unwrap_or_default();
                        all.insert(key, Seat {
                            session,
                            engine: family(&agent.engine).into(),
                            ..Seat::default()
                        });
                        if let Err(e) = write_json(&visits, &all) {
                            eprintln!("corral: could not save visits: {e}");
                        }
                    }
                    let _ = tx.send(json!({"reply": reply}));
                }
                Err(e) => {
                    let _ = tx.send(json!({"error": e}));
                }
            },
            // The engine stops with the dropped turn.
            _ = tx.closed() => {}
        }
    });
    let lines = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv()
            .await
            .map(|v| (Ok::<_, std::io::Error>(format!("{v}\n")), rx))
    });
    Ok((
        [(axum::http::header::CONTENT_TYPE, "application/x-ndjson")],
        axum::body::Body::from_stream(lines),
    )
        .into_response())
}
