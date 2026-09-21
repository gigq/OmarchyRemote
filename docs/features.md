# Feature reference

What each app in Omarchy Remote does and the limits it enforces. "The host" is the machine running the backend; its name appears in every status line from `OMARCHY_HOST_NAME`.

## Terminal

Terminal opens a real interactive login shell on the host through the Rust backend. Tap its output to open the system keyboard. **Keys** mode sends input immediately, with autocorrect disabled for commands and paths. The shortcut row appears only in Keys mode and provides Esc, Tab, arrows and Ctrl; Ctrl applies to the next letter. The shell survives live reload and reconnection; `exit` closes that shell tab; closing the last tab closes the Terminal window. Closing Terminal from Expo terminates its app-owned shell; reopening starts a new one. Files can open a shell in the current folder after confirming replacement of the app-owned Terminal.

⌘Return opens or focuses Terminal; ⌘T adds a tab in the active app (Terminal or Browser), rather than launching Terminal. Terminal input receives focus immediately, and keystrokes typed during its initial connection are held until the shell is ready. With a hardware keyboard, the active window’s input stays enabled across window/workspace changes and closing another window. Native build 36 restores the WebKit text-input session through a native-initiated focus call; callbacks for a window that is no longer active, a dismissed input, or an open overlay are rejected. This applies to Terminal and herdr’s selected pane through the shared input bridge.

## Herdr

Herdr shows the local running Herdr's workspaces, agents, statuses and panes. Workspace and tab ordering follows Herdr Mobile's priority groups: needs attention, working, done, idle, then unknown. Recent Herdr activity sequences break ties before desktop tab order; panes within a tab sort by activity. Tap a pane to view live ANSI output. Tap the output to open **Message** mode: edit a local draft using the phone's predictions, autocorrect, dictation or swipe typing, then tap **Send** or Return to send it with Enter. Switch to **Keys** for immediate input to interactive programs. Drafts are saved locally per agent thread and survive switching panes, reloads, and app restarts. The back chevron returns to all panes. Existing panes are not focused or resized on the desktop. No input is replayed after a disconnect. Closing Herdr disconnects the phone view and leaves desktop panes and agents running; Herdr sessions are owned by Herdr and survive a backend restart.

Herdr's paperclip opens the phone file picker (photos or any file from Files, such as a ZIP), and the composer accepts pasted files. Files up to 100 MiB each upload through the backend to `~/.local/share/omarchy-remote/uploads/` on the host, keeping a sanitised copy of their name so the agent can tell `report.zip` from a screenshot. Files have private permissions and are retained until removed on the host; they are not web assets. Each attachment appends `Image: /absolute/host/path` for PNG, JPEG, GIF, WebP or HEIC/HEIF content and `File: /absolute/host/path` for anything else to the original pane's draft, even if you switch panes during upload. Review the draft and press Send to submit; uploading never sends terminal input automatically.

## Output views

Terminal and Herdr output use native browser overflow scrolling, including smooth pixel movement and the system's momentum. **Fit** is enabled by default in Herdr and wraps output at word boundaries without changing the desktop pane. Tap it for **Original** when reading tables or terminal layouts that need horizontal scrolling; the choice is saved. **↓ Latest** sits beside Message and the keyboard-dismiss arrow while typing, and floats over the output when the keyboard is hidden. It returns to live output; direct typing and sending a message also follow it. Keyboard resizing preserves the prompt at the bottom, or your history position when reading older output. Hide the keyboard with **⌄**. Text entry uses the system keyboard or a connected hardware keyboard throughout the app, including the launcher. The prototype touch keyboard and its SUPER layer have been removed. Switching from herdr to a web app cannot reveal a shell keyboard.

If the backend or Herdr is unavailable, the app shows a connection error and retries. The native app's bundled offline copy cannot reach the host APIs.

## Files

