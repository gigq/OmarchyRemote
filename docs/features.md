# Feature reference

What each app in Omarchy Remote does and the limits it enforces. "The host" is the machine running the backend; its name appears in every status line from `OMARCHY_HOST_NAME`.

## Terminal

Terminal opens a real interactive login shell on the host through the Rust backend. Tap its output to open the system keyboard. **Keys** mode sends input immediately, with autocorrect disabled for commands and paths. The shortcut row appears only in Keys mode and provides Esc, Tab, arrows and Ctrl; Ctrl applies to the next letter. The shell survives live reload and reconnection; `exit` closes that shell tab; closing the last tab closes the Terminal window. Closing Terminal from Expo terminates its app-owned shell; reopening starts a new one. Files can open a shell in the current folder after confirming replacement of the app-owned Terminal.

⌘Return opens or focuses Terminal; ⌘T adds a shell tab when Terminal is active.

## Herdr

Herdr shows the local running Herdr's workspaces, agents, statuses and panes. Workspace and tab ordering follows Herdr Mobile's priority groups: needs attention, working, done, idle, then unknown. Recent Herdr activity sequences break ties before desktop tab order; panes within a tab sort by activity. Tap a pane to view live ANSI output. Tap the output to open **Message** mode: edit a local draft using the phone's predictions, autocorrect, dictation or swipe typing, then tap **Send** or Return to send it with Enter. Switch to **Keys** for immediate input to interactive programs. Drafts are saved locally per agent thread and survive switching panes, reloads, and app restarts. The back chevron returns to all panes. Existing panes are not focused or resized on the desktop. No input is replayed after a disconnect. Closing Herdr disconnects the phone view and leaves desktop panes and agents running; Herdr sessions are owned by Herdr and survive a backend restart.

Herdr's paperclip opens the phone file picker (photos or any file from Files, such as a ZIP), and the composer accepts pasted files. Files up to 100 MiB each upload through the backend to `~/.local/share/omarchy-remote/uploads/` on the host, keeping a sanitised copy of their name so the agent can tell `report.zip` from a screenshot. Files have private permissions and are retained until removed on the host; they are not web assets. Each attachment appends `Image: /absolute/host/path` for PNG, JPEG, GIF, WebP or HEIC/HEIF content and `File: /absolute/host/path` for anything else to the original pane's draft, even if you switch panes during upload. Review the draft and press Send to submit; uploading never sends terminal input automatically.

## Output views

Terminal and Herdr output use native browser overflow scrolling, including smooth pixel movement and the system's momentum. **Fit** is enabled by default in Herdr and wraps output at word boundaries without changing the desktop pane. Tap it for **Original** when reading tables or terminal layouts that need horizontal scrolling; the choice is saved. **↓ Latest** sits beside Message and the keyboard-dismiss arrow while typing, and floats over the output when the keyboard is hidden. It returns to live output; direct typing and sending a message also follow it. Keyboard resizing preserves the prompt at the bottom, or your history position when reading older output. Hide the keyboard with **⌄**. The custom keyboard remains available for the launcher and SUPER shortcuts.

If the backend or Herdr is unavailable, the app shows a connection error and retries. The native app's bundled offline copy cannot reach the host APIs.

## Files

Files browses the host home directory with breadcrumbs, grouped folder and file rows, extension badges, and real metadata. Search names in the current folder, contents below it, or names and contents across HOME. The menu also offers a fuzzy finder with recent files and home, git, and config shortcuts. Search supports case, hidden files, regex and glob filters. Searches are bounded and report when results are limited; `.git`, `node_modules`, `target`, and `.cache` trees are skipped.

Tap a file for an image or syntax-colored, line-numbered text preview. The file menu toggles wrapping. Edit saves UTF-8 text on the host and detects external changes before replacing a file, retaining the draft on conflict. Text preview and edit are limited to 1 MiB; transfers and images to 25 MiB each. On iPhone, Save… opens the iOS share sheet.

Select or long-press a folder row to enter selection mode. Select all, invert, or use a wildcard pattern; then download a ZIP, move, copy, rename one item, or send items to the recoverable host Trash. Selection supports up to 100 items. Copy and archive are limited to 25 MiB and 10,000 entries per tree; symlinks and special files are rejected for these operations. Existing destinations are never replaced. New creates folders or empty files; Upload uses the phone picker and keeps its original target folder after navigation.

The last folder and recent paths are remembered. Access stays inside HOME; external symlinks and the backend's private environment file are excluded, and operations cannot move the home directory or ancestors of that file.

## Browser

Browser resumes the last viewed web tab if it is still open on the desktop; otherwise it shows the tab manager. ⌘⇧L opens the manager. ⌘W closes the shell window; ⌘⇧W closes the current desktop tab. ⌘/ lists browser shortcuts. Shell workspace and window bindings stay active in Browser: ⌘numbers choose workspaces and ⌘brackets move between them. Ctrl+numbers choose browser tabs, Ctrl+brackets navigate page history, Ctrl+T creates a browser tab (Shift reopens one), Ctrl+F finds text, and Ctrl+plus/minus/0 controls zoom. ⌘T opens Terminal, ⌘F toggles fullscreen, and ⌘⇧F opens Files.

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

CodexBar is sampled every five minutes using the installed CLI, with Codex's automatic source and Claude's read-only OAuth source. Only provider names, usage windows and reset timestamps reach the phone; account identities, credentials and credit or reset actions are excluded.

Long-press a Home widget (or tap its manage icon) to open the widget overview. Drag after a short hold to reorder, swipe up or tap × to remove, and use the library to add widgets back. Enabled widgets, order and the selected page persist per phone. Removing a widget changes Home's layout without changing the host service or any provider subscription.

## Themes

Settings → This device offers **Focus follows pointer** (off by default). In desk mode, moving a mouse or trackpad pointer over a window focuses it for keyboard input. Touch, dragging, Expo, and open dialogs do not change hover focus. The preference is saved and backed up per device. Embedded Browser and web-app hover requires native build 29 or later on iPad/iPhone. Native website hover is disabled on visionOS so looking at a window cannot steal focus.

Theme selection lives in Settings and persists on the device (`omarchy-theme`). The shared CSS tokens also drive the launcher, custom keyboard, Terminal and Herdr; ANSI indexed colors update immediately, while explicit RGB output retains the host application's colors. Web controls follow the palette's light or dark color scheme; the native wrapper still requests a dark iOS keyboard. The portable catalog includes the stock Omarchy palettes plus the original prototype. Refresh it with `python scripts/import-themes.py` (which `deploy/install.sh` runs); stock palettes come from `/usr/share/omarchy/themes`, with `~/.config/omarchy/themes` overlays applied, and the theme backgrounds are converted into the untracked `public/backgrounds/` directory with a `catalog.js` index. This copies color definitions and images only and does not change the host's desktop theme.

## PWA

The standalone build's service worker caches only known app files, rejects redirected install responses, and activates a new version after old app windows close. Close all app windows and reopen to pick up an update. A PWA cannot defer iOS system gestures; the native app can.

Development views reload after source changes, including atomic file replacements. The host checks sources every 750 ms and publishes a reload only after native assets regenerate successfully; a failed regeneration is retried once, then waits for the next source change.

### Adjustable desk tiling

Settings → This device offers Dwindle (Omarchy's default) and Master and stack.
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
and Command+Shift+U cycles layouts. Native hardware registration follows in the shared-registry step.

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
