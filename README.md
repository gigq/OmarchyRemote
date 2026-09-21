# Omarchy Remote

A touch shell for an [Omarchy](https://omarchy.org) desktop, used from an iPhone, an iPad, or any browser window. It opens a real shell on the host, browses the home directory, mirrors desktop browser tabs, follows Herdr agent panes, and runs host TUIs (btop, systemctl-tui, lazydocker, dua, lnav) inside phone-sized windows with Hyprland-style workspaces, Expo, keyboard shortcuts, and the Omarchy theme catalog. On larger screens the same shell tiles windows like Hyprland's dwindle layout and takes ⌘ shortcuts.

Everything runs on the host you already own. There is no cloud relay: a Rust backend on loopback serves the apps, a small Node server serves the web shell, and a private HTTPS address (Tailscale Serve works well) puts it on your phone.

## Layout

| Path                           | What it is                                                                                                                                                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public/`                      | The web shell. `index.html` holds the shell template and component (a Claude Design export kept on its `x-dc` runtime); each app is its own `public/<app>.js` module registered through `public/apps.js`. |
| `backend/`                     | Rust (axum) host backend on `127.0.0.1:4188`: PTYs, Herdr, files, browser bridge, widgets, uploads. See [backend/README.md](backend/README.md).                                                           |
| `scripts/serve.mjs`            | Development server on `127.0.0.1:4187`: static files, live reload, and the `/api/` proxy to the backend.                                                                                                  |
| `scripts/build.mjs`            | Builds a standalone PWA (Cloudflare Worker plus static client) in `dist/`.                                                                                                                                |
| `ios/`                         | Native iPhone/iPad wrapper (UIKit + WKWebView) that loads the live shell and bundles an offline copy.                                                                                                     |
| `browser-extension/`           | Vivaldi/Chromium extension that exposes windows, workspaces, and tabs to the Browser app. Its [README](browser-extension/README.md) covers installation and the pinned extension id.                      |
| `deploy/`                      | systemd user unit templates and `install.sh`.                                                                                                                                                             |
| `docs/`                        | [Feature reference](docs/features.md).                                                                                                                                                                    |
| `tests/`, `scripts/*.test.mjs` | Playwright and Node tests.                                                                                                                                                                                |

## Requirements

- An Omarchy (Arch + Hyprland) host, or any Linux host with systemd user services. The shell reads Omarchy theme files if present and falls back to its bundled palettes.
- Rust (stable) and Cargo, Node 20 or newer, Python 3.
- Optional host programs, each enabling one app: Herdr (agents, through its local socket), `btop`, `systemctl-tui` (`cargo install systemctl-tui --locked`), `lazydocker`, `dua`, `lnav`, `tailscale` (the Tailscale widget), `gio` (trash), `codexbar` (usage app and widget). Programs are looked up on `PATH`, `~/.cargo/bin`, and `~/.local/bin`; an app whose program is missing reports that instead of failing silently.
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

## Multiple hosts

Settings → Manage hosts, or search “hosts” in the launcher, opens the device’s saved
connection list. Add an HTTPS address for another machine running this backend and
web server, then select it to connect. Saving the same address again renames it.
Save up to ten hosts; their list order determines **⌘ Control 1–9 / 0** on iPad
and visionOS (0 selects host 10). These shortcuts are separate from workspace
numbers and appear in shortcut help and customization. The launcher also lists
each saved host directly.

**Disconnect** in Settings or the launcher returns to the local host picker without
closing remote shells or agents. The selected host survives app restarts; an
explicit disconnect stays disconnected. The native picker works without a server.
Host switching requires native **build 34**. Existing installations keep their
configured host automatically; no address needs to be re-entered.

The host directory stays on the device, outside host backups. Each host retains
its own preferences, layouts, terminal IDs and Herd drafts, including when using
the shared bundled offline page. Removing a saved host does not delete its remote
data or its saved preferences. Embedded website cookies remain device-wide.
In the PWA, connecting navigates to the other origin and carries only the host list
in a URL fragment (removed immediately after loading); preferences remain isolated
by origin. Cross-origin navigation may leave an installed PWA’s standalone scope.
Use the native app for switching within one app window. Hosts must already be
reachable on the device’s network, such as through Tailscale; this screen does not
install or configure a remote server.

## Using it

**Phone.** Start edge gestures inside the app's content, above the home indicator and below the status area. Left and right edges switch workspaces. Swipe down from the middle of the in-app top bar for the launcher. The top corners have no app pull-down panes; the native app leaves the system top-edge gestures to iOS. Open Settings from Home or the launcher. Swipe up from either bottom corner to open native input in Terminal or herdr; the middle of the bottom edge opens Expo, as does tapping the active workspace pill. Open workspaces are restored on reload and host sessions reconnect; when a shell's process exits its tab closes, and the terminal window closes with its last tab.

**iPad, Mac, and desktop windows.** When both edges of the viewport are at least 600 px, the shell switches to desk mode: a 1:1 layout that fills the window, Home with the clock, app grid, and all widgets at once, and workspaces that tile windows with Hyprland's dwindle split (up to four per workspace). Hardware keyboards use ⌘ on Apple devices (Omarchy's SUPER) and Ctrl+Alt elsewhere. Press ⌘/ or tap the shortcut button in the top bar for the same table.

| Keys                       | Action                                                |
| -------------------------- | ----------------------------------------------------- |
| ⌘1…9 / ⌘0, ⌘[ / ⌘]         | Switch workspace, previous / next workspace           |
| ⌘E                         | Expo overview                                         |
| ⌘⌥1…9 / ⌘⌥0, ⌘⇧[ / ⌘⇧]     | Move the focused window to a workspace                |
| ⌘← ↑ ↓ →, ⌘⇧arrows         | Focus / swap window in a direction                    |
| ⌘J / ⌘⇧J                   | Next / previous window in the workspace               |
| ⌘F                         | Toggle fullscreen for the focused window              |
| ⌘W                         | Close the focused window                              |
| ⌘⏎, ⌘⇧B, ⌘⇧F, ⌘⇧A, ⌘⇧D, ⌘, | Terminal, browser, files, Herdr, lazydocker, settings |
| ⌘K                         | Launcher                                              |
| ⌘/                         | Shortcut sheet; Esc closes sheets and Expo            |

0 selects workspace 10. Window cycling requires multiple windows in the current workspace and follows the focused window in fullscreen. Text fields keep the standard editing shortcuts, including ⌘arrows and ⌘⌫; use ⌘J to cycle while editing. ⌘Space and ⌘backtick are left to the operating system. The native app registers shell commands with UIKit; web browsers can intercept shortcuts before the shell receives them. Numbered moves use Option on iPad because Shift-Command-3/4 are screenshot shortcuts; the browser version retains Shift. ⌘Enter opens Terminal and immediately focuses its input. Native build 36 adds a WebKit focus handoff whenever the active input window changes, including returning to herdr after closing Terminal; older builds retain DOM-only focus. Shift-Return for Browser and Delete for closing windows remain browser-only aliases.

`tests/browser/shortcuts.spec.mjs` exercises every binding in an isolated browser fixture, including both modifier forms, move/swap, fullscreen cycling, and editing conflicts. This verifies shell behavior, not physical iPad keyboard delivery. The native `HardwareShortcuts` Xcode scheme runs XCTest UI tests with `typeKey(_:modifierFlags:)` on an iPad simulator to verify actual modifier-key routing and that closing internal windows keeps the app running. It launches the bundled shell so tests cannot affect host sessions.

**CodexBar.** Tap its Home widget or open CodexBar from the launcher to inspect Codex and Claude usage, banked reset counts and expiry, credits, service status, and local token-cost history. Details depend on what the host CLI reports; reset credits are read-only. Reset watch adds willreset.com forecasts, time since the last reset, reset-related posts, and reset history with source links. App providers can register their own linked Home widgets. The herdr widget uses the same system: its widget opens individual project threads, prioritizes attention items, and shows working threads when none need attention.

**Apps.** Terminal (a login shell in a PTY, resumed across reloads), Herdr (workspaces, agents, and pane output with a message composer), Files (browse, preview, edit, search, upload, move, trash, ZIP), Browser (desktop tabs through the extension), btop, Services, lazydocker, dua, lnav (each a persistent host PTY with touch controls), Home widgets (system metrics, Tailscale, weather, CodexBar), and Settings (all Omarchy themes, applied to the shell and to terminal colors). The [feature reference](docs/features.md) describes each in detail.

**Backgrounds and transparency.** Settings offers the host's Omarchy theme backgrounds, with a separate remembered choice for each theme and a Solid color option. Windows are 95% opaque when focused and 92% otherwise, including native Browser and web-app views. `deploy/install.sh` runs `python scripts/import-themes.py`, which copies the installed palettes into `public/themes-data.js` and converts the theme backgrounds to WebP under the generated, untracked `public/backgrounds/` (needs Pillow: `sudo pacman -S python-pillow`). Rerun it after installing or changing Omarchy themes; a host without Omarchy keeps the committed palettes and offers no backgrounds.

**Web apps.** In Settings, enter a name and an http/https URL under Web apps, then choose Install web app. Saved apps appear on Home and in the launcher. Each opens an independent native website view without browser controls and supports workspaces, iPad tiling, and Expo. Tapped web links, including external links requesting a new tab or window, open in that same view; native back/forward gestures return through its browsing history. Remove an installation from Settings; closing its Expo card only closes the running view. Installations are shared by all devices connected to the host. Installing pins the app on the current device; other devices can find it in the launcher and choose their own pins. Uninstalling removes it from the host catalog for every device. Website login sessions stay on each device, and web apps do not sync navigation to desktop tabs.

⌘Return opens or focuses Terminal without creating another tab. ⌘T adds a tab in the active app, including Terminal and Browser; it no longer launches Terminal from other apps.

## Saved settings and device backups

Settings → This device offers **Focus follows pointer** (off by default). In desk mode, moving a mouse or trackpad pointer over a window focuses it for keyboard input. Touch, dragging, Expo, and open dialogs do not change hover focus. The preference is saved and backed up per device. Embedded Browser and web-app hover is supported on Android and requires native build 29 or later on iPad/iPhone. Native website hover is disabled on visionOS so looking at a window cannot steal focus.

Settings → This device lets you name the device, back up now, or restore another device’s backup. Themes, wallpaper choices, Home pins, widgets, app preferences, and window arrangements stay independent on each device. Local changes save immediately and retry their host backup after reconnecting. Herd message drafts save on every edit, separately for each pane, and reappear when you return after a reload or app restart. Drafts stay on the local device and are excluded from host settings backups; sending or deleting the text clears that draft. A storage failure displays a warning while keeping the text in the composer. Open windows can be restored, but a terminated host terminal process is not recreated with its old contents.

The native shell uses persistent website storage plus a native preferences mirror shared with its bundled offline copy. Website cookies use a separate on-device store and are never included in host backups. A new device downloads the host’s web-app catalog and starts with its own preferences; restoring an existing device backup is an explicit choice. Existing local web apps migrate into the shared catalog on connection. Settings that an older, temporary-storage build already lost cannot be recovered unless it had time to back them up.

The Rust backend stores the catalog and per-device backups in `settings.sqlite3` under its application data directory (`$XDG_DATA_HOME/omarchy-remote`, or the standard user data directory). Include this database in host backups; use SQLite’s backup API for a consistent copy while the service is running. The schema is versioned, updates use revision checks, and deleted web-app records prevent stale devices from reinstalling removed apps during migration. Browser tests isolate these APIs so they do not create records in the live catalog.

## Browser navigation and keyboard

Browser reopens the last viewed HTTP(S) tab on this device if it is still in the desktop snapshot. The saved selection uses the extension's stable profile ID across bridge reconnections. A closed or internal tab falls back to the tab manager; a disconnected profile keeps its selection for reconnection. The back chevron in Browser opens the tab manager explicitly. In its search field, Return opens the first matching web tab. Website navigation still updates the selected desktop tab's URL.

When Browser is active, its keyboard commands handle tab and page actions. ⌘W always closes the focused shell window; ⌘⇧W closes only the current browser tab. The `⌘ /` shortcut list includes Browser commands. Clipboard and website text editing stay native. Find uses WebKit’s native search panel, keeping the query and match navigation in the website’s own view.

| Keys                                          | Action                                                          |
| --------------------------------------------- | --------------------------------------------------------------- |
| ⌘ L                                           | Select address; in the manager, search tabs                     |
| ⌘ ⇧ L or F2                                   | Open and search the tab manager                                 |
| ⌘ T / ⌘ N                                     | Create a desktop tab / window (enter its URL)                   |
| ⌘ ⇧ W                                         | Close the current desktop tab and select the next available tab |
| ⌘ ⇧ T                                         | Reopen a tab closed here, restoring its URL                     |
| Ctrl Tab / Ctrl ⇧ Tab, Ctrl PageDown / PageUp | Next / previous openable tab across profiles and windows        |
| ⌘ ⌥ → / ←                                     | Next / previous openable tab                                    |
| Ctrl 1–8 / Ctrl 9                             | Numbered tab / last openable tab in the current desktop window  |
| Ctrl [ / ]                                    | Page back / forward                                             |
| ⌘ R / ⌘ ⇧ R, F5 / ⇧ F5                        | Reload / reload bypassing cache                                 |
| Ctrl F, ⌘ G / ⌘ ⇧ G, F3 / ⇧ F3                | Find in page, next / previous match                             |
| Ctrl + / − / 0                                | Page zoom in / out / reset                                      |
| Escape                                        | Dismiss dialog/find/options, otherwise stop loading             |
| ⌘ W / ⌘ F                                     | Close Browser's shell window / toggle its fullscreen layout     |

Shell shortcuts keep the same meaning inside Browser: ⌘numbers switch workspaces, ⌘brackets switch adjacent workspaces, ⌘Return opens Terminal, ⌘F toggles fullscreen, and ⌘⇧F opens Files. Browser actions use separate Control chords where Command would conflict. These non-conflicting native shortcut registrations require build 28 or later. These commands operate the embedded WebKit page or the desktop tab adapter; they do not reproduce Vivaldi-only features such as panels, bookmarks, command chains, or DevTools. Reopening a tab restores its URL, not its old page history or form state. The last tab and the last 20 tabs closed here are stored locally and included in the native local preferences mirror, not the shared installed-app catalog.

## Native iPhone, iPad, and Vision Pro app

`ios/OmarchyRemote.xcodeproj` is a UIKit/WKWebView wrapper for iOS 18 or later and native visionOS with the shared **OmarchyRemote** scheme and automatic development signing. It hides the status bar, defers the system edge gestures so the shell's swipes work, registers native iPad key commands and routes them to the shell, adds a Core Location bridge for the weather widget, and opens browser pages in an isolated WKWebView inside the themed Browser window.

The native visionOS destination uses the same shell in a freely resizable window, initially 1280×900 points with a 600×400 minimum. Width and height resize independently, and the shell remains in desktop mode even in a short window. VisionOS supplies the system window controls; the shell’s iPhone home indicator is hidden there. The native Vision Pro build replaces the earlier iPad-compatible installation using the same bundle identifier.

Before building, create `ios/Local.xcconfig` (ignored by git) and set three values in it: `OMARCHY_REMOTE_URL` (your HTTPS address followed by `/native/`, written as `https:/$()/host:12443/native/` because `//` starts a comment in xcconfig files), `DEVELOPMENT_TEAM`, and `PRODUCT_BUNDLE_IDENTIFIER` under a domain you control. The committed `ios/Config.xcconfig` holds the placeholders and includes your local file, so the Xcode project itself needs no edits. The configured URL seeds the device’s initial saved host. Both Debug and Release builds load the selected host and fall back to the bundled offline copy if it is unavailable. If iOS terminates the shell’s web-content process, the app recovers automatically, deferring recovery until foreground when necessary. Repeated process failures are bounded before showing a manual retry. The offline copy preserves local settings and drafts, retries the host on foreground, and checks every 15 seconds while active without replacing the offline page on failed checks. Terminal output, agents, and other host-backed functions still require a connection. The offline status also offers a manual Retry live button. Every build runs `scripts/prepare-native.py` to package `public/` into the app. Hold two fingers on the screen for about a second to switch between the live and bundled sources or reload.

Build from Xcode with a paired device, or headlessly with `xcodebuild` and the OmarchyRemote scheme. `python -m unittest discover -s scripts -p 'test_native_bundle.py'` checks the packaging; `python scripts/prepare-native.py` writes an inspection copy to the ignored `ios/Generated/Web`.

## Adding your own app

Apps are self-contained: one `define(...)` line in `public/apps.js`, one module in `public/` that calls `HyprlandApps.provide(key, {create, close})`, and, for terminal programs, one row in the `TUIS` table of `backend/src/apps.rs`. Workspaces, Home pins, the launcher, Expo cards, desk tiles, and keyboard routing come from the catalog automatically. [CONTRIBUTING.md](CONTRIBUTING.md) walks through it, including the tests to extend.

## Development

Development live reload polls source metadata every 750 ms and regenerates the native bundle before notifying connected devices. This also detects atomic editor saves and replaced directories. Restart `omarchy-remote-dev.service` after changing server or reload-client scripts.

The user service `omarchy-remote-dev.service` watches `public/` and reloads every connected shell within about a second of a save, including the native app when it is on the live source; host sessions reconnect. Restart that service after changing `scripts/serve.mjs` or `scripts/live-reload.js`. Rust changes need `cargo build --release --manifest-path backend/Cargo.toml` and a restart of `omarchy-remote.service`, which ends its PTYs.

```sh
systemctl --user status omarchy-remote-dev.service omarchy-remote.service
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

To remove the setup: `systemctl --user disable --now omarchy-remote-dev.service omarchy-remote.service`, delete the unit files, and drop the HTTPS listener (`tailscale serve --https=12443 off`).

## License

[MIT](LICENSE).

Desk windows support draggable dividers, Command + left-drag to swap tiles, and
Command + right-drag to resize (Ctrl+Alt in a Linux/Windows browser). Settings →
This device → Window layout selects Dwindle, the Omarchy default, or Master and
stack. Layout and split sizes are saved per device. Toggle active split changes
Dwindle's split direction; focused dividers accept arrow keys and double-click resets
a split to equal sizes. Embedded website modifier drags require native build 30.

In desk mode, Command+Shift+P returns to the previous workspace, Command+Shift+X
moves the active window to the next workspace without following it,
Command+Shift+Y toggles the active Dwindle split, and Command+Shift+U cycles layouts.

Command+Shift+K opens a searchable action palette. Type an action name, use arrows
to select, and press Return. The shared registry supplies native keyboard commands,
shell actions, and Browser shortcuts; the existing Command+/ help remains available.
Native build 31 is required for registry-driven hardware shortcuts.

Command+Shift+S sends the active desk window to the scratchpad. Command+S shows or
hides it on the current workspace without closing it; Command+Shift+S returns it to
tiling. Command-drag moves the floating scratchpad, and Command+right-drag resizes it.

The action palette can create **New terminal window** and **New files window**.
Each window has its own state. **Group window with next tile** combines tiles into
a tabbed group; **Remove window from group** separates the active tab. Group tabs,
independent windows, and their selected state are restored with the device layout.

**Scrolling columns** is the third Window layout option. Columns start at 49% of
workspace width, matching Omarchy's configured scrolling width. Focus commands
reveal their column, dividers resize individual columns, and the bottom scroll
strip pans across the workspace with touch or a trackpad. Window content keeps its
width while panning. Dwindle remains the default.

**Command+Shift+O** toggles the active desk window between tiled and floating.
Floating windows stay on their workspace, remember their bounds per device, and
come forward when focused. Command-drag moves them; Command+right-drag resizes them.

**New browser window** in Search actions creates another independent Browser pane
(native build 33 or later). Each remembers its own desktop tab and navigation;
website logins remain shared on the device.

**Command+Option+Shift+arrow** resizes the active window in 25-point steps: left/up
shrink width/height, right/down grow them. No divider focus is needed. These actions
also appear in Search actions and work with tiles, floating windows, and scratchpad.

**Settings → Keyboard shortcuts** lets you search actions, record a replacement
shortcut, disable a binding, or restore defaults. Shell and Browser bindings are
checked together for conflicts. Changes save per device and update keyboard help,
the action palette, and native registrations immediately (build 33 recommended).

### Publish a native build for remote installation

The existing private HTTPS app host also serves `/builds/`: a simple download dashboard with the latest build, notes, older builds, and platform-specific downloads. For iOS, use the **Install on device** link in Safari with Tailscale connected. This works away from home without opening a public port. Devices must already be covered by the provisioning profile and have Developer Mode enabled. Website installation uses an HTTPS manifest; verify acceptance on the device separately from download availability ([Apple's manifest documentation](https://support.apple.com/guide/deployment/depce7cefc4d/web)).

After validating a signed iOS IPA on the Mac, publish its exact bytes:

```sh
python scripts/publish-native-build.py /path/to/App.ipa \
  --base-url "${OMARCHY_DOWNLOAD_BASE_URL}" \
  --commit <source-commit> \
  --notes 'What changed in this build'
```

Set `OMARCHY_DOWNLOAD_BASE_URL` to your private app HTTPS URL plus `/builds` (no trailing slash required). The publisher reads the actual version, build, device families and profile expiry from the IPA, checks its CMS envelope and refuses expired profiles. It does not replace Mac code-signature validation. Downloads stay in `~/.local/share/omarchy-remote/builds`, outside the checkout, with SHA-256 identities and no automatic pruning. To move that directory, set `OMARCHY_BUILDS_DIR` identically for the publisher and dev service. Publish each new signed build with its source revision and notes; no service restart is needed to update the page. Changing the download host requires regenerating manifests for retained builds by publishing those IPAs with the new base URL.

The portable publishing skill is included at [`skills/omarchy-builds/SKILL.md`](skills/omarchy-builds/SKILL.md) and downloadable from the dashboard. Copy that folder into your agent's skills directory, such as `~/.codex/skills/` or `~/.claude/skills/`. It uses this checkout's publisher and your host configuration; it contains no fixed host or signing identity. The server is read-only: agents publish locally on the host or over the user's existing SSH connection, rather than exposing an upload API.

Open **Builds** from the app launcher, or pin it through Home’s app picker. A new host starts with a welcome screen and a **Get the agent skill** link; once an agent publishes a build, the app displays the host’s build history. iOS native build 37 and later provides **Install** on each build, handing the request to iOS for confirmation. Older native versions retain **Copy dashboard link** for installation in Safari. An accepted handoff is not proof of completed installation. No native binary update is needed for the Builds app itself when using the live host.

### Android development (parity work in progress)

`android/` builds an Android 11+ native host for the same shell and backend. The initial implementation includes trusted shell messaging, saved hosts and preferences, native keyboard/battery integration, device weather location, Android file upload/save pickers, and independent browser WebViews. Android Back dismisses the keyboard and shell overlays before navigating an embedded website; at the root it backgrounds the task. An unreachable host falls back to bundled UI at the same origin and retries automatically while foregrounded; returning to the app also prompts reconnection. Full iPhone feature parity is **not yet verified**; [the Android parity checklist](docs/android-parity.md) tracks the remaining work.

With JDK 17+ and Android SDK platform/build-tools 36 installed, create an ignored `android/local.properties` containing your `sdk.dir`, then run:

```sh
cd android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The app starts with its saved-host picker. For emulator development against this checkout’s running host server, forward its port and provide the development URL at build time:

```sh
adb reverse tcp:4187 tcp:4187
./gradlew :app:assembleDebug -PremoteUrl=http://127.0.0.1:4187
```

Debug builds permit loopback HTTP; release builds require HTTPS. Never disable certificate verification for a private host. `-PapplicationId=…` selects an installation identity when needed. Debug WebViews expose Chrome DevTools through ADB; `scripts/android-cdp.mjs` can inspect a forwarded shell target. External websites do not receive the privileged shell message bridge. With the debug app running on a phone-sized emulator, `node scripts/android-browser-smoke.mjs` checks native browsing, history, Find, full-page zoom, dark mode, keyboard focus, shortcut delivery, and clipboard editing against an isolated local fixture. With a hardware keyboard, embedded Browser and saved web-app views follow the active window automatically. Android page zoom scales document content from 25% to 500% and survives reloads; it uses CSS zoom, so viewport media-query breakpoints remain unchanged. `node scripts/android-terminal-smoke.mjs` tests immediate typing after launch, using only new terminal sessions and closing them without executing the typed text. Close existing emulator Terminal windows first. For a tablet-sized viewport, `node scripts/android-tablet-smoke.mjs` checks tiling, divider dragging, and typing after window/workspace shortcuts; start with only Home open. Set `ANDROID_SERIAL` if more than one emulator is running; `ADB` can override the adb executable path.

Android updates use the same publisher: pass a signed `.apk` instead of an `.ipa`, with `ANDROID_HOME` pointing to the SDK. The publisher runs `apksigner verify` and records Android package, version, minimum API, and signing certificates. APKs and IPAs can coexist in the catalog; native Builds shows the current device’s platform. Android’s **Install** downloads and checks the APK, then opens the system installer. On first use, allow this app as an installation source in Android settings, return, and tap Install again. A download or installer handoff does not prove successful installation.

Use the same signing key for updates and increment Gradle `-PversionCode=…` (with optional `-PversionName=…`). Current debug artifacts use development signing; [release signing](docs/android-signing.md) uses your own durable key supplied through private environment variables. `node scripts/android-update-smoke.mjs` uses a temporary emulator host to test checksum rejection, installation permission, cancellation, and an actual update from the current APK; it restores the original host afterward. It installs only onto an emulator, and the APK must have this debug app’s package/signing identity and an equal or newer version.

Android message entry uses native keyboard insets so the composer stays above the software keyboard even when the WebView viewport does not shrink. Message-mode Ctrl+A/C/V/X/Z/Y edit the local draft; direct-key mode retains terminal controls. Sending dismisses the software keyboard, including when a hardware keyboard is connected. `node scripts/android-herdr-smoke.mjs` creates two isolated Herdr workspaces, checks drafts, clipboard editing, image upload and process-death recovery, sends only to its own shell, and removes its fixtures. Start with only Home open in the phone-sized emulator. `ANDROID_TOUCH_IME_QA=1 node scripts/android-herdr-smoke.mjs` checks actual English Gboard key taps and its Send action on the 1080×2400, density-420 emulator, including trusted input events, host output and keyboard dismissal. Autocorrection and composition across languages still need additional coverage.

The Android native browser smoke test also launches isolated Terminal shells directly from a focused website and types immediately, checks that page input receives no stray characters, and verifies inline new-window navigation with session-cookie retention. It closes its own shells without executing the typed text and does not change desktop tabs. Close existing emulator Terminal windows before running it.

`node scripts/android-files-smoke.mjs` verifies native multi-file selection, upload cancellation, and saving a selected ZIP back to Android Downloads with exact content checks. It uses a temporary host folder and uniquely named device files, removes them afterward, and requires only Home open in the phone-sized emulator.

On Android, **Save…** offers **Save to device** or **Share…**. Sharing opens the system share sheet with read-only access to a private cached copy. A successful handoff does not confirm that another app sent or stored the file. Copies older than a day are cleaned up at a later app startup.

For native sharing QA, build the optional receiver with `android/gradlew -p android :qa-share-receiver:assembleDebug -PwithQaReceiver`, then run `node scripts/android-share-smoke.mjs`. The script installs a local-only receiver, shares generated bytes through the real chooser, checks file metadata, bytes and denied write access, tests cancellation, and uninstalls the receiver. This receiver is excluded from normal app builds.

`ANDROID_BROWSER_QA=1 npm run test:browser-adapter` extends the isolated Vivaldi test through the installed Android emulator: it temporarily connects to a browser-only test host, opens a real desktop tab in the native page view, follows a link and verifies desktop URL synchronization, and closes the desktop tab with the native shortcut. It also checks host-address rejection, disconnect/restart/reconnect, and host-scoped preferences, then restores the original host. Start with only Home open and at least one free saved-host slot. The temporary proxy blocks all non-browser APIs, and the test never uses the existing desktop browser profile.

Hardware keyboard activation uses the themed window border as its focus indicator. App containers do not add a second browser-default outline; individual controls keep their own focus styling.

`node scripts/android-tls-smoke.mjs` uses a temporary HTTPS server with an untrusted certificate. It adds the host through Android’s native dialog, verifies that the page/API/retry paths never reach that server, and checks the bundled shell, host picker, and scoped offline preferences. It restores the original host and deletes its temporary certificate; it never installs a CA or changes the emulator’s trust settings. Start with only Home open and one free saved-host slot.

`node scripts/android-webapps-smoke.mjs` verifies saved web apps in the installed emulator using an isolated in-memory catalog. It checks install/uninstall, inline new-window links, Android Back, and session cookies and local pins/catalog after process death with catalog access disabled. It restores the original host and never writes to the live catalog. Embedded websites use a white default canvas; authored page backgrounds and forced dark mode still control their own appearance.

For tablet browser geometry, configure the emulator to 1280×800 at density 160 and run `ANDROID_TABLET_WEBAPPS_QA=1 node scripts/android-webapps-smoke.mjs`. It installs two isolated web apps, tiles and resizes them through native shortcuts and a divider touch drag, compares each actual page viewport with its shell tile, checks Expo previews and restoration, then runs the saved-app lifecycle checks. Restore the emulator's original size and density afterward.

The Herdr emulator check also runs at 1280×800/density 160. It waits for settled keyboard geometry and records `artifacts/android/tablet-herdr-input.png` plus measured bounds, verifying the composer stays above the IME and leaves at least 100 CSS pixels of terminal output. Its normal draft, clipboard, attachment, restart and Send checks then run unchanged. Restore the emulator's original size/density after tablet testing.

Signed Android release builds are configured through private environment variables; see [Android release signing](docs/android-signing.md). `python scripts/android-release-smoke.py` verifies two signed versions, native release launch and an in-place update under a separate emulator identity without changing the regular app's data.

Android shortcut hints use `Ctrl+Alt` for supported plain Meta/Command aliases. Combinations that also require Ctrl or Alt show the physical `Meta` key explicitly—for example, `Meta+Ctrl+1–0` switches saved hosts. The host picker, launcher and shortcut help use platform-appropriate labels.

Host navigation also saves the departing host’s final device-settings snapshot before replacing the shell, without waiting for the periodic preference mirror.

Android remembers the browser’s forced Dark preference on the device. Newly opened browser and saved-app views inherit it after relaunch, and the browser menu reflects the restored setting.

Android takes native shell focus at the start of a touch gesture, preserving the launcher search field for immediate typing after a swipe. Unmodified Escape is delivered to the active app before the input method can consume it; Android Back remains available to dismiss the software keyboard.

Android weather units follow the device’s regional temperature preference, including explicit Celsius/Fahrenheit overrides, with locale defaults when no override is set.
