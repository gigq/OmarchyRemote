# Contributing

Omarchy Remote is a single-user tool that runs on your own desktop, so most contributions are new apps, new host programs, or fixes to the existing ones. This guide covers the setup, the checks, and how an app plugs in.

## Setup

Follow [Install on the host](README.md#install-on-the-host). Development happens against the running services: saves under `public/` reload every connected shell, Rust changes need a build and a restart of `omarchy-remote.service`, and changes under `scripts/` need a restart of `hyprland-touch-dev.service`. Never commit or print `~/.config/omarchy-remote/backend.env`.

Checks, in the order they usually matter:

```sh
npm run format              # Prettier, plus the component script in public/index.html
npm run lint                # Prettier check, cargo fmt --check, clippy
cargo test --manifest-path backend/Cargo.toml
npm test                    # formatting check plus the Node unit tests
npm run test:backend        # needs the services; creates and removes its own Herdr workspace
npm run test:ui             # Playwright against the running dev server
npm run build && npm test
python -m unittest discover -s scripts -p 'test_native_bundle.py'
```

`npm run test:ui` reads existing Herdr panes but never types into them; keep it that way. Commit each finished change on its own with its checks passing.

## How an app plugs in

The shell reads one catalog, `window.HyprlandApps` in `public/apps.js`. Every workspace, Home pin, launcher entry, Expo card, desk tile, and keyboard route is derived from it, so an app is three small pieces:

1. **A catalog entry** in `public/apps.js`:

   ```js
   define('notes', {
     name: 'notes', // label on tiles, pills, and the launcher
     color: 'var(--theme-magenta)', // tile color, any theme token
     glyph: 'nt', // two-letter tile glyph
     description: 'scratch notes', // launcher subtitle
     surface: 'page', // 'terminal' cards use the terminal background
     native: false, // true: the touch keyboard and hardware keys go to instance.key()
     offline: false, // true: usable without the backend (no "connect to the host" placeholder)
     typing: null, // keyboard status label while focused (defaults to the name)
   });
   ```

   The key doubles as the host app id the backend knows. `mount` (default `remote-<key>-app`) is the id of the element the app renders into; `public/cards.js` creates that element inside the app's workspace card. Add the key to `DEFAULT_PINS` if it should be on Home for new installs.

2. **A module** `public/<key>.js`, loaded from `public/index.html` next to the other app modules (before `remote.js` if it uses the terminal renderer, anywhere otherwise). It registers a provider:

   ```js
   (() => {
     const { node, button, storage } = window.HyprlandUtil;
     class NotesApp {
       constructor(root, bridge) {
         this.root = root;
         this.bridge = bridge;
         root.append(node('p', 'remote-status', 'hello'));
       }
       connect() {} // called once after create; open sockets, fetch state
       resume() {} // page returned to the foreground or came back online
       show(visible) {} // the card is on screen (desk mode may show several)
       blur() {} // another app took focus
       resize() {} // viewport or keyboard changed
       key(input) {} // native apps only: bytes from the touch/hardware keyboard
       hostChanged() {} // HyprlandApps.host was updated from /api/capabilities
       dispose() {} // shell teardown
     }
     window.HyprlandApps?.provide('notes', {
       create: (root, bridge) => new NotesApp(root, bridge),
       close: app => {}, // the card was tossed from Expo; app is null if never created
     });
   })();
   ```

   Every instance method is optional; the bridge in `public/remote.js` calls whichever exist. It also offers `bridge.keyboard()` to raise the system keyboard, `bridge.createInput(root, message, send)` for a Herdr-style draft composer, `bridge.openTerminalAt(path)`, and `bridge.logic` (the shell component, with `state`, `set`, `openApp`, `cur`). Use `HyprlandApps.host.name` and `HyprlandApps.tilde(path)` in status text so the host's name shows instead of a hardcoded one. `window.HyprlandUtil` has `node`, `button`, `mount`, and `storage` (namespaced `localStorage` with JSON helpers). Talk to the backend with `fetch('/api/<app>/…', {headers: {'X-Hyprland-Client': '1'}})`; WebSockets go to `/api/<app>/…/ws` on the same origin. Styles go in `public/<key>.css`, linked from `index.html`; use the `--theme-*` tokens so every Omarchy palette applies.

3. **Host support**, one of:

   - **A terminal program** (the btop, Services, lazydocker, dua, lnav pattern). Add a row to `TUIS` in `backend/src/apps.rs` with the id, display name, feature tags, program, arguments, environment, and `wait_for_client` (true for programs that probe the terminal at startup, such as notcurses apps). Programs are resolved on `PATH`, `~/.cargo/bin`, `~/.local/bin`, `/usr/local/bin`, and `/usr/bin`; `{data}` in an argument expands to `~/.local/share/omarchy-remote`. Then add the touch controls to `HOST_TUIS` in `public/remote.js` (`cols` for the Fit width, `keys` as `[label, bytes]` pairs, optional `search` bytes). The catalog entry uses `surface: 'terminal', native: true`, and the provider is registered for you: the terminal view, reconnection, Fit/Larger, and session persistence all come from `TerminalApp`. Nothing else in the frontend changes.
   - **A dedicated API** (the Files, Browser, Herdr pattern). Add a module under `backend/src/`, register its routes under `/api/<app>/…` in `backend/src/main.rs`, and list it in `SERVICES` in `backend/src/apps.rs` so `/api/capabilities` advertises it. Routes inherit the origin and client-header checks, payload limits, and the proxy token from the shared transport; keep filesystem access inside HOME and never expose the environment file.
   - **Nothing** for apps that only need the browser (`offline: true`), like Settings.

4. **Optional shortcuts.** Desk mode bindings are the `BINDINGS` list in `public/desk.js`; the phone's SUPER keyboard map is `bind` in the shell component in `public/index.html`.

5. **Tests and docs.** For a terminal program, add `[id, marker]` to the table in `scripts/backend.test.mjs` (a string the program draws soon after start) and the id to the loop in `tests/browser/host-tuis.spec.mjs`. For an API app, add a backend unit test and a Playwright spec under `tests/browser/` that reads real host output without sending input to other people's sessions. Describe the app in `docs/features.md` and add it to the app list in `README.md`.

## Code style

Formatting is automated so reviews and merges stay about behavior. Prettier (`.prettierrc`, 100 columns) covers JavaScript, CSS, JSON, and Markdown; `cargo fmt` covers Rust; swift-format (`.swift-format`, four spaces, 120 columns) covers the iOS wrapper and runs on a Mac with `xcrun swift-format format -i -r ios/HyprlandTouch ios/HyprlandTouchUITests`. Write one statement per line and keep formatting-only commits separate, listing them in `.git-blame-ignore-revs` (enable it locally with `git config blame.ignoreRevsFile .git-blame-ignore-revs`). CI (`.github/workflows/ci.yml`) runs the host-independent checks on every push and pull request; the Playwright, live-server, and backend suites need a running host and stay local.

## Conventions

- Keep the phone shell (viewports under 600 px) and desk mode both working; `tests/browser/desk.spec.mjs` covers the split.
- Do not edit `ios/Generated/Web`; it is produced by `scripts/prepare-native.py`.
- The shell template in `public/index.html` is a design-tool export on its own runtime; app code belongs in modules, not in the template.
- Status text names the host from `HyprlandApps.host`, never a hardcoded machine name. Paths shown to users go through `HyprlandApps.tilde`.
- Backend code refuses what it cannot verify: HOME confinement, bounded searches, no-replace writes, and no secrets in responses.
