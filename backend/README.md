# Omarchy host backend

One Rust service connects the mobile shell to apps on the host. `apps.rs` is the table of host apps: the terminal programs the phone can open in their own PTY (`TUIS`) and the route-backed apps (`SERVICES`), plus the host name, home, and data directory. `terminal.rs` owns real PTYs; `herdr.rs` adapts the existing Herdr Unix socket; `files.rs`, `files_ops.rs`, `uploads.rs`, `browser.rs`, and `widgets.rs` serve the other apps. `main.rs` provides shared HTTP/WebSocket transport, origin checks, payload limits, capability discovery, and route registration. New app adapters belong alongside these modules under `/api/<app>/…`, and advertise their capabilities at `/api/capabilities`; see `../CONTRIBUTING.md`.

The HTML development server on loopback 4187 forwards `/api/` HTTP and WebSocket traffic to this service on loopback 4188. Both stay behind whatever private HTTPS address you publish (Tailscale Serve, for example). The Node process handles static files and live reload only; PTYs, Herdr access, and app APIs live in Rust. A future production static frontend can use the same API contract.

## Files API

- `GET /api/files?path=&hidden=false`: list a home-relative or absolute directory inside HOME, directories first. Returns root, canonical path, parent and entries.
- `GET /api/files/content?path=…`: regular-file bytes, up to 25 MiB; attachment/octet-stream, no-store, nosniff. The client renders text literally or uses an image blob.
- `POST /api/files/upload?path=…&name=…`: raw file bytes, up to 25 MiB, creates a private file without replacing existing names. Shares the upload writer with Herdr image attachments.
- `POST /api/files/folders` with `{ "path": "…", "name": "…" }`: creates a mode-0700 folder.

- `GET /api/files/search?path=…&query=…&mode=names|contents|everywhere|fuzzy&hidden=false&regex=false&sensitive=false&glob=…`: bounded results with optional content line hits, timing and truncation state. Names searches the current directory; contents recurses; everywhere/fuzzy use HOME. Skips build/cache/VCS trees; limits 50,000 entries, 3 seconds, 32 MiB scanned text and 100 hits.
- `GET /api/files/text?path=…`: UTF-8 text up to 1 MiB, SHA-256 version, permissions, owner UID and modification time.
- `POST /api/files/text` with `{ "path": "…", "text": "…", "version": "…" }`: checks the original version and atomically replaces the file, preserving permission bits. Rejects conflicting external edits.
- `POST /api/files/operate` with `{ "action": "copy|move|rename|trash", "paths": ["…"], "destination": "…", "name": "…" }`: up to 100 selections. Destination is used for copy/move; name for single-item rename. Returns completed paths and per-item errors. Never replaces destinations. Copy stages privately, then publishes atomically. Trash uses `gio trash` and remains recoverable on the host.
- `POST /api/files/archive` with `{ "paths": ["…"] }`: ZIP attachment with HOME-relative paths, capped at 25 MiB. Copy/archive reject symlinks and special files, and cap trees at 10,000 entries.

Paths are canonicalized and confined to HOME; external symlinks and the proxy-secret file (including aliases) are excluded. Upload names cannot contain path separators. Selection actions cannot operate on HOME or ancestors of the proxy secret. Writes are serialized within the backend; destination moves/renames use Linux no-replace semantics.

## App API v1

- `POST /api/uploads/files?name=<client file name>`: raw bytes of any type (maximum 100 MiB), returning `{ "path": "/absolute/host/path", "kind": "image" | "file" }`. `kind` is `image` when the bytes carry a PNG/JPEG/GIF/WebP/HEIC/HEIF signature. The name is reduced to one safe path component (last segment, unsafe characters replaced, at most 80 characters) and stored as `<uuid>-<name>`; unnamed uploads become `image-<uuid>.<ext>` or `file-<uuid>`. Files are unique mode-0600 entries under `$HOME/.local/share/omarchy-remote/uploads` (mode 0700), never served back, and persist until removed on the host. `POST /api/uploads/images` is the same handler for older shells.
- `GET /api/capabilities`: `{ version, host, home, apps }`, where `host` is the display name, `home` the backend user's home directory (the shell shortens paths with it), and `apps` the route-backed and PTY apps with their feature tags.
- `POST /api/terminal/session` with `{ "id": "optional previous ID", "app": "terminal" }`: create or resume a shell. Optional `cwd` selects a HOME-confined directory for a new Terminal shell. Any other `app` must be an id from `TUIS` in `apps.rs` (`btop`, `services`, `lazydocker`, `dua`, `lnav`); the program is resolved on `PATH`, `~/.cargo/bin`, `~/.local/bin`, `/usr/local/bin`, and `/usr/bin`, and a missing program returns `<program> is not installed on this host`. Unknown app values and cross-app resume IDs are rejected. Missing/expired IDs create a new session; the returned ID must replace the saved one.
- `WS /api/terminal/{id}/ws`: receive `screen` (UTF-8 bytes plus dimensions), `output` (bytes), `exit`, and `error`; send `input` (`data` string) or `resize` (`cols`, `rows`). A screen snapshot restores the terminal after reconnection. PTYs remain alive across app closure and live reload, until shell exit or backend restart. Up to eight shells may be open. Reconnection restores the current screen, not previous client scrollback.
- `GET /api/herdr/snapshot`: local Herdr workspaces, tabs, agents, and panes.
- `GET /api/herdr/panes/{id}`: most recent 300 lines, with ANSI formatting.
- `POST /api/herdr/workspaces` with `{ "cwd": "…" }`: starts an unfocused Herdr workspace whose shell opens in that folder, named after it. The folder must exist inside the home directory. Returns the new root `pane` and a fresh `snapshot`.
- `POST /api/herdr/workspaces/{id}/tabs` with `{ "cwd": "…" }`: adds an unfocused tab to that Herdr workspace, its shell in the folder (which must exist inside the home directory). Returns the new root `pane` and a fresh `snapshot`.
- `POST /api/herdr/panes/{id}/input` with `text` and/or `keys`: literal text and Herdr key names. Text and Return can be sent atomically in one Herdr request. With `"typed": true` the text and keys are typed (Herdr `send_text`/`send_keys`), as Keys mode needs for editors; otherwise the text is pasted, bracketed when the program asks for it.
- `WS /api/herdr/ws`: snapshots (checked every 1.2 seconds), selected pane output (read every 16 ms for a second after each keystroke and every ~100 ms otherwise, sent only when its text changes), heartbeat/error messages, and acknowledged input. Send `select` with `pane_id`, then `input` with `id`, `pane_id`, `text`, and `keys`. Input is rejected if its pane no longer matches the selected pane. Pending input is never replayed after reconnection; an interrupted acknowledgement is reported as uncertain.

