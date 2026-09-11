# Hyprland Touch PWA

An installable version of `Hyprland Touch Prototype.html`, the original Claude Design export. The original export is preserved unchanged. The runnable source is `public/index.html`; it retains the exported design runtime and interaction logic, with the decorative phone frame removed and local fonts and React dependencies.

## iPhone

Open the deployed HTTPS URL in Safari, sign in if prompted, then Share → Add to Home Screen. Leave **Open as Web App** enabled if shown. Launch Hyprland from its new icon. Open it online once to install the offline cache.

Start edge gestures inside the app's visible content, above the home indicator and below the system status area. Left/right edges switch workspaces. Swipe down from the top left/middle/right for notifications/launcher/quick settings. Swipe up from the bottom corners (outer 15% each) for keyboard/SUPER keyboard; the middle 70% opens expo. Tapping the active workspace pill also toggles expo.

This is a simulated operating system UI. Apps, Wi-Fi controls, agents, weather, time, and battery values are mock data; they do not control iOS. Terminal and Herdr connect to HOST as described below. Shell UI workspace state resets when the page reloads. A PWA cannot defer iOS system gestures; use the native app below for that experience.

## Native iPhone app

`ios/HyprlandTouch.xcodeproj` contains a UIKit/WKWebView app with the shared **HyprlandTouch** scheme. It supports iPhone on iOS 18 or later and uses automatic development signing. The bundle identifier is `com.example.HyprlandTouch`.

Debug builds now load the live prototype from **https://your-host.your-tailnet.ts.net:12443/native/** by default. Connect Tailscale on the iPhone, then open Hyprland. If HOST is unreachable, the app loads its bundled offline copy and shows **Offline copy · Retry HOST**. It also retries when returning to the foreground. Release builds use the bundled copy only. Every build runs `scripts/prepare-native.py` to package the current `public/` files into `HyprlandTouch.app/Web` and convert root-relative asset URLs for file loading. `ios/WebOverrides/native.css` removes outer safe-area padding and arranges the custom status widgets beside the Dynamic Island. The hosted PWA remains separate; native live pages disable service-worker caching.

The root controller hides the iOS status bar, pins the web view to all four view edges, disables automatic scroll insets, and requests top/bottom system-gesture deferral. Start the prototype's swipes at the display edge. iOS retains the escape gesture; a repeated edge swipe can invoke the system. The home indicator remains system-controlled and is intentionally not set to auto-hide while bottom gesture deferral is active. The camera cutout is physical and remains visible.

On a Mac, select the scheme and a paired iPhone to build and run. From HOST, use the headless remote-Xcode workflow; this checkout selects the Mac and syncs to `/Users/user/.cache/xcode-fleet/worktrees/OmarchyRemote-8ea169afb99d`. The phone must be reachable from that Mac, with Developer Mode enabled and development signing trusted. No App Store or TestFlight upload is needed for direct development installation.

Run `python -m unittest discover -s scripts -p 'test_native_bundle.py'` to check native asset packaging. `python scripts/prepare-native.py` also generates a local inspection copy in ignored `ios/Generated/Web`.

## Terminal and Herdr

Terminal opens a real interactive HOST shell through the shared Rust backend. Tap its output to open the system keyboard. **Keys** mode sends input immediately, with autocorrect disabled for commands and paths. The shortcut row appears only in Keys mode and provides Esc, Tab, arrows and Ctrl; Ctrl applies to the next letter. The shell survives live reload and reconnection; `exit` ends it, then **New shell** opens another.

Herdr shows the local running Herdr's workspaces, agents, statuses and panes. Workspace/tab ordering follows Herdr Mobile's priority groups: needs attention, working, done, idle, then unknown. Recent Herdr activity sequences break ties before desktop tab order; panes within a tab sort by activity. No per-pane revision counters are used as cross-pane recency. Tap a pane to view live ANSI output. Tap the output to open **Message** mode: edit a local draft using the iPhone's predictions, autocorrect, dictation or swipe typing, then tap **Send** or Return to send it with Enter. Switch to **Keys** for immediate input to interactive programs. Drafts stay with their pane while switching panes, but do not survive a page reload. The back chevron returns to all panes. Existing panes are not focused/resized on the desktop. No input is replayed after a disconnect.

