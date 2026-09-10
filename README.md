# Hyprland Touch PWA

An installable version of `Hyprland Touch Prototype.html`, the original Claude Design export. The original export is preserved unchanged. The runnable source is `public/index.html`; it retains the exported design runtime and interaction logic, with the decorative phone frame removed and local fonts and React dependencies.

## iPhone

Open the deployed HTTPS URL in Safari, sign in if prompted, then Share → Add to Home Screen. Leave **Open as Web App** enabled if shown. Launch Hyprland from its new icon. Open it online once to install the offline cache.

Start edge gestures inside the app's visible content, above the home indicator and below the system status area. Left/right edges switch workspaces. Swipe down from the top left/middle/right for notifications/launcher/quick settings. Swipe up from the bottom left/middle/right for keyboard/expo/SUPER keyboard. Tapping the active workspace pill also toggles expo.

This is a simulated operating system UI. Apps, Wi-Fi controls, agents, weather, time, and battery values are mock data; they do not control iOS or connect to remote services. State resets when the page reloads. A PWA cannot defer iOS system gestures; use the native app below for that experience.

## Native iPhone app

`ios/HyprlandTouch.xcodeproj` contains a UIKit/WKWebView app with the shared **HyprlandTouch** scheme. It supports iPhone on iOS 18 or later and uses automatic development signing. The bundle identifier is `com.example.HyprlandTouch`.

The native app loads the prototype directly from its bundle, without a website login, server, service worker, or network connection. Every build runs `scripts/prepare-native.py` to package the current `public/` files into `HyprlandTouch.app/Web` and convert root-relative asset URLs for file loading. `ios/WebOverrides/native.css` removes outer safe-area padding and arranges the custom status widgets beside the Dynamic Island. The PWA source remains unchanged.

The root controller hides the iOS status bar, pins the web view to all four view edges, disables automatic scroll insets, and requests top/bottom system-gesture deferral. Start the prototype's swipes at the display edge. iOS retains the escape gesture; a repeated edge swipe can invoke the system. The home indicator remains system-controlled and is intentionally not set to auto-hide while bottom gesture deferral is active. The camera cutout is physical and remains visible.

On a Mac, select the scheme and a paired iPhone to build and run. From HOST, use the headless remote-Xcode workflow; this checkout selects the Mac and syncs to `/Users/user/.cache/xcode-fleet/worktrees/OmarchyRemote-8ea169afb99d`. The phone must be reachable from that Mac, with Developer Mode enabled and development signing trusted. No App Store or TestFlight upload is needed for direct development installation.

Run `python -m unittest discover -s scripts -p 'test_native_bundle.py'` to check native asset packaging. `python scripts/prepare-native.py` also generates a local inspection copy in ignored `ios/Generated/Web`.

## Development

Node is the only build dependency. Run `npm run dev` (http://localhost:4187), `npm run build`, and `npm test`. Restart the development server after edits. Set `PORT` to use another port. Plain HTTP on a LAN IP is insufficient for service workers on iPhone; use the deployed HTTPS site.

`scripts/build.mjs` produces a portable Cloudflare Worker in `dist/server/index.js`, static files in `dist/client`, and a content-versioned service worker. The worker embeds the small static asset set, so no external asset binding is required. The service worker caches only known app files, rejects redirected install responses, and activates a new version after old app windows close. Close all app windows and reopen to pick up an update.

The Sites project ID is in `.openai/hosting.json`. Use the Sites packaging and publishing flow for PWA deployment. The native app is built and installed separately.

## Validation

Automated checks cover manifest and icons, all precache URLs, offline shell delivery, and HTTP routing. The exported React runtime and launcher/settings/map/reset controls were also exercised in a DOM environment without runtime errors. Physical iPhone layout, installation, and gesture behavior still need device verification.