Herdr uses its installed protocol-20 NDJSON socket API directly. Pane viewing/input does not focus or resize the desktop Herdr pane. Wide output remains horizontally scrollable. There are no fabricated agent approval buttons; use the actual pane's keyboard controls. This version attaches to existing agents/panes; agent creation and workspace management can be added through the same adapter later.

## Configuration and operation

`~/.config/omarchy-remote/backend.env` is a private mode-0600 environment file shared by the two user services. `OMARCHY_PROXY_TOKEN` (at least 32 characters) is required. It is sent from the local development proxy to Rust and never embedded in web assets or returned to clients. Only the local proxy knows it. Browser API requests require `X-Hyprland-Client: 1`; WebSockets require an allowed Origin. Cross-origin requests and unrecognized Host values are rejected. Whoever can reach the published HTTPS address can open a shell as the backend user, so the network (a tailnet, a VPN, a firewall) is the access control; this is a single-user application, not a public multi-user shell service.

Optional settings:

- `OMARCHY_API_PORT` defaults to 4188.
- `OMARCHY_ORIGINS` is a comma-separated list of full origins a browser may load the shell from; both services read it. Defaults to `http://127.0.0.1:4187,http://localhost:4187`, so the published HTTPS origin must be added here.
- `OMARCHY_HOST_NAME` is the name shown in the app's status lines and capabilities. Defaults to the kernel hostname.
- `OMARCHY_HERDR_SOCKET` defaults to `$HOME/.config/herdr/herdr.sock`.
- `CODEXBAR_BIN` defaults to `/usr/bin/codexbar`. Set it to a wrapper that accepts the same arguments and prints the same JSON to change what the CodexBar app reports, for example combined usage across several accounts.
- `SHELL` selects the terminal shell. The installed service uses `/bin/bash` with the user's login configuration and starts in their home directory. Agent-specific environment and the proxy secret are removed from child shells.

The optional TUI programs are `btop`, `systemctl-tui`, `lazydocker`, `dua`, and `lnav` (tested with lnav 0.14.1). Lnav starts `journalctl --no-pager -f -n 1000 -o short-iso` using its command capture. Lnav waits for a frontend `ready` message after screen restoration and sizing, so its startup capability queries reach the client. Child PTYs receive host-side cursor-query replies so startup does not depend on a connected browser; frontend DSR replies are suppressed to avoid duplicate input.

Install the Services dependency with `cargo install systemctl-tui --locked` (tested with 0.7.0) as the backend user. It runs without sudo and shows both system and user units; host permissions govern service actions.

Build with `cargo build --release --manifest-path backend/Cargo.toml`. Run through the enabled `omarchy-remote.service`. Restart that service after changing Rust; running PTYs end on restart. Restart `omarchy-remote-dev.service` after proxy/server changes. Web asset saves require neither restart.

Validation:

```
cargo test --manifest-path backend/Cargo.toml
cargo clippy --manifest-path backend/Cargo.toml --all-targets -- -D warnings
npm run test:backend
npm run test:ui
npm run build && npm test
```

Backend integration tests require the services and local Herdr. They create a dedicated temporary Herdr workspace with `focus:false`, send test commands only there, and remove it afterward. Browser tests type into a separate shell and read existing Herdr panes without sending input to agents.

Sources: [xterm.js API](https://xtermjs.org/docs/api/terminal/classes/terminal/), [portable-pty API](https://docs.rs/portable-pty/latest/portable_pty/), and the installed `herdr api schema --json` contract.

## Browser adapters

`GET /api/browser/snapshot` returns connected adapter instances with windows,
workspaces and tabs. `POST /api/browser/action` accepts `instance_id`, `action`
(create/close/focus/reload/pin/mute/move), and the relevant live `tab_id`,
`window_id`, `url`, `value` or `index`. Workspace writes require the adapter's
`workspace_write` capability. Commands use per-connection IDs, expiry and explicit
acknowledgments. A timeout is ambiguous; refresh before retrying.

The Vivaldi extension uses native messaging through the same Rust binary
(`--browser-bridge`) and `$XDG_RUNTIME_DIR/omarchy-remote-browser.sock` (0600,
peer UID checked). `OMARCHY_BROWSER_SOCKET` supports isolated testing. No proxy
secret is passed to the browser. See `browser-extension/README.md` for installation,
profile configuration, Vivaldi workspace metadata and URL-only phone navigation.
