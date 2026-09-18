#!/usr/bin/env python3
"""Install the private native-messaging host; the browser loads the extension explicitly.

The host manifest allows exactly one extension id. By default that is the id in
browser-extension/extension-id.txt, which the "key" in browser-extension/manifest.json
pins for every unpacked load. Set OMARCHY_EXTENSION_ID to allow a different id, for
example after replacing that key with your own (see browser-extension/README.md).
"""
import json
import os
import pathlib
import shlex

root = pathlib.Path(__file__).resolve().parent.parent
binary = root / 'backend/target/release/omarchy-remote'
if not binary.exists():
    raise SystemExit('Build the Rust release first.')
home = pathlib.Path.home()
folder = home / '.local/lib/omarchy-remote'
folder.mkdir(parents=True, exist_ok=True)
launcher = folder / 'browser-bridge'
launcher.write_text('#!/bin/sh\nexec ' + shlex.quote(str(binary)) + ' --browser-bridge "$@"\n')
launcher.chmod(0o700)
extension_id = os.environ.get('OMARCHY_EXTENSION_ID') or (root / 'browser-extension/extension-id.txt').read_text().strip()
if len(extension_id) != 32 or set(extension_id) - set('abcdefghijklmnop'):
    raise SystemExit(f'Not a Chromium extension id: {extension_id!r}')
manifest = {
    'name': 'com.omarchy.remote_browser',
    'description': 'Omarchy Remote browser adapter',
    'path': str(launcher),
    'type': 'stdio',
    'allowed_origins': ['chrome-extension://' + extension_id + '/'],
}
for browser in ['vivaldi']:
    target = home / '.config' / browser / 'NativeMessagingHosts'
    target.mkdir(parents=True, exist_ok=True)
    path = target / 'com.omarchy.remote_browser.json'
    path.write_text(json.dumps(manifest, indent=2) + '\n')
    path.chmod(0o600)
print(f'Native host installed for extension {extension_id}.')
print('In vivaldi://extensions, enable Developer mode, choose Load unpacked, and select:')
print(root / 'browser-extension')
