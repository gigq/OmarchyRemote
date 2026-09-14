# Omarchy Remote

A touch shell for an [Omarchy](https://omarchy.org) desktop, used from an iPhone, an iPad, or any browser window. It opens a real shell on the host, browses the home directory, mirrors desktop browser tabs, follows Herdr agent panes, and runs host TUIs (btop, systemctl-tui, lazydocker, dua, lnav) inside phone-sized windows with Hyprland-style workspaces, Expo, SUPER bindings, and the Omarchy theme catalog. On larger screens the same shell tiles windows like Hyprland's dwindle layout and takes ⌘ shortcuts.

Everything runs on the host you already own. There is no cloud relay: a Rust backend on loopback serves the apps, a small Node server serves the web shell, and a private HTTPS address (Tailscale Serve works well) puts it on your phone.

## Layout

| Path | What it is |
| --- | --- |
| `public/` | The web shell. `index.html` holds the shell template and component (a Claude Design export kept on its `x-dc` runtime); each app is its own `public/<app>.js` module registered through `public/apps.js`. |
| `backend/` | Rust (axum) host backend on `127.0.0.1:4188`: PTYs, Herdr, files, browser bridge, widgets, uploads. See [backend/README.md](backend/README.md). |
| `scripts/serve.mjs` | Development server on `127.0.0.1:4187`: static files, live reload, and the `/api/` proxy to the backend. |
| `scripts/build.mjs` | Builds a standalone PWA (Cloudflare Worker plus static client) in `dist/`. |
| `ios/` | Native iPhone/iPad wrapper (UIKit + WKWebView) that loads the live shell and bundles an offline copy. |
| `browser-extension/` | Vivaldi/Chromium extension that exposes windows, workspaces, and tabs to the Browser app. |
| `deploy/` | systemd user unit templates and `install.sh`. |
| `docs/` | [Feature reference](docs/features.md) and design handoff notes. |
| `tests/`, `scripts/*.test.mjs` | Playwright and Node tests. |

## Requirements

- An Omarchy (Arch + Hyprland) host, or any Linux host with systemd user services. The shell reads Omarchy theme files if present and falls back to its bundled palettes.
- Rust (stable) and Cargo, Node 20 or newer, Python 3.
- Optional host programs, each enabling one app: Herdr (agents, through its local socket), `btop`, `systemctl-tui` (`cargo install systemctl-tui --locked`), `lazydocker`, `dua`, `lnav`, `tailscale` (the Tailscale widget), `gio` (trash), `codexbar` (usage widget). Programs are looked up on `PATH`, `~/.cargo/bin`, and `~/.local/bin`; an app whose program is missing reports that instead of failing silently.
- A private HTTPS address for the phone. Tailscale Serve is what this project was built against; any reverse proxy that terminates TLS and forwards WebSockets works.

## Install on the host

1. Clone and build:

   ```sh
   git clone <this repository> ~/src/omarchy-remote
   cd ~/src/omarchy-remote
   npm install
   cargo build --release --manifest-path backend/Cargo.toml
   ```

2. Create the private environment file both services read. Keep it mode 0600; it is never served to clients.

   ```sh
   mkdir -p ~/.config/omarchy-remote
   umask 077
   cat > ~/.config/omarchy-remote/backend.env <<'ENV'
   OMARCHY_PROXY_TOKEN=<random string of at least 32 characters, e.g. openssl rand -hex 32>
   OMARCHY_ORIGINS=https://<your-host>.<your-tailnet>.ts.net:12443,http://127.0.0.1:4187,http://localhost:4187
   OMARCHY_HOST_NAME=<name shown in the app, defaults to the kernel hostname>
   ENV
   ```

   `OMARCHY_ORIGINS` must list every origin a browser will load the shell from. All settings are documented in [backend/README.md](backend/README.md#configuration-and-operation).

3. Install and start the two user services. `deploy/install.sh` renders `deploy/*.service` with this checkout's path and the `node` on your `PATH`, copies them to `~/.config/systemd/user/`, and enables them. Enable lingering so they run without a login session.

   ```sh
   deploy/install.sh
   loginctl enable-linger "$USER"
   ```

4. Publish the web server on a private HTTPS address, for example with Tailscale Serve:

   ```sh
   tailscale serve --bg --https=12443 http://127.0.0.1:4187
   ```

   Only the loopback listeners exist otherwise. Whoever can reach that address can open a shell as your user, so keep it inside your tailnet or behind equivalent access control. This is a single-user tool, not a multi-tenant service.

5. Open the address on the phone. Safari's Share → Add to Home Screen installs it as a web app; open it online once so the offline shell caches. The native app below wraps the same pages at `/native/`.

## Using it

**Phone.** Start edge gestures inside the app's content, above the home indicator and below the status area. Left and right edges switch workspaces. Swipe down from the top left, middle, or right for notifications, the launcher, or quick settings. Swipe up from the bottom corners for the keyboard or the SUPER keyboard; the middle of the bottom edge opens Expo, as does tapping the active workspace pill. Workspace state resets on reload; host sessions reconnect.

**iPad, Mac, and desktop windows.** When both edges of the viewport are at least 600 px, the shell switches to desk mode: a 1:1 layout that fills the window, Home with the clock, app grid, and all widgets at once, and workspaces that tile windows with Hyprland's dwindle split (up to four per workspace). Hardware keyboards use ⌘ on Apple devices (Omarchy's SUPER) and Ctrl+Alt elsewhere. Press ⌘/ or tap the shortcut button in the top bar for the same table.

| Keys | Action |
| --- | --- |
| ⌘1…9 / ⌘0, ⌘[ / ⌘] | Switch workspace, previous / next workspace |
| ⌘E | Expo overview |
| ⌘⌥1…9 / ⌘⌥0, ⌘⇧[ / ⌘⇧] | Move the focused window to a workspace |
| ⌘← ↑ ↓ →, ⌘⇧arrows | Focus / swap window in a direction |
| ⌘J / ⌘⇧J | Next / previous window in the workspace |
| ⌘F | Toggle fullscreen for the focused window |
| ⌘W | Close the focused window |
| ⌘⏎ (or ⌘T), ⌘⇧B, ⌘⇧F, ⌘⇧A, ⌘⇧D, ⌘, | Terminal, browser, files, Herdr, lazydocker, settings |
| ⌘K | Launcher |
| ⌘/ | Shortcut sheet; Esc closes sheets, Expo, and shades |

0 selects workspace 10. Window cycling requires multiple windows in the current workspace and follows the focused window in fullscreen. Text fields keep the standard editing shortcuts, including ⌘arrows and ⌘⌫; use ⌘J to cycle while editing. ⌘Space and ⌘backtick are left to the operating system. The native app registers shell commands with UIKit; web browsers can intercept shortcuts before the shell receives them. Numbered moves use Option on iPad because Shift-Command-3/4 are screenshot shortcuts; the browser version retains Shift. ⌘Enter opens Terminal (⌘T remains an alternate). Shift-Return for Browser and Delete for closing windows remain browser-only aliases.

`tests/browser/shortcuts.spec.mjs` exercises every binding in an isolated browser fixture, including both modifier forms, move/swap, fullscreen cycling, and editing conflicts. This verifies shell behavior, not physical iPad keyboard delivery. The native `HardwareShortcuts` Xcode scheme runs XCTest UI tests with `typeKey(_:modifierFlags:)` on an iPad simulator to verify actual modifier-key routing and that closing internal windows keeps the app running. It launches the bundled shell so tests cannot affect host sessions.

**Apps.** Terminal (a login shell in a PTY, resumed across reloads), Herdr (workspaces, agents, and pane output with a message composer), Files (browse, preview, edit, search, upload, move, trash, ZIP), Browser (desktop tabs through the extension), btop, Services, lazydocker, dua, lnav (each a persistent host PTY with touch controls), Home widgets (system metrics, Tailscale, weather, CodexBar), and Settings (all Omarchy themes, applied to the shell and to terminal colors). The [feature reference](docs/features.md) describes each in detail.

**Backgrounds and transparency.** Settings offers the installed Omarchy theme backgrounds, with a separate remembered choice for each theme and a Solid color option. Windows use Omarchy’s default opacity: 98.5% focused and 96% unfocused, including native Browser and web-app views. `python scripts/import-themes.py` imports palettes and optimized WebP backgrounds from the installed themes (requires Pillow).

**Web apps.** In Settings, enter a name and an http/https URL under Web apps, then choose Install web app. Saved apps appear on Home and in the launcher. Each opens an independent native website view without browser controls and supports workspaces, iPad tiling, and Expo. Tapped web links, including external links requesting a new tab or window, open in that same view; native back/forward gestures return through its browsing history. Remove an installation from Settings; closing its Expo card only closes the running view. Installations are shared by all devices connected to the host. Installing pins the app on the current device; other devices can find it in the launcher and choose their own pins. Uninstalling removes it from the host catalog for every device. Website login sessions stay on each device, and web apps do not sync navigation to desktop tabs.

## Saved settings and device backups

Settings → This device lets you name the device, back up now, or restore another device’s backup. Themes, wallpaper choices, Home pins, widgets, app preferences, and window arrangements stay independent on each device. Local changes save immediately and retry their host backup after reconnecting. Herd message drafts save on every edit, separately for each pane, and reappear when you return after a reload or app restart. Drafts stay on the local device and are excluded from host settings backups; sending or deleting the text clears that draft. A storage failure displays a warning while keeping the text in the composer. Open windows can be restored, but a terminated host terminal process is not recreated with its old contents.

The native shell uses persistent website storage plus a native preferences mirror shared with its bundled offline copy. Website cookies use a separate on-device store and are never included in host backups. A new device downloads the host’s web-app catalog and starts with its own preferences; restoring an existing device backup is an explicit choice. Existing local web apps migrate into the shared catalog on connection. Settings that an older, temporary-storage build already lost cannot be recovered unless it had time to back them up.

The Rust backend stores the catalog and per-device backups in `settings.sqlite3` under its application data directory (`$XDG_DATA_HOME/omarchy-remote`, or the standard user data directory). Include this database in host backups; use SQLite’s backup API for a consistent copy while the service is running. The schema is versioned, updates use revision checks, and deleted web-app records prevent stale devices from reinstalling removed apps during migration. Browser tests isolate these APIs so they do not create records in the live catalog.

## Browser navigation and keyboard

Browser reopens the last viewed HTTP(S) tab on this device if it is still in the desktop snapshot. The saved selection uses the extension's stable profile ID across bridge reconnections. A closed or internal tab falls back to the tab manager; a disconnected profile keeps its selection for reconnection. The back chevron in Browser opens the tab manager explicitly. In its search field, Return opens the first matching web tab. Website navigation still updates the selected desktop tab's URL.

When Browser is active, its keyboard commands take precedence over conflicting shell commands. The `⌘ /` shortcut list includes Browser commands. Clipboard and website text editing stay native. Find uses WebKit’s native search panel, keeping the query and match navigation in the website’s own view.

| Keys | Action |
| --- | --- |
| ⌘ L | Select address; in the manager, search tabs |
| ⌘ ⇧ L or F2 | Open and search the tab manager |
| ⌘ T / ⌘ N | Create a desktop tab / window (enter its URL) |
| ⌘ W | Close the current desktop tab and select the next available tab |
| ⌘ ⇧ T | Reopen a tab closed here, restoring its URL |
| Ctrl Tab / Ctrl ⇧ Tab, Ctrl PageDown / PageUp | Next / previous openable tab across profiles and windows |
| ⌘ ⌥ → / ← | Next / previous openable tab |
| ⌘ 1–8 / ⌘ 9 | Numbered tab / last openable tab in the current desktop window |
| ⌘ [ / ] | Page back / forward |
| ⌘ R / ⌘ ⇧ R, F5 / ⇧ F5 | Reload / reload bypassing cache |
| ⌘ F, ⌘ G / ⌘ ⇧ G, F3 / ⇧ F3 | Find in page, next / previous match |
| ⌘ + / − / 0 | Page zoom in / out / reset |
| Escape | Dismiss dialog/find/options, otherwise stop loading |
| ⌘ ⇧ W / ⌘ ⇧ F | Close Browser's shell window / toggle its fullscreen layout |

Use ⌘ E for Expo, ⌘ J / ⇧ J for adjacent shell panes, and ⌘ Return for Terminal while Browser owns the usual tab keys. Native shortcut interception and find/zoom require build 27 or later. These commands operate the embedded WebKit page or the desktop tab adapter; they do not reproduce Vivaldi-only features such as panels, bookmarks, command chains, or DevTools. Reopening a tab restores its URL, not its old page history or form state. The last tab and the last 20 tabs closed here are stored locally and included in the native local preferences mirror, not the shared installed-app catalog.

## Native iPhone, iPad, and Vision Pro app

`ios/HyprlandTouch.xcodeproj` is a UIKit/WKWebView wrapper for iOS 18 or later and native visionOS with the shared **HyprlandTouch** scheme and automatic development signing. It hides the status bar, defers the system edge gestures so the shell's swipes work, registers native iPad key commands and routes them to the shell, adds a Core Location bridge for the weather widget, and opens browser pages in an isolated WKWebView inside the themed Browser window.

The native visionOS destination uses the same shell in a freely resizable window, initially 1280×900 points with a 600×400 minimum. Width and height resize independently, and the shell remains in desktop mode even in a short window. VisionOS supplies the system window controls; the shell’s iPhone home indicator is hidden there. The native Vision Pro build replaces the earlier iPad-compatible installation using the same bundle identifier.

Before building, set two values in `ios/HyprlandTouch/Info.plist` and the project: `OmarchyRemoteURL` (your HTTPS address followed by `/native/`) and the bundle identifier. Debug builds load that live URL and fall back to the bundled offline copy if the host is unavailable; Release builds use the bundled copy only. If iOS terminates the shell’s web-content process, the app recovers automatically, deferring recovery until foreground when necessary. Repeated process failures are bounded before showing a manual retry. The offline copy preserves local settings and drafts, retries the host on foreground, and checks every 15 seconds while active without replacing the offline page on failed checks. Terminal output, agents, and other host-backed functions still require a connection. The offline status also offers a manual Retry live button. Every build runs `scripts/prepare-native.py` to package `public/` into the app. Hold two fingers on the screen for about a second to switch between the live and bundled sources or reload.

Build from Xcode with a paired device, or headlessly with `xcodebuild` and the HyprlandTouch scheme. `python -m unittest discover -s scripts -p 'test_native_bundle.py'` checks the packaging; `python scripts/prepare-native.py` writes an inspection copy to the ignored `ios/Generated/Web`.

## Adding your own app

Apps are self-contained: one `define(...)` line in `public/apps.js`, one module in `public/` that calls `HyprlandApps.provide(key, {create, close})`, and, for terminal programs, one row in the `TUIS` table of `backend/src/apps.rs`. Workspaces, Home pins, the launcher, Expo cards, desk tiles, and keyboard routing come from the catalog automatically. [CONTRIBUTING.md](CONTRIBUTING.md) walks through it, including the tests to extend.

## Development

The user service `hyprland-touch-dev.service` watches `public/` and reloads every connected shell within about a second of a save, including the native app when it is on the live source; host sessions reconnect. Restart that service after changing `scripts/serve.mjs` or `scripts/live-reload.js`. Rust changes need `cargo build --release --manifest-path backend/Cargo.toml` and a restart of `omarchy-remote.service`, which ends its PTYs.

```sh
systemctl --user status hyprland-touch-dev.service omarchy-remote.service
journalctl --user -u omarchy-remote.service -f
PORT=4190 npm run dev            # a second, foreground copy of the web server
cargo test --manifest-path backend/Cargo.toml
npm test                         # worker, keyboard, and client unit tests
npm run test:live                # against the running dev server
npm run test:backend             # backend integration; creates and removes its own Herdr workspace
npm run test:ui                  # Playwright, headless Chromium at a phone viewport
npm run build && npm test        # standalone PWA build
```

`GET /__dev/status` reports the current revision and connection count; `/__dev/events` is the reload stream. `scripts/build.mjs` writes a portable Cloudflare Worker to `dist/server/index.js` and the static client to `dist/client` with a content-versioned service worker for hosting the PWA elsewhere; the host APIs are still only reachable through your private address.

To remove the setup: `systemctl --user disable --now hyprland-touch-dev.service omarchy-remote.service`, delete the unit files, and drop the HTTPS listener (`tailscale serve --https=12443 off`).

## License

[MIT](LICENSE).
