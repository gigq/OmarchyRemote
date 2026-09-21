---
name: omarchy-builds
description: Publish validated native Omarchy Remote iPhone and iPad builds to a host's private build dashboard, verify downloads, and maintain release notes. Use when distributing a signed IPA or updating the host's downloads page.
---

# Omarchy Remote build publishing

Users open **Builds** from the Omarchy Remote app launcher or pin it through Home’s app picker. An empty host shows a setup landing page and this skill; publishing the first build fills that app’s dashboard.

Run from the user's Omarchy Remote checkout. Read its `AGENTS.md` first. The host's existing app server serves `/builds/`; this is a reusable part of the repository, not a separate hosted service.

## Publish

1. Locate the already signed iOS IPA and its source revision. If a new build is requested, use the project's Apple build workflow first. Validate the actual IPA's native signature, physical-device platform, version and provisioning coverage on the build Mac. Do not infer successful signing from a filename or publish an unvalidated archive.
2. Find the user's private app HTTPS address from their configuration or ask for it if unavailable. Use that address plus `/builds` as `OMARCHY_DOWNLOAD_BASE_URL`. Do not copy another user's machine address, signing team or bundle identifier. The script reads app metadata from the IPA.
3. Run on the app host:

   ```sh
   python scripts/publish-native-build.py /absolute/path/to/App.ipa \
     --base-url "$OMARCHY_DOWNLOAD_BASE_URL" \
     --commit <revision-used-for-the-build> \
     --notes 'Concise user-facing changes and relevant limitations'
   ```

   With a remote host, transfer only the validated artifact using the user's established SSH connection, then run the command there. The default retained directory is `~/.local/share/omarchy-remote/builds`. If configured, `OMARCHY_BUILDS_DIR` must match the serving process. No service restart is needed after publishing. Do not put IPAs in Git or `public/`, where offline bundling would include them.

4. Fetch `/builds/`, `/builds/catalog.json`, and the new hash's `manifest.plist` through the actual HTTPS address. Download the manifest's IPA URL and compare its SHA-256 with the source artifact and catalog. Inspect the page at phone width when changing its layout. The publisher preserves exact IPA bytes and uses content hashes to retain older builds.
5. Report the dashboard link and build number. Distinguish download availability from actual device installation. Safari's **Install on device** link hands the manifest to iOS; the device must be covered by the profile, have Developer Mode enabled, and be able to reach the HTTPS server. A Tailscale-only host works away from home when the device is connected to that tailnet. Do not turn on public exposure to solve a private-network connection problem.

## Maintenance

The page template is `deploy/builds-template.html`; hosting is `scripts/build-downloads.mjs`, called by `scripts/serve.mjs`. `catalog.json` records metadata and checksums, not device UDIDs or signing credentials. Only explicit download assets are served. This skill is available on the dashboard as `SKILL.md` and should remain free of machine-specific values.

Re-publish the same IPA to update its notes without duplicate history. If the host address changes, re-publish retained IPAs with the new base URL to regenerate their manifests. Do not prune older artifacts automatically. Renew an expired profile through the project's signing workflow; rehosting does not extend signing validity.

For changes, run the repository's required checks plus `python -m unittest discover -s scripts -p 'test_build_downloads.py'` and `npm run test:ui -- tests/browser/build-downloads.spec.mjs`. Hosting and publishing do not require another native build. A new native bridge or Settings integration does.
