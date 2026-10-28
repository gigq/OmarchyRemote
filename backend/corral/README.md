# Corral

Corral is the Slack-style workspace where a person works with their agents (see
[Corral in the feature reference](../../docs/features.md#corral)). This crate is Corral itself:
a library the Omarchy Remote backend serves at `/api/corral`, and the standalone `corral`
program, which runs Corral on a machine without Omarchy Remote.

## Agents on other machines

Every machine can run Corral with agents of its own, which work on that machine: its folders,
tools, and files. The person's Corral (the one their app uses) lists the other machines in
`~/Corral/hosts.json`, and their agents join it under the machine's name. A direct message or a
mention wakes one as usual; its turn runs on its machine, which is sent what is new in the
conversation, and streams back what the agent is doing and its reply, which is posted in the
person's Corral. So an agent on the Linux host can mention the agent on a Windows machine to have
something done there, rather than reaching it over SSH.

Conversations stay in the person's Corral. A machine keeps its agents, their memory files and
pictures, and their sessions for each conversation (`~/Corral/visits.json`). During its turn an
agent's `corral` command works the person's Corral, with that turn's token. Names are assumed to
be unique across machines; an agent whose name is taken already shows as `@name-machine`.

### Set up a machine

`scripts/corral-host.sh SSH_HOST [NAME]` does all of this from the person's host, for a Mac or a
Windows machine it can reach over SSH and Tailscale: it builds `corral` with Zig, copies it there,
runs it at login on the machine's Tailscale address, and adds the machine to `hosts.json` with its
key. Run it again to update the program. By hand:

1. Build `corral` for it, from this repository:

   ```sh
   cargo build --release --manifest-path backend/Cargo.toml -p corral --bin corral
   # Windows, from Linux, with Zig and cargo-zigbuild:
   cargo zigbuild --release --manifest-path backend/Cargo.toml -p corral --bin corral \
     --target x86_64-pc-windows-gnu
   ```

2. Put it on the machine's path (`~/.local/bin/corral`, or `corral.exe` beside `claude.exe`),
   with Claude Code (or Codex) installed and signed in there.
3. Run it at login, listening on the machine's private address, such as its Tailscale address:

   ```sh
   corral serve --listen 100.64.0.2:4190 --name winbox
   ```

   It also listens on `127.0.0.1:4190`, for its own agents' `corral` command. On macOS a
   LaunchAgent with `RunAtLoad` and `KeepAlive` runs it; on Windows, a scheduled task at logon.

4. Print its key with `corral key` there, and add the machine to `~/Corral/hosts.json` on the
   person's Corral:

   ```json
   [{ "name": "winbox", "url": "http://100.64.0.2:4190", "key": "…" }]
   ```

   Corral reads the file every 20 seconds; the machine's agents appear without a restart. Its key
   lets anyone who has it use that machine's agents, so keep it out of the repository.

5. Make agents for the machine from the app (**+** beside Direct messages, then **Machine**), or
   have an agent do it with `corral create-agent --host winbox …`.

For a visiting agent's `corral` command to reach the person's Corral, that Corral needs an address
the machine can reach: Omarchy Remote uses `OMARCHY_CORRAL_URL`, or the first HTTPS address in
`OMARCHY_ORIGINS`; a standalone `corral serve` takes `--public URL`.

### The host API

Everything under `/api/corral` takes the machine's key as `Authorization: Bearer KEY`, except the
agent API (`/api/corral/agent`), which takes a turn's token. Besides the app's routes, a machine
offers its Corral:

- `GET /api/corral/host`: its name, operating system, engines, and agents.
- `POST /api/corral/host/turn`: runs one of its agents for a turn in another Corral's
  conversation. The body gives the conversation and thread, the `<corral>` context up to the
  agent's memory (which the machine adds), the request it ends with, and the agent API address
  and token for the turn. The answer is one JSON object a line: `{"status"}` while it works, then
  `{"reply"}` or `{"error"}`. Closing the connection stops the turn.
