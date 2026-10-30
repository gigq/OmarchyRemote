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

## The render queue

`render-slot`, the crate's second program, is each machine's render queue. Heavy jobs (Blender,
ffmpeg encodes and upscales, headless Chrome frame renders, Whisper) run through it, and take
turns for the machine's cores and GPU, first come, first served, so many agents can queue work
without overloading the machine.

```sh
render-slot --cores 6 --label "4K recut" -- ffmpeg -threads 6 …   # waits its turn, then runs
render-slot --gpu --cores 8 -- blender -b scene.blend -a          # also waits for a GPU seat
render-slot status                                                # what runs, what waits
```

A job asks for so many cores (the threads it uses; default 4) and, with `--gpu`, a GPU seat. Jobs
start in the order they came while they fit in the machine's budget, set in
`~/.config/render-slot.json` (`{"cores": 24, "gpus": 2, "env": {"DRI_PRIME": "…"}}`; by default
three quarters of its processors and one GPU seat), which leaves the rest for the person and the
agents. On Linux each job is held to its own whole cores, from the top down, and runs at a lower
priority, so a job that starts more threads than it asked for slows only itself; elsewhere the
budget alone holds.

Each job is a ticket in the queue's folder (the system's temporary folder, `render-queue`):
`<id>.json` says what it is and `<id>.lock` is held by the job while it lives, so a job that ends
or dies leaves the queue with no daemon to tell. Jobs started under the queue's predecessor, which
hold one of `/tmp/render-slots/slot*.lock`, count as four cores each until they end. Corral reads
the queue: an agent's job shows in its background line with its place in line, and the details
panel's Renders tab shows each machine's queue.

### The render farm

Machines running Corral (see [Agents on other machines](#agents-on-other-machines)) take each
other's jobs. `render-slot --on gerty …` sends one to a machine; `--needs cuda,blender` to the
least busy machine with every tag, this one included. `--in` paths go with the job and `--out`
paths come back; `render-slot machines` lists the farm.

```sh
render-slot --needs optix --gpu --cores 4 --in scene --out frames -- \
  blender -b scene/shot.blend -o //frames/f_#### -a
```

The sender packs the inputs as a tar stream for the machine's Corral, which unpacks them in a
folder of the job's own (`~/.cache/corral-farm/<id>`) and runs the command there as
`render-slot run …`, so it waits its turn in that machine's queue; the sender then reports its
place in line, prints its log when it ends, brings back the outputs as another tar stream, and
exits with its status. A program named in the command (`blender`, `ffmpeg`, `node`) is found on
that machine, through its settings' `tools` where it is not on the path, as Blender on Windows.
A machine's `tags` are those in its settings, the programs it has, and its system.

Job folders go when their files are back; each machine also sweeps its own every half hour,
removing finished jobs after six hours (time to recover files that did not come back) and
folders with no job behind them after a day. The farm's routes, under `/api/corral/farm`, take
the machine's key: `GET /farm` (name, tags, queue), and for a job `POST …/jobs/<id>/files` (a tar
stream in), `POST …/run`, `GET …/jobs/<id>` (waiting and its place, running, or done with its
exit status, and its log's end), `GET …/files?paths=` (a tar stream out), and `POST …/delete`.