Files browses the host home directory with breadcrumbs, grouped folder and file rows, extension badges, and real metadata. Search names in the current folder, contents below it, or names and contents across HOME. The menu also offers a fuzzy finder with recent files and home, git, and config shortcuts. Search supports case, hidden files, regex and glob filters. Searches are bounded and report when results are limited; `.git`, `node_modules`, `target`, and `.cache` trees are skipped.

Tap a file for an image or syntax-colored, line-numbered text preview. The file menu toggles wrapping. Edit saves UTF-8 text on the host and detects external changes before replacing a file, retaining the draft on conflict. Text preview and edit are limited to 1 MiB; transfers and images to 25 MiB each. On iPhone, Save… opens the iOS share sheet.

Select or long-press a folder row to enter selection mode. Select all, invert, or use a wildcard pattern; then download a ZIP, move, copy, rename one item, or send items to the recoverable host Trash. Selection supports up to 100 items. Copy and archive are limited to 25 MiB and 10,000 entries per tree; symlinks and special files are rejected for these operations. Existing destinations are never replaced. New creates folders or empty files; Upload uses the phone picker and keeps its original target folder after navigation.

The last folder and recent paths are remembered. Access stays inside HOME; external symlinks and the backend's private environment file are excluded, and operations cannot move the home directory or ancestors of that file.

## Browser

Browser resumes the last viewed web tab if it is still open on the desktop; otherwise it shows the tab manager. ⌘⇧L opens the manager. ⌘W closes the shell window; ⌘⇧W closes the current desktop tab. ⌘/ lists browser shortcuts. Shell workspace and window bindings stay active in Browser: ⌘numbers choose workspaces and ⌘brackets move between them. Ctrl+numbers choose browser tabs, Ctrl+brackets navigate page history, ⌘T creates a browser tab (⌘⇧T reopens one), Ctrl+F finds text, and Ctrl+plus/minus/0 controls zoom. ⌘T creates a tab in the active app, ⌘F toggles fullscreen, and ⌘⇧F opens Files.

Browser mirrors Vivaldi (or another Chromium) windows, workspaces and tabs through the companion extension. It supports desktop tab close and create, window moves, pin and mute, reload and focus. Opening a tab loads its URL inside the themed Browser frame in a separate native WKWebView. The website fills the inside of its workspace border. Scrolling down hides the address and navigation bar; scrolling up or tapping the top of the page reveals it. New page navigation restores the controls. The address field and back, forward, and reload controls navigate that local page; website URL changes also update the originating desktop tab. Website logins persist on each device, separately from the desktop browser and from the shell. The page has no host message bridges. The **…** menu holds Reload and **Dark**. Dark forces a dark palette using bundled Dark Reader; the toggle persists on the device and applies to subsequent page loads. Switch it off to restore the original styling without reloading. Cross-origin stylesheets and embedded frames may remain unmodified. The leftmost **‹** returns to the desktop list, and **return to page** resumes the same local page. The list’s × button closes the actual desktop tab. Expo shows a page preview while the native page is hidden. In the PWA, pages still open externally. Links requiring another app are currently unsupported. Tossing Browser from Expo does not close desktop tabs. Vivaldi workspace groups come from saved metadata and may lag briefly; workspace reassignment is unavailable when the extension API hides those fields. See [browser setup](../browser-extension/README.md).

## Host TUIs

btop, Services, lazydocker, dua, and lnav are standalone apps with their own Home tiles, workspaces and Expo cards. The backend starts each program in its own PTY, resumes it across web reloads, and ends it only when its Expo card is tossed. Each has theme colors, a **Fit** view sized to the program's column layout, **Larger** for readable terminal sizing with horizontal scrolling, a row of touch buttons for the program's main keys, and native keyboard input by tapping the output. The table lives in `backend/src/apps.rs`; the touch buttons in `public/remote.js`.

