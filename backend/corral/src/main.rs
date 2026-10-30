//! The `corral` program. `corral serve` runs Corral on a host of its own, for any client with the
//! host's key: the person's Corral on another host, whose agents' turns it then runs here, or an
//! app. Inside an agent's turn the same program is the agent's `corral` command, which works
//! Corral through the turn's token.
use axum::{
    Router,
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, ExitCode, Stdio},
    sync::Arc,
    time::Duration,
};

const USAGE: &str = "corral: Corral, a Slack-style workspace for a person and their agents.

  corral serve [--listen ADDRESS:PORT] [--name NAME] [--public URL]
      Runs Corral here, in ~/Corral (or OMARCHY_CORRAL_DIR), on 127.0.0.1:4190 and on the
      address given, for clients with this host's key. NAME is how other hosts know it. Other
      hosts in its hosts.json run their agents' turns for it; with URL, where they reach it
      (such as http://100.64.0.1:4190), those agents' corral command works it too.
  corral key
      Prints this host's key, for the Corral that lists this host in its hosts.json.
  corral help
      Inside an agent's turn: what the agent's corral command does.";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("serve") => match serve(&args[1..]) {
            Ok(()) => ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("corral serve: {e}");
                ExitCode::FAILURE
            }
        },
        Some("key") => match key() {
            Ok(key) => {
                println!("{key}");
                ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("corral key: {e}");
                ExitCode::FAILURE
            }
        },
        _ if std::env::var_os("CORRAL_TOKEN").is_some() => agent_command(&args),
        _ => {
            println!("{USAGE}");
            ExitCode::SUCCESS
        }
    }
}

/// This host's key, made the first time it is asked for. Anyone with it can use this Corral.
fn key() -> anyhow::Result<String> {
    let root = corral::default_root()?;
    fs::create_dir_all(&root)?;
    let path = root.join("key");
    if let Ok(key) = fs::read_to_string(&path)
        && key.trim().len() >= 32
    {
        return Ok(key.trim().to_owned());
    }
    let key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let mut file = fs::File::create(&path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(key.as_bytes())?;
    Ok(key)
}

/// The machine's name, as other hosts and agents know it, when none is given.
fn machine() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| {
            let out = Command::new("hostname").arg("-s").output().ok()?;
            Some(String::from_utf8_lossy(&out.stdout).into_owned())
        })
        .map(|n| {
            n.trim()
                .split('.')
                .next()
                .unwrap_or_default()
                .to_lowercase()
        })
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "this-host".into())
}

fn option(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
        .or_else(|| {
            args.iter()
                .find_map(|a| a.strip_prefix(&format!("{name}=")).map(str::to_owned))
        })
}

/// Lets through the agent API, which checks its turn's token, and anyone with the key.
async fn authorize(State(key): State<Arc<String>>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if path == "/api/corral/agent" || path.starts_with("/api/corral/agent/") {
        return next.run(request).await;
    }
    let headers = request.headers();
    let given = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .or_else(|| headers.get("x-corral-key").and_then(|v| v.to_str().ok()))
        .unwrap_or_default();
    // Compared in full, so how long it takes says nothing about the key.
    let same = given.len() == key.len()
        && given
            .bytes()
            .zip(key.bytes())
            .fold(0u8, |d, (a, b)| d | (a ^ b))
            == 0;
    if same {
        next.run(request).await
    } else {
        StatusCode::UNAUTHORIZED.into_response()
    }
}

fn serve(args: &[String]) -> anyhow::Result<()> {
    let listen = option(args, "--listen");
    let name = option(args, "--name").unwrap_or_else(machine);
    let port = listen
        .as_deref()
        .and_then(|l| l.rsplit_once(':'))
        .map_or("4190", |(_, port)| port)
        .to_owned();
    let key = Arc::new(key()?);
    // The agent's `corral` command is this program, so its folder goes on each turn's path.
    let bin = std::env::current_exe()?
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Where is corral?"))?;
    let runtime = tokio::runtime::Runtime::new()?;
    runtime.block_on(async move {
        let corral = corral::start(corral::Setup {
            root: corral::default_root()?,
            bin,
            api: format!("http://127.0.0.1:{port}/api/corral/agent"),
            name: name.clone(),
            public: option(args, "--public")
                .map(|url| format!("{}/api/corral/agent", url.trim_end_matches('/'))),
        })?;
        let app = Router::new()
            .nest("/api/corral", corral::router(corral))
            .layer(middleware::from_fn_with_state(key, authorize));
        let local = format!("127.0.0.1:{port}");
        let mut addresses = vec![local.clone()];
        addresses.extend(listen.filter(|l| *l != local));
        let mut servers = Vec::new();
        for address in addresses {
            let app = app.clone();
            servers.push(tokio::spawn(async move {
                // The private network can come up after Corral does.
                let listener = loop {
                    match tokio::net::TcpListener::bind(&address).await {
                        Ok(listener) => break listener,
                        Err(e) => {
                            eprintln!("corral: cannot listen on {address} yet: {e}");
                            tokio::time::sleep(Duration::from_secs(5)).await;
                        }
                    }
                };
                eprintln!("corral: listening on {address}");
                axum::serve(listener, app).await
            }));
        }
        eprintln!("corral: serving as {name}");
        for server in servers {
            server.await??;
        }
        Ok(())
    })
}

