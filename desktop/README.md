# Omarchy Remote desktop

An Electron client for Linux, macOS, and Windows. It loads a host’s `/native/` shell and provides the same bridges as the iOS and Android apps, so the web shell needs no desktop-specific code beyond a platform check or two. See the [feature reference](../docs/features.md#desktop-app) for behavior.

| File               | Role                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/main.js`      | Window, host picker, bridge dispatch, navigation and permission guards, save dialog, menus.           |
| `src/preload.cjs`  | Recreates `window.webkit.messageHandlers` and `navigator.share` for the selected host only.           |
| `src/pages.js`     | Browser tabs and pinned web apps as `WebContentsView`s placed over their tiles; find, Dark, previews. |
| `src/keys.js`      | Matches keys typed in a page against the shell’s published action registry.                           |
| `src/launchers.js` | Linux application-launcher entries that open one app with `--app=<key>`.                              |
| `src/hosts.js`     | Saved-host directory, matching `public/hosts.js`.                                                     |
| `src/store.js`     | Device state in the user-data folder.                                                                 |
| `src/find.*`       | The find bar shown over a page.                                                                       |

## Run

```sh
npm install
npm start -- --host=https://machine.tailnet.ts.net
```

`npm start -- --app=herdr` opens only Herdr, without the shell; running the client again with another `--app` adds a window to the running process. `npm start` regenerates `ios/Generated/Web` first; development runs read the host picker from there. On the host machine itself, `--host=http://127.0.0.1:4187` uses the development server. `OMARCHY_USER_DATA` points the app at another profile folder, and `OMARCHY_DEVTOOLS=1` opens developer tools for the shell.

## Test

```sh
npm test               # host directory and key matching; also part of the root npm test
npm run test:app       # Playwright drives the app against REMOTE_TEST_URL (default http://127.0.0.1:4187)
```

`test:app` needs a display. It uses the Wayland session when `WAYLAND_DISPLAY` is set, or run it under `xvfb-run`. Test windows open briefly. Set `OMARCHY_DESKTOP_EXECUTABLE=dist/linux-unpacked/omarchy-remote` to test a packaged build. The specs use a local test website and a throwaway profile; they never change the host’s web-app catalog.

## Package

```sh
npm run dist:linux     # dist/omarchy-remote-<version>-x86_64.AppImage and -x64.pacman
npm run dist           # the current platform's targets: dmg on macOS, NSIS installer on Windows
```

Build each platform on that platform. macOS and Windows builds are unsigned until you configure signing for electron-builder with your own identity, kept out of the repository.

### Linux ARM64 on Omarchy

Build on the ARM64 machine itself. Electron's ARM64 runtime is downloaded by the
builder; the Rust host backend must also be compiled on that machine. On Arch-based
systems the host's theme importer needs Pillow, and the package builder's bundled
Ruby needs the compatibility `libcrypt.so.1` library:

```sh
sudo pacman -S --needed python-pillow libxcrypt-compat
# From the repository root:
npm ci
npm --prefix desktop ci
cargo build --locked --release --manifest-path backend/Cargo.toml
npm --prefix desktop run dist:linux -- --arm64
sudo pacman -U desktop/dist/omarchy-remote-0.1.0-aarch64.pacman
```

This produces both `desktop/dist/omarchy-remote-0.1.0-arm64.AppImage` and the
native `aarch64.pacman` package. The pacman package adds Omarchy Remote to the app
launcher. Configure the backend and web services using the host installation steps
in the root README; packaging the client alone does not start a host.

Canvas, Corral, Muster, Chat, Herdr, CodexBar, and Settings can each have their own
launcher through **Settings → app windows**. Canvas and Corral are served by the
shared Rust backend: they need no separate application server or architecture-specific
frontend build. Keep the backend and web shell at the same source revision. Their
agent commands must be installed and authenticated on this host; installing a
launcher does not transfer credentials or conversations from another machine.

Herdr’s folder button uses the OS default file manager when the selected server’s `/api/state` host ID matches the local backend’s `~/.local/share/omarchy-remote/settings.sqlite3`. The database is read-only and never created by the client. Missing identities, remote hosts, non-directory paths, and OS opener failures fall back to the in-app Files view. The `shellFolders` bridge is available only to the trusted host shell, not embedded websites.