- **btop** runs with its own config at `~/.local/share/omarchy-remote/btop.conf`. Buttons toggle the CPU, memory, network and process panels. Its colors are mapped to the selected phone theme: a transparent monitor background, accent box borders, semantic graph colors and readable text in light and dark themes.
- **Services** runs systemctl-tui with a 64-column Fit view. ↑/↓ navigate, **Select** opens a unit or chooses an action, **Back** dismisses, **Search** filters with the phone keyboard, **Filter** opens status filters, **Help** shows the TUI shortcuts. Both system and user units are shown with the host user's existing permissions.
- **Lazydocker** opens the host Docker context. Panel switches sections, Open focuses details, Tab switches detail tabs, Menu exposes available actions, and Search filters.
- **Dua** scans HOME using two threads and stays on the current filesystem. Open and Up folder navigate directories; Panel switches panes, and Help lists cleanup keys.
- **Lnav** follows the last 1,000 accessible journal entries and new host logs, with a Wrap control for long lines. Search, page navigation, Latest, and Help are available. Other log files can be opened through lnav's `:open` command using the keyboard.

## Home and widgets

Startup opens Home only. In Expo, swipe an app card upward to dismiss it, or hold for about half a second and drag it to another slot to reorder workspaces. Home stays first and cannot be dismissed. Short swipes snap back; a cancelled reorder restores its original order. Workspace order lasts for the current page session.

Home widgets use `/api/widgets` on the backend. One sampler reads Linux CPU and memory counters, the default-route interface's traffic rates, root-filesystem usage, uptime and CPU temperature (when available) every three seconds. Tailscale status and peers refresh every fifteen seconds and describe the host's VPN state, not the phone's. The sampler uses the `df` and `tailscale` CLIs.

Weather uses Open-Meteo's geocoding and forecast APIs via the backend's `curl` client, with fixed upstream URLs, timeouts and a bounded fifteen-minute forecast cache. Choose a city in the weather card, or use the target icon to take the phone's location (the native app asks for when-in-use permission and sends only city-level coordinates). Location and Celsius/Fahrenheit preference are saved per device; automatic units follow the phone locale. Forecast hours use the selected city's timezone. Polling pauses when the page is hidden or Home isn't active, and connection failures show unavailable or stale states.

CodexBar is sampled every five minutes using the installed CLI, with Codex's automatic source and Claude's read-only OAuth source. The dedicated CodexBar app opens from the launcher or by tapping its Home widget. It shows usage windows, banked resets (count, status, grant and expiry dates), credits and credit events, provider costs, service status, usage pace and other reported usage details. Local Codex/Claude token-cost history includes daily and model breakdowns, cache tokens and coverage when available. Expandable detail sections expose the supported telemetry fields without account identifiers, credentials, diagnostic dumps, or redemption IDs. Unreported values stay unavailable rather than becoming zero. Reset redemption is not supported.

