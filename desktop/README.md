# Omarchy Remote desktop

An Electron client for Linux, macOS, and Windows. It loads a host’s `/native/` shell and provides the same bridges as the iOS and Android apps, so the web shell needs no desktop-specific code beyond a platform check or two. See the [feature reference](../docs/features.md#desktop-app) for behavior.

| File              | Role                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `src/main.js`     | Window, host picker, bridge dispatch, navigation and permission guards, save dialog, menus.           |
| `src/preload.cjs` | Recreates `window.webkit.messageHandlers` and `navigator.share` for the selected host only.           |
| `src/pages.js`    | Browser tabs and pinned web apps as `WebContentsView`s placed over their tiles; find, Dark, previews. |
| `src/keys.js`     | Matches keys typed in a page against the shell’s published action registry.                           |
| `src/hosts.js`    | Saved-host directory, matching `public/hosts.js`.                                                     |
| `src/store.js`    | Device state in the user-data folder.                                                                 |
| `src/find.*`      | The find bar shown over a page.                                                                       |

## Run

```sh
npm install
npm start -- --host=https://machine.tailnet.ts.net
```

`npm start` regenerates `ios/Generated/Web` first; development runs read the host picker from there. On the host machine itself, `--host=http://127.0.0.1:4187` uses the development server. `OMARCHY_USER_DATA` points the app at another profile folder, and `OMARCHY_DEVTOOLS=1` opens developer tools for the shell.

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
