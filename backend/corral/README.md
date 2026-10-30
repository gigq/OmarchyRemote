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

On a systemd host Corral starts each agent turn in its own scope in `corral.slice`
(`deploy/corral.slice`, which `deploy/install.sh` installs), so everything agents run, queued or
not, yields to the rest of the machine; a drop-in caps it, as tars's
`~/.config/systemd/user/corral.slice.d/budget.conf` (`CPUQuota=2400%`) does at 24 processors.

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

Job folders go as soon as their files are back; each machine also sweeps its own every five
minutes, removing a finished job its sender never came back for after ten minutes and a folder
with no job behind it after an hour. The farm's routes, under `/api/corral/farm`, take
the machine's key: `GET /farm` (name, tags, queue), and for a job `POST …/jobs/<id>/files` (a tar
stream in), `POST …/run`, `GET …/jobs/<id>` (waiting and its place, running, or done with its
exit status, and its log's end), `GET …/files?paths=` (a tar stream out), and `POST …/delete`.

### Split renders

A whole-video render from the house Chrome renderer (a `tools/render.mjs` that takes
`--from`/`--to`, `--audio-only`, `--keep-audio`, and `--print-segments`) is spread across the farm
by `render-slot` itself, with nothing asked of whoever runs it:

1. The soundtrack is mixed once, here (`--audio-only`).
2. Every piece of a video comes from one kind of machine, since macOS and Linux Chrome smooth
   text a shade differently: the Macs when two or more of them can take pieces, otherwise tars
   (four at once at 6 cores each).
3. The video is cut on whole seconds into pieces, about twice as many as there are places to run
   them, and each machine is handed the next piece whenever it has room. On the Macs, once none
   is left, an idle Mac takes a copy of the oldest piece still under way on another; whichever
   copy finishes first is used and the other is stopped, so a slow or busy Mac does not hold up
   the rest.
4. A Mac renders in its copy of the project (`~/.cache/corral-farm/projects/…`, synced with rsync,
   without `out/`, `.git/`, or `work/`), with Playwright's Chrome for macOS behind a shim at the
   Linux path the renderer looks in; a piece that fails there goes to another Mac, and that Mac
   takes no more. If every Mac gives up, the whole video renders on tars instead. Copies unused
   for three days are removed.
5. The pieces' pictures are joined in order under the one mix, as the renderer joins its own
   workers'; a join that does not match the soundtrack's length fails.

macOS and Linux Chrome draw a frame alike except for text anti-aliasing (a 340 s test: 99.9% of
pixels identical, the rest at glyph edges), so a video made on the Macs can differ from one made
on tars by that shade, but never from piece to piece. Seams fall on whole seconds.
`RENDER_SPLIT=0` renders whole, here.

A Blender render of a frame range (`blender … -P script.py -- … --frames A-B`, at least 16
frames) is spread the same way, but never across two kinds of GPU, since Eevee and Cycles do not
draw quite alike on each:

1. The machines form groups: gerty alone (CUDA/OptiX), the Macs together (Metal, all on the same
   Blender), and tars alone. A script that names `OPTIX` or `CUDA` renders on gerty only;
   `METAL`, on the Macs only; `HIP`, on tars only. Otherwise gerty goes first when its GPU seat is
   free, then the Macs, then tars.
2. The project (the folder above with `AGENTS.md`) is synced to each machine of the group,
   only the files that changed, without its renders, videos, `.git/`, or caches, and the frames
   are cut into ranges, about twice as many as machines. Each range runs in that machine's copy,
   with the GPU set up for it and `--python-exit-code 1`, so a script that raises fails the
   range.
3. What a range made (every file that changed in the copy while it ran) comes back into the
   project, where Blender would have written it. A group that renders nothing (a script that
   does not run on Windows, say) gives the whole job to the next group, which cuts it for its
   own machines; ranges no group could render run here.

A documentary's whole picture from Moving Records' editor (`python tools/edit.py <ep>`, a copy in
each project, which renders any stretch with `--range a,b` to the file `--out` names) is cut on
whole seconds into pieces of at least 30 s, about twice as many as fit here at once (6 cores
each), and they run side by side through this machine's queue. Each copy of the editor works out
its length and file its own way, so `render-slot` asks it: the editor runs inside a small Python
wrapper until it would start its encoder, and reports its length, frame rate, and file. One that
ends before then (stills, a sheet, a report) runs as it is. The pieces are joined into that file,
and each piece and the whole must have exactly the frames the editor would have rendered.
