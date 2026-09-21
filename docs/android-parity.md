# Android parity work

Goal: run the same Omarchy Remote experience on Android phones and larger screens,
verified end to end on the available Android emulator before physical OnePlus 9 testing.
The shared Rust backend and JavaScript providers remain authoritative; Android hosts
the shell and implements native device services and independent browser surfaces.

Completion requires evidence for all of these areas, not just an APK that launches:

| Area               | Required verification                                                              | Status                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Build and delivery | Reproducible Gradle build, install, launch, retained APK                           | Debug APK built and installed; emulator launch verified. Release delivery pending.      |
| Hosts              | Add, switch, disconnect, reconnect, TLS validation                                 | In progress                                                                             |
| Persistence        | Settings, drafts, installed web apps survive process death                         | In progress                                                                             |
| Terminal and Herdr | Real PTY, safe isolated Herdr fixture, input/focus, copy/paste, IME and scroll     | Android hardware input reached a new host PTY without tapping; remaining flows pending. |
| Browser            | Desktop tabs, native page view, navigation sync, controls, find, zoom, dark mode   | In progress                                                                             |
| Saved web apps     | Independent WebViews, cookies, links/new windows inline, history                   | In progress                                                                             |
| Files and uploads  | Android picker, image upload, folder upload, downloaded files/save/share           | Pending                                                                                 |
| Device services    | Battery, locale, location permissions, hardware keyboard, back gesture             | In progress                                                                             |
| Shell              | Phone/tablet tiling, gestures, Expo, keyboard shortcuts, themes/wallpapers/widgets | Pending                                                                                 |
| Offline/lifecycle  | Bundled fallback, foreground reconnect, restored app state                         | Pending                                                                                 |
| Updates            | APK publication, platform-aware Builds, Android installer handoff                  | Pending                                                                                 |
| Platform safety    | Trusted main-frame bridge, external pages isolated, HTTPS and URI handling         | In progress                                                                             |

No physical-device parity claim is made by emulator validation. Keep remaining gaps
visible here until they are actually implemented and tested.

Initial emulator evidence: `artifacts/android/initial.png`, `terminal.png`, and CDP inspection confirmed platform `android`, live host content, battery state, and typed terminal echo. The initial full-screen OS education dialog was dismissed. The QA-created terminal was closed without sending any input to existing Herdr threads.

Android Gradle `assembleDebug` and `lintDebug` pass. The minimum supported Android version is 11 (API 30); the runtime read of bundled assets avoids newer Java APIs unavailable there.

Weather location: implemented foreground permission handling, denial, disabled services, a 20-second lookup timeout, and cancellation on host change or destruction. Emulator checks verified no unsolicited permission prompt, denial, successful GPS lookup at an injected coordinate, and disabled-service errors. Clicking the weather compass populated the live widget and saved the location; screenshot: `artifacts/android/location-weather.png`. Approximate-only physical-device behavior remains to verify.

Files: the trusted shell now saves through Android’s document picker using chunked staging and background copying. In the emulator, a 480,000-byte fixture saved to Downloads matched byte for byte; cancellation returned AbortError without creating a file. The same file was selected through the real Files app upload button and verified on the host in an isolated temporary folder, then opened and saved through Files’ Save… button. External web pages do not receive this bridge. Multi-file uploads, Herdr image attachments, folder selections, external-page downloads and sharing to other apps remain to verify or implement.

Browser control checks: `node scripts/android-browser-smoke.mjs` uses an isolated local website and an independent native view, without modifying desktop tabs. It verifies bridge isolation, user-initiated pushState URL/back-state reporting, back/forward, toolbar reveal only at scroll zero, enabling/disabling DarkReader, native Find match counts and next/close, and actual adb keyboard input after focus moves in both directions. Native hardware shortcut routing, full-page zoom, browser-to-desktop integration, and additional lifecycle scenarios still need verification.

Hardware shortcuts: Android now consumes only registered chords, suppresses repeated command dispatch, and routes canonical actions from both shell and website WebViews. Plain Command actions accept Ctrl+Alt on Android, including browser actions, with shared collision detection. The native browser fixture verifies real adb key combinations and preserved Ctrl+A/C/V editing. A real Ctrl+Alt+Enter launched a host Terminal, typed text reached its PTY after focus became ready, and Ctrl+Alt+W closed it without executing the typed text. Immediate typing during launch, tablet sizing, and the full shortcut matrix still need coverage.

Offline recovery: bundled assets now render at the selected host origin, keeping API/WebSocket routing and local storage aligned. Native foreground retries use a bounded 3–30 second backoff and preserve normal TLS validation. Emulator checks removed only its adb network forwarding (the host services stayed running), force-stopped and launched the app offline, and confirmed Home rendered with existing settings/catalog. An offline storage edit and isolated Herdr draft survived backgrounding and process death, then survived restoration of the live shell on resume. No existing agent received QA input. Killing immediately after a synthetic storage write, before the asynchronous mirror completed, did lose that write; this test does not claim synchronous durability at every instruction boundary.

Foreground recovery also passed without backgrounding or tapping: restoring the emulator forwarding replaced the bundled shell automatically. The persistence regression suite exposed a shared backup omission; widget catalog history is now backed up so hidden Herdr widgets stay hidden after restore.