Both output views use native browser overflow scrolling, including smooth pixel movement and the system's momentum. **Fit** is enabled by default in Herdr and wraps output at word boundaries without changing the desktop pane. Tap it for **Original** when reading tables or terminal layouts that need horizontal scrolling; the choice is saved. **↓ Latest** sits beside Message and the keyboard-dismiss arrow while typing, and floats over the output when the keyboard is hidden. It returns to live output; direct typing and sending a message also follow it. Keyboard resizing preserves the prompt at the bottom, or your history position when reading older output. Hide the keyboard with **⌄**. Native build 4 removes the web view’s extra Previous/Next/Done keyboard bar; Apple’s typing suggestions remain available. The original custom keyboard remains available for the launcher and SUPER shortcuts.

Both apps need HOST. If the backend or Herdr is unavailable, the app shows a connection error and retries. The native bundled offline UI cannot connect to these local APIs. Other OS mockup apps remain simulated.

The enabled **omarchy-remote.service** runs one Rust host backend, with separate Terminal/Herdr adapters and shared transport for future apps. See [backend architecture and API](backend/README.md). Restarting the Rust backend ends its shells; reloading HTML preserves them. Herdr sessions are owned by Herdr and survive a backend restart.

## Development

The HOST development server is already running as the enabled user service `hyprland-touch-dev.service`. It survives this session and restarts after failure. Tailscale Serve exposes it privately on HTTPS port 12443; its HTTP listener binds only to `127.0.0.1:4187`.

Edit **`public/index.html`** for the prototype's markup and interaction logic, **`public/pwa.css`** / **`public/pwa.js`** for shared layout and behavior, and **`ios/WebOverrides/native.css`** for native-only layout. Saves trigger a full page reload in connected apps, usually within a second. A reload resets the shell UI's in-memory workspace state; the real terminal session and selected Herdr pane reconnect. Reconnection and foregrounding compare the current server version so changes made while the app was suspended are picked up too. No iPhone rebuild or reinstall is needed for these web changes; Swift changes still require one.

Hold **two fingers for about a second** to open the native source menu: **Live from HOST**, **Bundled offline copy**, or **Reload**. Choosing the bundled source persists until you select live again.

Useful commands:

- `systemctl --user status hyprland-touch-dev.service`
- `systemctl --user restart hyprland-touch-dev.service` after changing server code in `scripts/serve.mjs` or `scripts/live-reload.js`
- `journalctl --user -u hyprland-touch-dev.service -f`
- `npm run test:live` with the development server running
- `npm run build && npm test` for the standalone PWA

The service definition is tracked in `deploy/hyprland-touch-dev.service`. Local development requires Rust/Cargo, Node (with recursive `fs.watch` support), and Python 3. The Rust API occupies port 4188; the preview/proxy uses 4187. For a separate foreground preview, use `PORT=4190 npm run dev`; the app's configured Tailscale address continues to use the persistent service on 4187. `GET /__dev/status` reports the current revision and live connection count; `/__dev/events` is the reload stream. No public hosting or ChatGPT sign-in is involved in this loop.

To remove the background development setup: stop and disable `hyprland-touch-dev.service`, then remove only its Tailscale listener with `sudo tailscale serve --https=12443 off`. Other Tailscale services are independent.

`scripts/build.mjs` produces a portable Cloudflare Worker in `dist/server/index.js`, static files in `dist/client`, and a content-versioned service worker. The worker embeds the small static asset set, so no external asset binding is required. The service worker caches only known app files, rejects redirected install responses, and activates a new version after old app windows close. Close all app windows and reopen to pick up an update.

The Sites project ID is in `.openai/hosting.json`. Use the Sites packaging and publishing flow for PWA deployment. The native app is built and installed separately.

## Validation

Automated checks cover manifest and icons, all precache URLs, offline shell delivery, and HTTP routing. The exported React runtime and launcher/settings/map/reset controls were also exercised in a DOM environment without runtime errors. Native simulator results are recorded in `ios/VALIDATION.md`.

