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
    pub output: Mutex<Output>,
    pub events: broadcast::Sender<(u64, Vec<u8>)>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    pub touched: Mutex<Instant>,
}
pub type Sessions = Arc<Mutex<HashMap<String, Arc<Terminal>>>>;
impl Terminal {
    pub fn spawn() -> Result<Arc<Self>> {
        Self::spawn_shell(&std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into()))
    }
    fn spawn_shell(shell: &str) -> Result<Arc<Self>> {
        let pair = native_pty_system().openpty(PtySize {
            rows: 32,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        let mut cmd = CommandBuilder::new(shell);
        cmd.arg("-l");
        cmd.cwd(std::env::var("HOME")?);
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
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let Some(t) = weak.upgrade() else { break };
                let mut out = t.output.lock().unwrap();
                out.parser.process(&buf[..n]);
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
    pub fn input(&self, bytes: &[u8]) -> Result<()> {
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
        self.master.lock().unwrap().resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.output.lock().unwrap().parser.set_size(rows, cols);
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
