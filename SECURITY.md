# Security

Omarchy Remote gives a phone, tablet or desktop window a real shell on your computer. Treat the
address you publish it on like SSH access to your user account.

## The model

It is a single-user tool. There are no user accounts or logins: **anyone who can reach the published
address can open a shell as you.** Keep that address private.

- **Network exposure.** The backend (`127.0.0.1:4188`) and the web server and API gateway
  (`127.0.0.1:4187`) listen only on loopback. You choose how to publish the web server; the
  documented setup is Tailscale Serve on a tailnet-only HTTPS address. Do not expose it on the public
  internet or an untrusted network without access control of your own in front of it.
- **Gateway secret.** The backend accepts requests only when they carry `OMARCHY_PROXY_TOKEN`, which
  the gateway adds. Other local processes and direct connections cannot use the backend. The token
  lives in `~/.config/omarchy-remote/backend.env` (mode 0600) and is never sent to clients; the Files
  API refuses to read or overwrite that file.
- **Cross-site requests.** Browsers may only call the API from origins listed in `OMARCHY_ORIGINS`.
  API requests also need an `X-Hyprland-Client` header, which a plain cross-site form cannot send, and
  WebSockets must present an allowed `Origin`.
- **Files.** File browsing, upload and download are limited to your home directory, including through
  symlinks.
- **Browser adapter.** The Vivaldi/Chromium extension talks to the backend through Chrome native
  messaging and a mode-0600 Unix socket. No debugging port or TCP listener is opened, and the
  native-messaging host allows only the pinned extension id.
- **Native apps.** The iOS, Android and desktop apps give their native bridges only to the selected
  host's pages. Websites opened in the Browser app or as pinned web apps run in separate views with
  no access to those bridges. Android release builds require HTTPS and never skip certificate
  checks.

## Reporting a vulnerability

Please report security problems privately through GitHub's
[private vulnerability reporting](../../security/advisories/new) for this repository rather than in a
public issue. Include what you found, how to reproduce it, and the version or commit you tested.
