#!/usr/bin/env python3
"""Install the private native-messaging host; browser loads the extension explicitly."""
import json,os,pathlib,shlex
root=pathlib.Path(__file__).resolve().parent.parent
binary=root/'backend/target/release/omarchy-remote'
if not binary.exists():raise SystemExit('Build the Rust release first.')
home=pathlib.Path.home(); folder=home/'.local/lib/omarchy-remote';folder.mkdir(parents=True,exist_ok=True)
launcher=folder/'browser-bridge';launcher.write_text('#!/bin/sh\nexec '+shlex.quote(str(binary))+' --browser-bridge "$@"\n');launcher.chmod(0o700)
extension_id=(root/'browser-extension/extension-id.txt').read_text().strip()
manifest={'name':'com.omarchy.remote_browser','description':'Omarchy Remote browser adapter','path':str(launcher),'type':'stdio','allowed_origins':['chrome-extension://'+extension_id+'/']}
for browser in ['vivaldi']:
 target=home/'.config'/browser/'NativeMessagingHosts';target.mkdir(parents=True,exist_ok=True)
 p=target/'com.omarchy.remote_browser.json';p.write_text(json.dumps(manifest,indent=2)+'\n');p.chmod(0o600)
print('Native host installed. In vivaldi://extensions, enable Developer mode, choose Load unpacked, and select:')
print(root/'browser-extension')