/// A string for curl's config, quoted, with its escapes.
fn quoted(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Runs curl with these config lines, and gives back what came back, or why not.
fn curl_send(lines: &[String], seconds: u32) -> Result<String, String> {
    let mut config = lines.to_vec();
    config.extend([
        "silent".into(),
        "show-error".into(),
        format!("max-time = {seconds}"),
        "write-out = \"\\n%{http_code}\"".into(),
    ]);
    let output = Command::new("curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .and_then(|mut child| {
            child
                .stdin
                .take()
                .expect("piped")
                .write_all(config.join("\n").as_bytes())?;
            child.wait_with_output()
        })
        .map_err(|e| format!("curl could not run ({e})"))?;
    if !output.status.success() {
        return Err(format!(
            "Corral is not reachable ({})",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let out = String::from_utf8_lossy(&output.stdout);
    let (text, code) = out.rsplit_once('\n').unwrap_or(("", &out));
    if code.trim().starts_with('2') {
        return Ok(text.to_owned());
    }
    Err(serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| text.trim().to_owned()))
}
/// The agent's `corral` command: `--key value` pairs, and any other words as the message text,
/// sent to Corral with the turn's token.
fn agent_command(args: &[String]) -> ExitCode {
    let (Ok(api), Ok(token)) = (std::env::var("CORRAL_API"), std::env::var("CORRAL_TOKEN")) else {
        eprintln!("corral: run this from a Corral agent's turn");
        return ExitCode::FAILURE;
    };
    let action = args.first().map_or("help", String::as_str);
    let mut body = serde_json::Map::new();
    let mut words = Vec::new();
    let rest = args.get(1..).unwrap_or_default();
    let mut i = 0;
    while i < rest.len() {
        let arg = &rest[i];
        if let Some(key) = arg.strip_prefix("--").filter(|k| !k.is_empty()) {
            let (key, value) = match key.split_once('=') {
                Some((k, v)) => (k.to_owned(), v.to_owned()),
                None if rest.get(i + 1).is_some_and(|n| !n.starts_with("--")) => {
                    i += 1;
                    (key.to_owned(), rest[i].clone())
                }
                None => (key.to_owned(), "true".into()),
            };
            body.insert(key.replace('-', "_"), value.into());
        } else {
            words.push(arg.clone());
        }
        i += 1;
    }
    if action == "attach" {
        // Each file goes first, as it is; the message then names them.
        let mut names = Vec::new();
        for path in &words {
            let name = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            // The name goes in the query, the file as the body.
            let encoded: String = name
                .bytes()
                .map(|b| {
                    if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                        (b as char).to_string()
                    } else {
                        format!("%{b:02X}")
                    }
                })
                .collect();
            match curl_send(
                &[
                    format!("url = {}", quoted(&format!("{api}/file?name={encoded}"))),
                    format!("header = {}", quoted(&format!("X-Corral-Token: {token}"))),
                    "header = \"Content-Type: application/octet-stream\"".into(),
                    format!("data-binary = {}", quoted(&format!("@{path}"))),
                ],
                600,
            ) {
                Ok(name) => names.push(serde_json::Value::from(name.trim())),
                Err(e) => {
                    eprintln!("corral attach: {path}: {e}");
                    return ExitCode::FAILURE;
                }
            }
        }
        body.insert("files".into(), names.into());
    } else if !words.is_empty() {
        body.insert("text".into(), words.join(" ").into());
    }
    let helping = matches!(action, "help" | "-h" | "--help");
    let mut config = vec![
        format!(
            "url = {}",
            quoted(&if helping {
                api.clone()
            } else {
                format!("{api}/{action}")
            })
        ),
        format!("header = {}", quoted(&format!("X-Corral-Token: {token}"))),
        "silent".into(),
        "show-error".into(),
        "max-time = 120".into(),
        "write-out = \"\\n%{http_code}\"".into(),
    ];
    if !helping {
        config.push("header = \"Content-Type: application/json\"".into());
        config.push(format!(
            "data-binary = {}",
            quoted(&serde_json::Value::Object(body).to_string())
        ));
    }
    let child = Command::new("curl")
        .args(["--config", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let output = child.and_then(|mut child| {
        child
            .stdin
            .take()
            .expect("piped")
            .write_all(config.join("\n").as_bytes())?;
        child.wait_with_output()
    });
    let output = match output {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            eprintln!(
                "corral: Corral is not reachable ({})",
                String::from_utf8_lossy(&output.stderr).trim()
            );
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("corral: curl could not run ({e})");
            return ExitCode::FAILURE;
        }
    };
    let out = String::from_utf8_lossy(&output.stdout);
    let (text, code) = out.rsplit_once('\n').unwrap_or(("", &out));
    if code.trim().starts_with('2') {
        println!("{}", text.trim_end());
        return ExitCode::SUCCESS;
    }
    let said = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v["error"].as_str().map(str::to_owned))
        .unwrap_or_else(|| text.trim().to_owned());
    eprintln!("corral {action}: {said}");
    ExitCode::FAILURE
}
