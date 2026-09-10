# Hyprland Touch PWA

An installable version of `Hyprland Touch Prototype.html`, the original Claude Design export. The original export is preserved unchanged. The runnable source is `public/index.html`; it retains the exported design runtime and interaction logic, with the decorative phone frame removed and local fonts and React dependencies.

## iPhone

Open the deployed HTTPS URL in Safari, sign in if prompted, then Share → Add to Home Screen. Leave **Open as Web App** enabled if shown. Launch Hyprland from its new icon. Open it online once to install the offline cache.

Start edge gestures inside the app's visible content, above the home indicator and below the system status area. Left/right edges switch workspaces. Swipe down from the top left/middle/right for notifications/launcher/quick settings. Swipe up from the bottom left/middle/right for keyboard/expo/SUPER keyboard. Tapping the active workspace pill also toggles expo.

This is a simulated operating system UI. Apps, Wi-Fi controls, agents, weather, time, and battery values are mock data; they do not control iOS or connect to remote services. State resets when the page reloads. A PWA cannot defer iOS system gestures. A future native WKWebView host can use `preferredScreenEdgesDeferringSystemGestures` to request gesture deferral while retaining iOS's escape gesture.

## Development

Node is the only build dependency. Run `npm run dev` (http://localhost:4187), `npm run build`, and `npm test`. Restart the development server after edits. Set `PORT` to use another port. Plain HTTP on a LAN IP is insufficient for service workers on iPhone; use the deployed HTTPS site.

`scripts/build.mjs` produces a portable Cloudflare Worker in `dist/server/index.js`, static files in `dist/client`, and a content-versioned service worker. The worker embeds the small static asset set, so no external asset binding is required. The service worker caches only known app files, rejects redirected install responses, and activates a new version after old app windows close. Close all app windows and reopen to pick up an update.

The Sites project ID is in `.openai/hosting.json`. Use the Sites packaging and publishing flow for deployment. No backend or native Xcode project is required for this first PWA version.

## Validation

Automated checks cover manifest and icons, all precache URLs, offline shell delivery, and HTTP routing. The exported React runtime and launcher/settings/map/reset controls were also exercised in a DOM environment without runtime errors. Physical iPhone layout, installation, and gesture behavior still need device verification.
