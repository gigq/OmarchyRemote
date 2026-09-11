use anyhow::{Result, bail};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    time::Instant,
};
use tokio::sync::broadcast;

pub struct Output {
    pub sequence: u64,
    pub parser: vt100::Parser,
    pub exited: bool,
}
pub struct Terminal {
    pub program: String,
    started: Mutex<bool>,
    pub output: Mutex<Output>,
    pub events: broadcast::Sender<(u64, Vec<u8>)>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    pub touched: Mutex<Instant>,
}
pub type Sessions = Arc<Mutex<HashMap<String, Arc<Terminal>>>>;
impl Terminal {
    pub fn spawn(program: &str, cwd: Option<std::path::PathBuf>) -> Result<Arc<Self>> {
        if program == "terminal" {
            let mut cmd =
                CommandBuilder::new(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()));
            cmd.arg("-l");
            return Self::spawn_command_at(cmd, program, cwd);
        }
        if program == "services" {
            let path =
                std::path::PathBuf::from(std::env::var("HOME")?).join(".cargo/bin/systemctl-tui");
            let mut cmd = CommandBuilder::new(path);
            cmd.arg("--no-log");
            return Self::spawn_command(cmd, program);
        }
        if program == "lazydocker" {
            return Self::spawn_command(CommandBuilder::new("/usr/bin/lazydocker"), program);
        }
        if program == "dua" {
            let mut cmd = CommandBuilder::new("/usr/bin/dua");
            cmd.args(["interactive", "--threads", "2", "--stay-on-filesystem"]);
            return Self::spawn_command(cmd, program);
        }
        if program == "lnav" {
            let path = std::path::PathBuf::from(std::env::var("HOME")?).join(".local/bin/lnav");
            // notcurses needs terminal capability replies during startup. Wait
            // for the phone to restore its screen and subscribe before exec.
            let mut cmd = CommandBuilder::new("/bin/sh");
            cmd.args([
                "-c",
                "IFS= read -r omarchy_start || exit; exec \"$@\"",
                "omarchy-lnav",
            ]);
            cmd.arg(path);
            cmd.env("TERMINFO", "/usr/share/terminfo");
            cmd.args([
                "-N",
                "-e",
                "journalctl --no-pager -f -n 1000 -o short-iso",
                "-c",
                ";UPDATE lnav_views SET options=json_set(options, '$.word-wrap', 'normal') WHERE name IN ('log','text')",
            ]);
            return Self::spawn_command(cmd, program);
        }
        if program != "btop" {
            bail!("Unknown host app")
        }
        let dir =
            std::path::PathBuf::from(std::env::var("HOME")?).join(".local/share/omarchy-remote");
        std::fs::create_dir_all(&dir)?;
        let mut cmd = CommandBuilder::new("/usr/bin/btop");
        cmd.arg("--config");
        cmd.arg(dir.join("btop.conf"));
        cmd.arg("--force-utf");
        Self::spawn_command(cmd, "btop")
    }
    #[cfg(test)]
    fn spawn_shell(shell: &str) -> Result<Arc<Self>> {
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        Self::spawn_command(cmd, "terminal")
    }
    fn spawn_command(cmd: CommandBuilder, program: &str) -> Result<Arc<Self>> {
        Self::spawn_command_at(cmd, program, None)
    }
    fn spawn_command_at(
        mut cmd: CommandBuilder,
        program: &str,
        cwd: Option<std::path::PathBuf>,
    ) -> Result<Arc<Self>> {
        let pair = native_pty_system().openpty(PtySize {
            rows: 32,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        cmd.cwd(cwd.unwrap_or(std::path::PathBuf::from(std::env::var("HOME")?)));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // This shell isn't a child pane of the agent that launched the service.
        for (key, _) in std::env::vars() {
            if key.starts_with("HERDR_")
                || key.starts_with("CODEX_")
                || key == "OMARCHY_PROXY_TOKEN"
            {
                cmd.env_remove(key);
            }
        }
        let mut child = pair.slave.spawn_command(cmd)?;
        let killer = child.clone_killer();
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (events, _) = broadcast::channel(512);
        let terminal = Arc::new(Self {
            program: program.to_owned(),
            started: Mutex::new(program != "lnav"),
            output: Mutex::new(Output {
                sequence: 0,
                parser: vt100::Parser::new(32, 80, 1000),
                exited: false,
            }),
            events,
            killer: Mutex::new(killer),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            touched: Mutex::new(Instant::now()),
        });
        let weak = Arc::downgrade(&terminal);
        std::thread::spawn(move || {
            let mut buf = [0; 8192];
            let mut aliases = crate::ansi::CursorAliases::default();
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let Some(t) = weak.upgrade() else { break };
                let mut out = t.output.lock().unwrap();
                let replies = aliases.process(&mut out.parser, &buf[..n]);
                if !replies.is_empty() {
                    let mut writer = t.writer.lock().unwrap();
                    let _ = writer.write_all(&replies);
                    let _ = writer.flush();
                }
                out.sequence += 1;
                let _ = t.events.send((out.sequence, buf[..n].to_vec()));
            }
            let _ = child.wait();
            if let Some(t) = weak.upgrade() {
                let mut out = t.output.lock().unwrap();
                out.exited = true;
                out.sequence += 1;
                let _ = t.events.send((out.sequence, Vec::new()));
            }
        });
        Ok(terminal)
    }
    pub fn start(&self) -> Result<()> {
        let mut started = self.started.lock().unwrap();
        if !*started {
            let mut writer = self.writer.lock().unwrap();
            writer.write_all(b"\n")?;
            writer.flush()?;
            *started = true;
        }
        Ok(())
    }
    pub fn input(&self, bytes: &[u8]) -> Result<()> {
        if !*self.started.lock().unwrap() {
            bail!("Terminal is not ready")
        }
        if bytes.len() > 16384 {
            bail!("Input too large")
        }
        if self.output.lock().unwrap().exited {
            bail!("Shell exited; open a new session")
        }
        *self.touched.lock().unwrap() = Instant::now();
        let mut writer = self.writer.lock().unwrap();
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }
    pub fn terminate(&self) -> Result<()> {
        if self.output.lock().unwrap().exited {
            return Ok(());
        }
        self.killer.lock().unwrap().kill()?;
        let mut out = self.output.lock().unwrap();
        out.exited = true;
        out.sequence += 1;
        let _ = self.events.send((out.sequence, Vec::new()));
        Ok(())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        let cols = cols.clamp(20, 300);
        let rows = rows.clamp(4, 150);
        // Hold the parser lock while resizing the PTY: its SIGWINCH can produce
        // output immediately, and that output must be parsed at the new size.
        let mut out = self.output.lock().unwrap();
        if out.parser.screen().size() == (rows, cols) {
            return Ok(());
        }
        self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        out.parser.set_size(rows, cols);
        Ok(())
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.killer.lock().unwrap().kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_pty_runs_shell_and_handles_resize_and_exit() {
        let terminal = Terminal::spawn_shell("/bin/sh").unwrap();
        terminal.resize(51, 18).unwrap();
        terminal
            .input(b"printf '\\nOMARCHY_PTY_OK\\n'; stty size\r")
            .unwrap();
        let until = Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let text = terminal.output.lock().unwrap().parser.screen().contents();
            if text.contains("OMARCHY_PTY_OK") && text.contains("18 51") {
                break;
            }
            assert!(Instant::now() < until, "PTY did not respond: {text}");
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        terminal.input(b"exit\r").unwrap();
    }
}