CodexBar also includes a Reset watch card sourced from [willreset.com](https://willreset.com/developers): 24/48-hour forecast percentages, confidence, elapsed time since the last reported reset, active reset promises, a reset/banked-reset post feed, and reset history. These are public third-party reports, separate from account usage and banked credit balances. Previews keep their labels and forecasts are not scheduled resets. The Rust backend caches the forecast, feed and timeline independently every five minutes; failures retain the last good section and display a warning. Data older than fifteen minutes is also marked outdated. Expanded lists show up to forty entries with links to the original posts and the full source lists.

Usage and local costs are cached separately on the host every five minutes. The app reads that cache every thirty seconds while visible; Refresh rereads the cache without launching extra CLI processes. Connection failures preserve the last sample in an open app. The app and widget share their provider selection. Widgets registered by an app belong to its provider module: tapping opens the owning app, while embedded controls, scrolling and long-press management retain their behavior.

The herdr app-owned Home widget replaces the separate attention panel. It shows named threads and their projects, prioritizing threads waiting for attention and otherwise showing working threads. Each row opens its specific pane in Herd; tapping the widget background opens the app. Quiet, empty and disconnected states are explicit. It uses the same add/remove/reorder controls as CodexBar. New widget types appear once on existing installations without restoring widgets that were deliberately removed.

Long-press a Home widget (or tap its manage icon) to open the widget overview. Drag after a short hold to reorder, swipe up or tap × to remove, and use the library to add widgets back. Enabled widgets, order and the selected page persist per phone. Removing a widget changes Home's layout without changing the host service or any provider subscription.

## Themes

Settings → This device offers **Focus follows pointer** (off by default). In desk mode, moving a mouse or trackpad pointer over a window focuses it for keyboard input. Touch, dragging, Expo, and open dialogs do not change hover focus. The preference is saved and backed up per device. Embedded Browser and web-app hover is supported on Android and requires native build 29 or later on iPad/iPhone. Native website hover is disabled on visionOS so looking at a window cannot steal focus.

Theme selection lives in Settings and persists on the device (`omarchy-theme`). The shared CSS tokens also drive the launcher, custom keyboard, Terminal and Herdr; ANSI indexed colors update immediately, while explicit RGB output retains the host application's colors. Web controls follow the palette's light or dark color scheme; the native wrapper still requests a dark iOS keyboard. The portable catalog includes the stock Omarchy palettes plus the original prototype. Refresh it with `python scripts/import-themes.py` (which `deploy/install.sh` runs); stock palettes come from `/usr/share/omarchy/themes`, with `~/.config/omarchy/themes` overlays applied, and the theme backgrounds are converted into the untracked `public/backgrounds/` directory with a `catalog.js` index. This copies color definitions and images only and does not change the host's desktop theme.

## PWA

The standalone build's service worker caches only known app files, rejects redirected install responses, and activates a new version after old app windows close. Close all app windows and reopen to pick up an update. A PWA cannot defer iOS system gestures; the native app can.

Development views reload after source changes, including atomic file replacements. The host checks sources every 750 ms and publishes a reload only after native assets regenerate successfully; a failed regeneration is retried once, then waits for the next source change.

### Adjustable desk tiling

Settings → This device offers Dwindle (Omarchy's default), Master and stack, and Scrolling columns.
Dwindle recursively splits the available area; Master keeps the first window on
the left with the others stacked on the right. Resize with a divider (touch or
pointer), or hold Command and right-drag inside a window. Command + left-drag
onto another tile swaps them. Linux/Windows web clients use Ctrl+Alt. Touch-only
phone workspaces keep their existing geometry.

Split sizes, direction overrides, and layout choice are part of the existing
per-device layout backup. Settings has a Toggle active split direction action.
A keyboard-focused divider accepts arrows in 25-point steps; double-click resets
its size. Fullscreen and Expo hide dividers. Browser and saved website content
forward modifier drags through a native gesture bridge starting with build 30;
ordinary website touches and scrolling retain their normal behavior.

Desk navigation remembers the previous workspace by a surviving window identity,
so closing and renumbering workspaces does not turn it into a stale numeric target.
Command+Shift+P returns there. Command+Shift+X moves to the next workspace without
following; if the source becomes empty, focus returns Home. Moves into an already
full four-tile workspace are ignored. Command+Shift+Y changes Dwindle split direction
and Command+Shift+U cycles layouts. Native hardware registration is included in build 31 and later.

### Action palette and shared keyboard registry

Command+Shift+K opens Search actions. Results include concrete workspace numbers,
window actions, app launchers, active Browser actions, and moving to a chosen
workspace without following. Type to filter, use arrows and Return, or click an
action. Escape dismisses the palette. Native websites are covered while it is open.

The shell binding definitions and provider action descriptors are combined into
one registry, with shell bindings reserved before app shortcuts. Browser uses its
action descriptors for handling and help. Native build 31 receives the registry
from the trusted shell, rather than maintaining a separate hard-coded list in
Swift. Text-editing arrows remain with text fields. Existing Command+/ help is
retained; new actions can be added without another Swift key-list edit.

### Scratchpad

Send any non-Home desk window to the scratchpad with Command+Shift+S, then use
Command+S to show or hide it on any workspace. Hiding preserves the app and its
running session. Command+Shift+S while it is shown returns it to tiling. There is
one scratchpad slot; an occupied slot is never silently replaced. Its window and
floating geometry persist per device, and it starts hidden after a reload.
Command-drag moves it and Command+right-drag resizes it within the desktop bounds.
These actions also appear in the palette and require native build 31 for hardware
key registration. Phone layouts are unchanged.

### Window instances and groups

The action palette offers independent Terminal and Files windows. Each Terminal
window owns its own tab list and PTYs, while each Files window keeps its own folder
and navigation state. App providers opt into multiple instances; the installed app
catalog remains distinct from its open window IDs. Other apps can share a group
without needing multiple-instance support.

Use Group window with next tile to combine the active tile with another in the
workspace. The group shows app tabs above its content. Clicking a tab or using the
existing next/previous-window commands selects it. Remove window from group splits
out the current tab. Closing a grouped window closes only that window. Workspace
layout backups include instance identities, group memberships, and the selected
tab. Terminal session IDs stay local to the client; restoring on another device
starts its own shells. Browser/web-app native surfaces follow visible group tabs.

### Scrolling layout

Settings → Window layout → Scrolling columns keeps windows in a horizontal strip
instead of shrinking all tiles to fit. Columns default to 49% width, matching the
host Omarchy scrolling configuration. Drag a divider or Command+right-drag to set
an individual column between 25% and 100% of the workspace width. Widths persist
per device. Groups occupy one column and keep its width when their tab changes.

Focus-left/right and next/previous window reveal the focused column. The bottom
strip uses native horizontal overflow scrolling for touch/trackpad panning, accepts
wheel input, and has named buttons to focus columns. This does not intercept
scrolling inside app content. Expo scales the complete row into its workspace
preview. Scratchpad remains floating above the workspace; phone geometry is unchanged.

### Floating windows

Command+Shift+O (also in Search actions) toggles a regular desk window between tiled
and floating. Floating removes that window from its tile group and lets the remaining
tiles fill the space. Floating windows retain workspace membership, saved position
and size, and come forward when focused. Command-drag moves; Command+right-drag
resizes. Bounds remain inside the desk when its dimensions change. Fullscreen and
Expo continue to work. An overlapping foreground window covers native web surfaces
behind it with their preview so native content cannot paint over the front window.
The scratchpad remains a separate slot that can follow you between workspaces.

### Independent Browser windows

Search actions → New browser window creates another Browser pane with its own tab
manager, address, back/forward history, find, zoom, and native web surface. Its last
selected desktop tab is saved separately on this device. Closing a window releases
only that window's page, leaving other Browser windows and desktop tabs open. All
windows share the native website data store, including logins. Choosing the same
desktop tab in two panes still targets the same desktop tab when syncing URLs.
Additional embedded Browser surfaces require native build 33; the PWA continues to
open websites externally. Layout backups preserve the additional window identities.

### Direct keyboard resizing

Command+Option+Shift+arrow resizes the active window without first focusing a divider.
Left/right shrink/grow width; up/down shrink/grow height, by 25 points per press.
For tiles, the nearest containing split on that axis adjusts while respecting
minimum pane sizes; grouped tabs resize their shared tile. Scrolling columns resize
horizontally. Floating windows and scratchpad resize within the desk bounds.
Fullscreen ignores resizing. Browser tab navigation keeps Command+Option+left/right.
Search actions also exposes all four resize operations for clients without this chord.

### Custom shortcuts

Settings → Keyboard shortcuts opens the searchable per-device editor. Choose a
shortcut, then press Command/Control plus a key to record a replacement. Escape
cancels recording. Disable removes only its key binding; the action remains in
Search actions. Reset restores one default; Restore defaults clears all overrides.

The shell, Browser, shortcut help, palette and native registrations resolve the
same registry. Remapping removes the old chord, including Return's numeric-keypad
alias. The editor checks Browser's definitions even when Browser is closed,
rejects duplicate bindings (including the Ctrl+Alt web aliases), and protects common
system and text-editing chords. Native iPadOS can still reserve additional keys;
use a different chord if the system consumes one. Overrides are included in the
existing per-device layout backup. Browser custom bindings apply to all Browser
windows. Native build 33 also supports punctuation and combined Command+Control
bindings. Phone workspaces retain their existing geometry.

### Saved hosts and disconnect

Native build 34 introduces a device-local host directory, seeded from the existing
configured URL. Settings and the pull-down launcher expose Manage hosts and
Disconnect. The standalone local picker adds, renames (save the same address),
removes and connects up to ten hosts. HTTPS addresses are canonicalized to the
host’s `/native/` shell; credentials, query strings and custom paths are rejected.
Loopback HTTP is supported for development only. Native Add Host uses UIKit text
fields in a system dialog; the PWA keeps an inline form.

Command+Control+1–9/0 switches hosts by saved order without consuming workspace
number shortcuts. These actions participate in the desk registry, help and custom
bindings. The local picker also accepts their default chords. A disconnect unloads
the shell and embedded web surfaces, cancels automatic reconnect, and stays at the
picker on relaunch; it does not close remote PTYs or agents. Failed live connections
use the selected host’s offline snapshot with the existing retry behavior.

Native preferences are mirrored under the selected host URL. Switch requests flush
the current snapshot before selecting the destination; storage messages include a
host scope so late messages cannot overwrite another host’s state. The bundled
origin replaces its local snapshot on scope changes even when the destination has
no saved state. Live origins keep separate local storage. The directory itself is
not included in any host backup, and removing an entry does not delete its saved
preferences. Native embedded website cookies stay shared on the device.

PWA clients retain their directory locally and transfer that directory alone in a
fragment when navigating between origins. The fragment is consumed and removed
before shell initialization. Disconnect uses a standalone same-origin picker so
host connections stop. Native mode provides a picker even while the server is down;
a PWA’s cross-origin navigation remains subject to the browser’s standalone scope.

### System top-edge gestures

The notification and quick-settings pull-down panes have been removed on every
viewport, including iPhone and iPad. Their rendering, gesture actions, notification
mute/dismiss state and styles are gone. Home still shows Herd attention summaries,
and Settings remains a regular app. The middle of the in-app top bar still opens
the launcher; pulling down at either corner does nothing in the shell. Native
build 35 defers only the bottom edge, letting iOS handle its top-edge gestures
without the app’s previous extra swipe requirement.

## Native build downloads

The host's `/builds/` page lists published iPhone/iPad builds with release notes, source revision, profile expiry, SHA-256 checksum, a direct IPA download, and an iOS manifest install link. Open it in Safari with Tailscale connected when away from the local network. Installation still requires a device covered by the signing profile and Developer Mode; hosting does not register new devices or renew signing. An available download is not proof that iOS accepted installation.

Already validated IPAs are published with `scripts/publish-native-build.py`; the catalog lives outside Git in `~/.local/share/omarchy-remote/builds` (override with `OMARCHY_BUILDS_DIR` for both publisher and server). Builds are retained by SHA-256, and re-publishing identical bytes updates notes without duplicating the entry. The server exposes only the page, catalog, publishing skill, IPA/APK packages and manifest files. No signing credentials or validation logs are published.

The dashboard includes a downloadable `omarchy-builds` agent skill. It ships with the repository so other hosts can use the same publishing workflow with their own addresses and signing identities.

**Builds** is also an app in the Omarchy Remote launcher and Home app picker. Pin it like any other app. Before the host has published anything, it presents a setup landing page with the downloadable `omarchy-builds` skill and instructions for the agent. Published builds replace that landing page with release notes and build details; Refresh checks for new publications. In native build 37 and later, **Install** hands the selected build to iOS for confirmation. The native bridge constructs the HTTPS manifest URL from the connected host and a validated build hash; pages cannot supply arbitrary install URLs. A successful handoff means iOS accepted the URL, not that installation completed. Older native builds retain the copy-link Safari fallback. Updating Omarchy Remote itself may close it while iOS replaces the app. The skill can be saved through the system share sheet (or copied if file sharing is unavailable). The standalone host dashboard remains available at `/builds/`.

## Android host (in development)

The Android host reuses the same shell and Rust backend, with Android WebViews for embedded browsing and saved web apps. It has native host selection, on-device preference storage, keyboard focus and battery reporting. The development APK currently builds and launches on the Android emulator and can type into a real host terminal. Weather’s compass uses Android foreground location permission, reports denial or disabled services, and cancels pending lookups when changing hosts. A granted emulator lookup populated the live weather widget. Files uploads use Android’s document picker. Save… opens the system Save as dialog, with chunked transfer and background writing; no broad storage permission is required. Native browsing now supports Find with match counts, SPA history reporting, top-only toolbar reveal, and dark-mode toggling. Android hardware shortcuts use the shared action registry, including custom bindings, and reach the shell while embedded websites are focused. Ctrl+Alt is an alternative to plain Command/Super bindings on Android; clipboard commands remain native. When a host cannot load, the bundled shell runs under that host’s origin, retains local settings, and retries with bounded backoff while foregrounded. Returning from the background resumes host connections. Tablet layout validation, remaining browser interactions, and APK updates still require the implementation and verification recorded in [Android parity](android-parity.md). This is not yet a claim of complete Android support.

Device backups include the widget catalog history as well as the visible widget order. Restoring a backup therefore keeps intentionally hidden widgets hidden.

On Android, hardware typing immediately after an app-launch, window-focus, or workspace shortcut waits briefly for the validated native input focus transfer. A superseding shortcut, backgrounding, or a two-second timeout discards pending input rather than delivering it to a different window. Terminal then uses its existing connection-startup input buffer.

Android Back dismisses visible keyboard input first, then launcher/Expo/shortcut overlays, then navigates the focused website’s history. At the root it backgrounds the task, preserving workspaces for resume. WebViews route Back before the input method only when the keyboard is not visible, so keyboard dismissal remains native.

Android Browser supports whole-document zoom from 25% to 500%, including images and layout, with reset and reload persistence. The Android host uses CSS root zoom rather than text-only scaling; viewport media-query breakpoints remain unchanged.

On Android with a hardware keyboard, selecting a Browser or saved web-app window transfers native keyboard focus to its page. Hiding or deselecting it releases focus; repeated layout animation updates do not steal focus from page controls.

The Builds catalog also accepts signed Android APKs. Native devices see builds for their own platform; the web dashboard offers both APK downloads and iOS manifests. Android Install verifies a content-addressed download, package identity, minimum API, signing identity, and version before opening the system confirmation. Installation-source permission is requested only after choosing Install; return and retry after granting it. The server serves APKs with their Android package MIME type. Publishing uses the existing script and agent skill, preserving older iOS catalog entries.

Android’s full-screen phone layout uses native IME insets instead of relying on viewport shrinkage, keeping message input and controls above the keyboard. An explicit dismissal also keeps a subsequent hardware-focus reconciliation from reopening it after Send. Message-mode Ctrl editing shortcuts operate on the local draft, while direct-key mode and the explicit Ctrl tool preserve host control sequences. Switching pane drafts ends the old editor session so composition and word suggestions do not remain attached to the previous pane.

Android native browser verification covers immediate keyboard-driven Terminal launch from a website, keeping subsequent input in the new terminal. Website links requesting a new window open inline in the embedded view, retain their same-site session cookies, and support Back without leaving the app.

Android file selection supports multiple files in Files and Herdr. The native wrapper reads all selected document URIs instead of relying on older WebView parsers that only read a single URI; cancelling still returns no files. Files selections can be saved as ZIP archives through Android’s document picker.

Android’s file action offers **Save to device** and **Share…**. Save uses the document picker; Share opens Android’s share sheet with the original filename and MIME type and a temporary read-only content URI. Cancelling the initial choice aborts cleanly. The app reports handing the file to the share sheet, not delivery by the recipient app. Shared copies remain in private cache for asynchronous readers; later startups remove copies older than one day.

Android’s end-to-end Browser check uses a separate Vivaldi profile and native messaging bridge. Navigation in the embedded page updates the exact desktop tab, while the close-tab shortcut closes that tab and leaves the Browser app window open. Native saved-host checks cover unsafe address rejection, returning to the picker after a disconnected restart, and preserving preferences within their host scope.

Programmatically focused app containers use the existing themed active-window border, avoiding a second square focus outline inside rounded windows on Android. Focus styling on buttons and text fields is unchanged.

Android rejects invalid host certificates for both WebView requests and automatic reconnect probes. The bundled interface remains available without accepting the certificate, including the saved-host picker and host-scoped local preferences. The native host dialog and saved-host connection row are covered by the untrusted-HTTPS emulator check.

Android Herdr input has an emulator check for real Gboard taps and keyboard Send, including the resulting host output, cleared draft and dismissed keyboard. Predictive correction and composing-script behavior remain separate Android verification work.

Android saved web apps retain their session cookies and device catalog/pins after process death, including when the catalog cannot be fetched. Their native lifecycle check uses an isolated catalog, follows new-window links inline, returns through Android Back and uninstalls the fixture. Websites without an authored background use the browser's white canvas so default black text remains legible; the surrounding shell stays themed.

Android tablet verification includes two independent embedded web apps: native page dimensions follow their tiles after divider dragging, Expo hides the full-size native surfaces and shows page previews, and leaving Expo restores the page dimensions. The same test checks app/session persistence after process death on the tablet viewport.

Android tablet Herdr keeps the composer above the software keyboard while retaining visible terminal output. Native verification waits for the keyboard animation to settle before checking the bounds and capturing the screen, then exercises draft switching, clipboard editing, image attachment, process-death recovery and sending to isolated test shells.

Android release APKs use an explicitly configured private signing key. Release builds disable debugging, require HTTPS, and open the saved-host picker. The release emulator fixture verifies signature continuity and saved-host retention across an in-place version update under a separate test identity.

Android shortcut labels distinguish `Ctrl+Alt` aliases from combinations requiring a physical Meta key. Host switching is displayed as `Meta+Ctrl+number`, and resize combinations as `Meta+Alt+Shift+arrow`; the help sheet does not repeat Ctrl or show Apple-only system-key notes on Android. The actual bindings are unchanged.

Host navigation also saves the departing host’s final device-settings snapshot before replacing the shell, without waiting for the periodic preference mirror.

Android remembers the browser’s forced Dark preference on the device. Newly opened browser and saved-app views inherit it after relaunch, and the browser menu reflects the restored setting.

Android takes native shell focus at the start of a touch gesture, preserving the launcher search field for immediate typing after a swipe. Unmodified Escape is delivered to the active app before the input method can consume it; Android Back remains available to dismiss the software keyboard.

Android weather units follow the device’s regional temperature preference, including explicit Celsius/Fahrenheit overrides, with locale defaults when no override is set.

Android message input retains native Gboard autocorrection and clipboard Undo. Emulator checks cover real touch typing and finger scrolling in Herdr and Terminal using isolated sessions.

Android update validation covers wrong package and signing-key rejection even when the download checksum is valid, plus cancellation and successful installation.

Signed release validation also connects to a real private HTTPS host and verifies live Home survives an in-place update. The userdebug emulator’s forced WebView debugging is recorded separately from the release APK’s nondebuggable configuration.
