# Omarchy Remote Browser · Vivaldi adapter

Build the Rust backend and run `python scripts/install-browser-bridge.py` once.
Then open `vivaldi://extensions`, turn on Developer mode, choose Load unpacked,
and select this directory. There is no browser restart or remote-debugging port.
Load the extension once in each Vivaldi profile you want to connect. All windows
and tabs in that profile appear automatically; private windows are excluded.
The popup lets you name the instance and set its profile folder (Default or
Profile N, shown in vivaldi://version). The profile folder supplies workspace
names/metadata; it does not copy cookies or authentication data.

## Extension id and the manifest key

`manifest.json` carries a `key`: the public half of an RSA key pair. Chromium derives
an unpacked extension's id from that key instead of from its folder path, so every
checkout loads with the id in `extension-id.txt`, and the native-messaging host
installed by `scripts/install-browser-bridge.py` allows exactly that id. The key is
public and grants nothing by itself; the private half is not in this repository and
is not needed for unpacked loading.

To pin your own id instead, generate a key pair and replace both values:

```sh
openssl genrsa -out extension.pem 2048              # keep this file private
openssl rsa -in extension.pem -pubout -outform DER | base64 -w0   # the new "key"
openssl rsa -in extension.pem -pubout -outform DER | sha256sum | head -c32 | tr 0-9a-f a-p; echo   # the new id
```

Put the first output in `manifest.json` under `key`, the second in `extension-id.txt`
(or export it as `OMARCHY_EXTENSION_ID`), and rerun `python scripts/install-browser-bridge.py`.
Removing `key` also works; the id then depends on the folder path, and
`vivaldi://extensions` shows it after the first load.

The phone polls the shared Rust API while Browser is visible. Vivaldi pushes tab
and window events through Chrome native messaging to the same Rust executable's
`--browser-bridge` stdio adapter. That adapter connects to a mode-0600 Unix socket
owned by the main backend. No browser-wide debugger or TCP listener is exposed.

Each connection gets a fresh ID. Commands reference that connection and an exact
live tab/window ID, expire after eight seconds, and are never replayed. Closing
Browser's Expo card only stops the phone view; closing a tab sends `tabs.remove`
to the matching desktop profile. Close, create, move between windows, pin, mute,
reload, navigation and focus use the extension API. Desktop changes flow back to the phone.

Vivaldi 8 hides `vivExtData` from ordinary extensions. For workspace grouping,
the native adapter reads only metadata command 21 in the two newest Session_
files and `vivaldi.workspaces.list` in Preferences. Only IDs of currently live
tabs are joined; saved/closed tabs are never resurrected. Unrelated session data
is not exported. Saved metadata can lag briefly behind a desktop change.
Versions exposing live workspace metadata can support workspace reassignment;
otherwise the UI offers window moves while retaining workspace grouping.
The adapter never edits Vivaldi's saved session or preference files.

The embedded phone browser keeps its own login session. Navigating within an
opened desktop tab updates that same desktop tab URL, including links and
back/forward navigation. Cookies and page state are not transferred. Older builds
and PWA views open the URL in the phone/browser's normal external tab. Internal
Vivaldi URLs can be managed on the desktop but are not navigated on the phone.

Development: after extension JS changes, use Reload on its extension card.
The native host reconnects automatically after backend restarts. Tests use a
separate Vivaldi profile and backend/socket: `node --test
scripts/browser-integration.test.mjs`. Debugging flags in that isolated test
harness are not required or enabled for the real browser.