Theme selection lives in Settings and persists on the device (`omarchy-theme`).
The shared CSS tokens also drive the launcher, custom keyboard, Terminal and Herdr;
ANSI indexed colors update immediately, while explicit RGB output retains the host
application's colors. Web controls follow the palette’s light/dark color scheme; the installed native
wrapper still requests a dark iOS keyboard.
The portable catalog includes all 22 installed Omarchy palettes plus the original
prototype. Refresh it with `python scripts/import-themes.py`; stock palettes come
from `/usr/share/omarchy/themes`, with `~/.config/omarchy/themes` overlays applied.
This copies color definitions only and does not change HOST's desktop theme.

Startup opens Home only. In Expo, swipe an app card upward to dismiss it, or hold
for about half a second and drag it to another slot to reorder workspaces. Home
stays first and cannot be dismissed. Short swipes snap back; a cancelled reorder
restores its original order. Workspace order lasts for the current page session.
Closing Terminal terminates its app-owned HOST shell; reopening starts a new shell.
Closing Herdr disconnects the phone view and leaves desktop panes and agents running.

Home widgets use `/api/widgets` on the shared Rust backend. One sampler reads Linux
CPU/memory counters, the default-route interface's traffic rates, root-filesystem
usage, uptime and CPU temperature (when available) every three seconds. Tailscale
status and peers refresh every fifteen seconds. The widget describes HOST's VPN
state, not the phone's. The sampler requires the existing `df` and `tailscale` CLIs.

Weather uses Open-Meteo's geocoding and forecast APIs via the backend's `curl`
client, with fixed upstream URLs, timeouts and a bounded fifteen-minute forecast
cache. Choose a city in the weather card; location and Celsius/Fahrenheit preference
are saved per device. Forecast hours use the selected city's timezone. Home/status
clocks use the phone's local time and date. Polling pauses when the page is hidden
or Home isn't active, and connection failures show unavailable/stale states.

Weather location can also use the target icon beside city search. Native build 5
adds a one-shot Core Location bridge, city-name lookup and when-in-use permission;
only city-level coordinates go to HOST/Open-Meteo. Saved phone location refreshes
with foreground weather requests after fifteen minutes. Permission denial keeps
manual city search available. Automatic temperature units use iOS's preferred
`UnitTemperature(forLocale:)`; PWA mode uses CLDR region defaults. Manual °C/°F
overrides and an Automatic option remain available in the location dialog.

CodexBar is sampled separately every five minutes using the installed CLI, with
Codex's automatic source and Claude's read-only OAuth source. Only provider names,
usage windows and reset timestamps reach the phone; account identities, credentials
and credit/reset actions are excluded. Missing limits are not treated as 100% free.

Long-press a Home widget (or tap its manage icon) to open the widget overview.
Drag after a short hold to reorder, swipe up or tap × to remove, and use the library
to add widgets back. Enabled widgets, order and the selected page persist per phone.
An empty deck keeps an Add Widgets button available. Removing a widget changes
Home's layout without changing the host service or any provider subscription.

Herdr’s paperclip opens the iPhone image picker (or accepts pasted images). PNG,
JPEG, GIF, WebP and HEIC/HEIF files up to 10 MiB each upload through the shared
backend to `~/.local/share/omarchy-remote/uploads/` on HOST. Files have private
permissions and are retained until removed on the host; they are not web assets.
Each attachment appends `Image: /absolute/host/path` to the original pane’s draft,
even if you switch panes during upload. Review the draft and press Send to submit;
uploading never sends terminal input automatically. Drafts remain in memory only.

Files browses the HOST home directory with breadcrumbs, grouped folder/file rows,
extension badges, and real metadata. Search names in the current folder, contents
below it, or names/contents across HOME. The menu also offers a fuzzy finder with
recent files and home/git/config shortcuts. Search supports case, hidden files,
regex and glob filters. Searches are bounded and report when results are limited;
`.git`, `node_modules`, `target`, and `.cache` trees are skipped.

