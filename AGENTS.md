# Feature commits

- Commit each completed feature or fix after its relevant checks pass, before reporting it finished. Do not accumulate unrelated completed work in the working tree.
- Honor explicit requests to leave an experiment uncommitted. Preserve unrelated in-progress changes and keep each commit focused.
- A request to commit does not imply pushing or publishing.

# Code style

- Run `npm run format` before committing. `npm test` fails on unformatted code, and CI runs `npm run lint` (Prettier, `cargo fmt --check`, clippy). Prettier settings are in `.prettierrc`; Swift uses `.swift-format`, applied on a Mac with `xcrun swift-format format -i -r ios/OmarchyRemote ios/OmarchyRemoteUITests`.
- One statement per line. Never join statements with semicolons or write a class, method, or rule set as a single line; merges and reviews happen by line.
- Keep formatting-only changes in their own commit and add its hash to `.git-blame-ignore-revs`.
- The markup in `public/index.html` is a design-tool export; leave it as exported. Its component script is formatted by `scripts/format-template.mjs`, which `npm run format` runs.
- New apps follow CONTRIBUTING.md: a `define` in `public/apps.js`, a `public/<key>.js` module that calls `provide`, and host support in `backend/src/apps.rs` or a route module. Do not add app-specific branches to `remote.js`, `desk.js`, `dashboard.js`, or the shell component; add a provider hook instead.

# Checks before reporting done

- `npm test` and `npm run lint` always. Run the Playwright specs that cover the changed surface (`npm run test:ui -- tests/browser/<spec>.mjs`); `npm run test:backend` for Rust changes; `python -m unittest discover -s scripts -p 'test_native_bundle.py'` for packaging changes; an Xcode build for Swift changes.
- When behavior changes on purpose, update the specs and the docs (`README.md`, `docs/features.md`) in the same commit. A test that describes the old behavior is a failing test, not an exception.
- The backend caps terminal sessions at 8 and a failed UI test leaves its session open. If specs report 429 or "unavailable · retrying…", restart `omarchy-remote.service` before rerunning; finish isolated tests first because the restart ends backend-owned shells.

# Development loop

The two user services from `deploy/install.sh` are `omarchy-remote.service` (the Rust backend on loopback 4188) and `omarchy-remote-dev.service` (`scripts/serve.mjs` on loopback 4187: static files, live reload, and the `/api/` proxy). A Debug build of the native app loads `OmarchyRemoteURL` from `ios/OmarchyRemote/Info.plist`, the host's private HTTPS address plus `/native/`.

- Edit `public/index.html` for the shell template and component; app modules live in `public/*.js`. Shared styles/behavior are `public/pwa.css` and `public/pwa.js`; native layout overrides are `ios/WebOverrides/native.css`.
- Saves under `public/` reload every connected shell, including the native app on its live source. HTML/CSS/JS changes need no Xcode build or reinstall.
- Restart `omarchy-remote-dev.service` after editing `scripts/serve.mjs` or `scripts/live-reload.js`. Do not leave a service stopped after testing an outage.
- Build changed Rust with `cargo build --release --manifest-path backend/Cargo.toml`, then restart `omarchy-remote.service`. This ends backend-owned shells; finish isolated tests before restarting.
- The live server disables service-worker caching. `/native/` serves `ios/Generated/Web`, which `scripts/prepare-native.py` generates from `public/`; do not edit it directly.
- `public/themes-data.js` (palettes) and the ignored `public/backgrounds/` (WebP wallpapers plus `catalog.js`) come from `python scripts/import-themes.py`, which `deploy/install.sh` runs. Do not hand-edit either.
- Swift changes need a new signed build and device installation. `npm run test:live` exercises the running server; `npm run build && npm test` validates the separate PWA build.

# Host app integration

- One Rust backend in `backend/` serves all host apps. Terminal owns PTYs; Herdr uses the local Unix socket. Add future app adapters under this shared backend, not separate servers per app. Terminal programs are rows in `backend/src/apps.rs`; every app is a `define` in `public/apps.js` plus a `provide` from its module (see CONTRIBUTING.md).
- Allowed origins and the host's display name come from `OMARCHY_ORIGINS` and `OMARCHY_HOST_NAME` in `~/.config/omarchy-remote/backend.env`, which both services load.
- `public/desk.js` and `public/desk.css` own desk mode (viewports with both edges ≥ 600px: iPad, Mac, desktop windows): tiled workspaces, ⌘/Ctrl+Alt bindings, and the ⌘/ sheet. Keep the phone shell below that threshold unchanged; `tests/browser/desk.spec.mjs` covers both.
- `public/remote.js` and `public/remote.css` own the real app views. `public/native-terminal.js` renders xterm buffers into native overflow views; `public/native-input.js` owns system-keyboard input and pane drafts. `public/dashboard.js` and `public/dashboard.css` own Home summaries, pinned apps, notifications, and the native-input launcher. The exported component owns shell gestures and the SUPER custom keyboard.
- Never print, embed, or commit `~/.config/omarchy-remote/backend.env`; its proxy secret is server-only. Machine-specific values (hostnames, tailnet URLs, signing teams, bundle identifiers) belong in that file, in your local `Info.plist` and signing settings, or in environment variables, never in committed code or docs.
- `npm run test:backend` creates and deletes its own test workspace in Herdr. Never send QA prompts, approvals, or test input into existing agent panes. `npm run test:ui` uses headless Chromium and reads existing Herdr panes without typing into them, and its settings tests never touch the live web-app catalog.
