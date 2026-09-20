//! The host apps this backend serves. `TUIS` lists every terminal program the phone can open in
//! its own PTY session; add a program here and a matching catalog entry in `public/apps.js`.
//! Programs are looked up on PATH plus `~/.cargo/bin` and `~/.local/bin`; `{data}` in an
//! argument expands to the backend's data directory (`~/.local/share/omarchy-remote`).
use anyhow::{Result, bail};
use portable_pty::CommandBuilder;
use serde_json::{Value, json};
use std::path::PathBuf;

pub struct HostApp {
    pub id: &'static str,
    pub name: &'static str,
    pub features: &'static [&'static str],
    pub program: &'static str,
    pub args: &'static [&'static str],
    pub env: &'static [(&'static str, &'static str)],
    /// Start the program only once a client has attached and restored the screen. Notcurses
    /// apps such as lnav query terminal capabilities at startup and need those replies.
    pub wait_for_client: bool,
}

pub const TERMINAL: &str = "terminal";

pub const TUIS: &[HostApp] = &[
    HostApp {
        id: "btop",
        name: "btop",
        features: &["monitor", "reconnect"],
        program: "btop",
        args: &["--config", "{data}/btop.conf", "--force-utf"],
        env: &[],
        wait_for_client: false,
    },
    HostApp {
        id: "services",
        name: "Services",
        features: &["systemd", "reconnect"],
        program: "systemctl-tui",
        args: &["--no-log"],
        env: &[],
        wait_for_client: false,
    },
    HostApp {
        id: "lazydocker",
        name: "Lazydocker",
        features: &["docker", "reconnect"],
        program: "lazydocker",
        args: &[],
        env: &[],
        wait_for_client: false,
    },
    HostApp {
        id: "dua",
        name: "dua",
        features: &["disk-usage", "reconnect"],
        program: "dua",
        args: &["interactive", "--threads", "2", "--stay-on-filesystem"],
        env: &[],
        wait_for_client: false,
    },
    HostApp {
        id: "lnav",
        name: "lnav",
        features: &["logs", "reconnect"],
        program: "lnav",
        args: &[
            "-N",
            "-e",
            "journalctl --no-pager -f -n 1000 -o short-iso",
            "-c",
            ";UPDATE lnav_views SET options=json_set(options, '$.word-wrap', 'normal') WHERE name IN ('log','text')",
        ],
        env: &[("TERMINFO", "/usr/share/terminfo")],
        wait_for_client: true,
    },
];

/// Apps served by dedicated routes rather than a PTY, listed for the capabilities endpoint.
const SERVICES: &[(&str, &str, &[&str])] = &[
    (
        "codexbar",
        "CodexBar",
        &["usage", "credits", "resets", "costs"],
    ),
    (
        "browser",
        "Browser",
        &[
            "tabs",
            "windows",
            "workspaces",
            "close",
            "move",
            "create",
            "pin",
            "mute",
        ],
    ),
    (
        "files",
        "Files",
        &[
            "browse",
            "preview",
            "upload",
            "mkdir",
            "search",
            "fuzzy",
            "selection",
            "archive",
            "move",
            "copy",
            "rename",
            "trash",
            "edit",
        ],
    ),
    (
        "herdr",
        "Herdr",
        &["workspaces", "agents", "panes", "input"],
    ),
];

pub fn tui(id: &str) -> Option<&'static HostApp> {
    TUIS.iter().find(|app| app.id == id)
}

pub fn is_session_app(id: &str) -> bool {
    id == TERMINAL || tui(id).is_some()
}

pub fn capabilities() -> Vec<Value> {
    let mut apps: Vec<Value> = SERVICES
        .iter()
        .map(|(id, name, features)| json!({"id":id,"name":name,"features":features}))
        .collect();
    apps.push(json!({"id":TERMINAL,"name":"Terminal","features":["pty","resize","reconnect"]}));
    apps.extend(
        TUIS.iter()
            .map(|app| json!({"id":app.id,"name":app.name,"features":app.features})),
    );
    apps
}

/// The name shown for this host in the shell: `OMARCHY_HOST_NAME`, else the kernel hostname.
pub fn host_name() -> String {
    std::env::var("OMARCHY_HOST_NAME")
        .ok()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string("/proc/sys/kernel/hostname")
                .ok()
                .map(|name| name.trim().to_owned())
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "host".into())
}

pub fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(std::env::var("HOME")?))
}

pub fn data_dir() -> Result<PathBuf> {
    let dir = home()?.join(".local/share/omarchy-remote");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn resolve_program(program: &str) -> Result<PathBuf> {
    let path = PathBuf::from(program);
    if path.is_absolute() {
        return Ok(path);
    }
    let home = home()?;
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    dirs.push(home.join(".cargo/bin"));
    dirs.push(home.join(".local/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/usr/bin"));
    for dir in dirs {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    bail!("{program} is not installed on this host")
}

/// Build the command for a host TUI. `wait_for_client` wraps the program in a shell that
/// waits for one line on stdin (sent by `Terminal::start`) before exec.
pub fn command(app: &HostApp) -> Result<CommandBuilder> {
    let program = resolve_program(app.program)?;
    let data = data_dir()?;
    let args = app
        .args
        .iter()
        .map(|arg| arg.replace("{data}", &data.to_string_lossy()));
    let mut cmd = if app.wait_for_client {
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args([
            "-c",
            "IFS= read -r omarchy_start || exit; exec \"$@\"",
            &format!("omarchy-{}", app.id),
        ]);
        cmd.arg(program);
        cmd
    } else {
        CommandBuilder::new(program)
    };
    cmd.args(args);
    for (key, value) in app.env {
        cmd.env(key, value);
    }
    Ok(cmd)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_tui_is_a_session_app_with_capabilities() {
        for app in TUIS {
            assert!(is_session_app(app.id));
            assert!(capabilities().iter().any(|c| c["id"] == app.id));
        }
        assert!(is_session_app(TERMINAL));
        assert!(!is_session_app("home"));
        assert!(!is_session_app("files"));
    }
    #[test]
    fn programs_resolve_on_path_or_fail_clearly() {
        assert!(resolve_program("/bin/sh").unwrap().is_absolute());
        assert!(resolve_program("sh").unwrap().ends_with("sh"));
        let missing = resolve_program("omarchy-no-such-program").unwrap_err();
        assert!(missing.to_string().contains("not installed"));
    }
}