Tap a file for an image or syntax-colored, line-numbered text preview. The file
menu toggles wrapping. Edit saves UTF-8 text on HOST and detects external changes
before replacing a file, retaining the draft on conflict. Terminal here opens a
shell in that folder after confirming replacement of the app-owned Terminal.
Text preview/edit is limited to 1 MiB; transfers and images to 25 MiB each.
On iPhone, Save… opens the iOS share sheet; choose Save to Files and a destination.

Select or long-press a folder row to enter selection mode. Select all, invert,
or use a wildcard pattern; then download a ZIP, move, copy, rename one item, or
send items to the recoverable host Trash. Selection supports up to 100 items.
Copy/archive are limited to 25 MiB and 10,000 entries per tree (ZIP also limits
total output); symlinks and special files are rejected for these operations.
Existing destinations are never replaced. New creates folders or empty files;
Upload uses the phone picker and keeps its original target folder after navigation.

The last folder and recent paths are remembered. Access stays inside HOME;
external symlinks and the backend proxy-secret file and its aliases are excluded.
Operations cannot move the home directory or ancestors of the proxy-secret file.
Phone, the placeholder browser, and inactive Home app pages have been removed.

btop is a standalone launched app with its own Home tile, workspace and Expo card.
The shared backend starts `/usr/bin/btop` directly in a separate PTY, using its own
config at `~/.local/share/omarchy-remote/btop.conf`. It resumes across web reloads;
tossing its Expo card stops only that monitor session. Touch buttons toggle btop's
CPU, memory, network and process panels. The default view fits its 80-column layout;
Larger restores readable terminal sizing with horizontal scrolling. Tap the output
for native keyboard controls. Terminal sessions remain separate.
The btop view maps its terminal colors to the selected phone theme: a transparent
monitor background, accent box borders, semantic graph colors and readable text
in light/dark themes. This presentation updates immediately when changing themes;
Terminal and Herdr retain the colors emitted by their host programs.

## Services

The **services** launcher tile runs systemctl-tui in its own persistent host session,
with phone-theme colors and a 64-column Fit view. Use ↑/↓ to navigate, **Select**
to open or choose an action, **Back** to dismiss, and **Search** to filter with the
phone keyboard. **Filter** opens status filters; **Help** shows the TUI shortcuts.
**Larger** increases text size with horizontal scrolling. Service logs appear beside
the selected unit. Both system and user units are shown, using the host user's
existing permissions. Closing its Expo card ends only the Services viewer.

The backend dependency is systemctl-tui 0.7.0, installed using
`cargo install systemctl-tui --version 0.7.0 --locked`.

## Docker, disk usage, and logs

**lazydocker**, **dua**, and **lnav** launch as independent apps. Each has theme
colors, Fit/Larger sizing, touch navigation, native keyboard input, and its own
reconnecting PTY. Closing an Expo card ends that viewer.

- Lazydocker opens the host Docker context. Panel switches sections, Open focuses
  details, Tab switches detail tabs, Menu exposes available actions, and Search filters.
- Dua scans HOME using two threads and stays on the current filesystem. Open and
  Up folder navigate directories; Panel switches panes, and Help lists cleanup keys.
- Lnav follows the last 1,000 accessible journal entries and new host logs, with
  a Wrap control for long lines. Search, page navigation, Latest, and Help are available.
  Other log files can be opened through lnav's `:open` command using the keyboard.

HOST uses `/usr/bin/lazydocker`, `/usr/bin/dua`, and
`~/.local/bin/lnav` (official standalone lnav 0.14.1 Linux x86_64 release).

Browser mirrors Vivaldi windows, workspaces and tabs through a companion extension.
It supports desktop tab close/create, window moves, pin/mute, reload and focus.
Opening a tab loads its URL on the phone in an isolated native Safari view (build7+);
phone logins remain separate from desktop Vivaldi. Closing the native page returns
to the tab manager; its × button closes the actual desktop tab. Tossing Browser
from Expo does not close desktop tabs. Vivaldi8 workspace groups come from saved
metadata and may lag briefly; workspace reassignment is unavailable when its
extension API hides those fields. See [browser setup](browser-extension/README.md).
