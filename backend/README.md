# Omarchy host backend

One Rust service connects the mobile shell to apps on the host. `terminal.rs` owns real PTYs; `herdr.rs` adapts the existing Herdr Unix socket. `main.rs` provides shared HTTP/WebSocket transport, origin checks, payload limits, capability discovery, and route registration. New app adapters belong alongside these modules under `/api/<app>/…`, and advertise their capabilities at `/api/capabilities`.

The HTML development server on loopback 4187 forwards `/api/` HTTP and WebSocket traffic to this service on loopback 4188. Both remain behind the existing private Tailscale Serve address. The Node process handles static files and live reload only; PTYs, Herdr access, and app APIs live in Rust. A future production static frontend can use the same API contract.

## App API v1

- `GET /api/capabilities`: host and available app adapters.
- `POST /api/terminal/session` with `{ "id": "optional previous ID" }`: create or resume a shell. Missing/expired IDs create a new session; the returned ID must replace the saved one.
- `WS /api/terminal/{id}/ws`: receive `screen` (UTF-8 bytes plus dimensions), `output` (bytes), `exit`, and `error`; send `input` (`data` string) or `resize` (`cols`, `rows`). A screen snapshot restores the terminal after reconnection. PTYs remain alive across app closure and live reload, until shell exit or backend restart. Up to eight shells may be open. Reconnection restores the current screen, not previous client scrollback.
- `GET /api/herdr/snapshot`: local Herdr workspaces, tabs, agents, and panes.
- `GET /api/herdr/panes/{id}`: most recent 300 lines, with ANSI formatting.
- `POST /api/herdr/panes/{id}/input` with `text` and/or `keys`: literal text and Herdr key names. Text and Return can be sent atomically in one Herdr request.
- `WS /api/herdr/ws`: snapshots (checked every 1.2 seconds), selected pane output (checked every 300 ms), heartbeat/error messages, and acknowledged input. Send `select` with `pane_id`, then `input` with `id`, `pane_id`, `text`, and `keys`. Input is rejected if its pane no longer matches the selected pane. Pending input is never replayed after reconnection; an interrupted acknowledgement is reported as uncertain.

Herdr uses its installed protocol-20 NDJSON socket API directly. Pane viewing/input does not focus or resize the desktop Herdr pane. Wide output remains horizontally scrollable. There are no fabricated agent approval buttons; use the actual pane's keyboard controls. This version attaches to existing agents/panes; agent creation and workspace management can be added through the same adapter later.

## Configuration and operation

`~/.config/omarchy-remote/backend.env` is a private mode-0600 environment file shared by the two user services. `OMARCHY_PROXY_TOKEN` (at least 32 characters) is required. It is sent from the local development proxy to Rust and never embedded in web assets or returned to clients. Only the local proxy knows it. Browser API requests require `X-Hyprland-Client: 1`; WebSockets require an allowed Origin. Cross-origin requests and unrecognized Host values are rejected. Tailscale network access controls determine who can reach the host; this is a trusted-tailnet application, not a public multi-user shell service.

Optional settings:

- `OMARCHY_API_PORT` defaults to 4188.
- `OMARCHY_ORIGINS` is a comma-separated list of full origins; configure identically for both services. Defaults: the current HOST HTTPS endpoint and localhost/127.0.0.1 port 4187.
- `OMARCHY_HERDR_SOCKET` defaults to `$HOME/.config/herdr/herdr.sock`.
- `SHELL` selects the terminal shell. The installed service uses `/bin/bash` with the user's login configuration and starts in their home directory. Agent-specific environment and the proxy secret are removed from child shells.

Build with `cargo build --release --manifest-path backend/Cargo.toml`. Run through the enabled `omarchy-remote.service`. Restart that service after changing Rust; running PTYs end on restart. Restart `hyprland-touch-dev.service` after proxy/server changes. Web asset saves require neither restart.

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
