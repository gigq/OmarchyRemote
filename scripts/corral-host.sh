#!/usr/bin/env bash
# Sets up Corral on another machine and lists it in this host's ~/Corral/hosts.json, so its
# agents join this Corral: builds the `corral` program for it, copies it there, runs it at login
# on the machine's Tailscale address, and adds the machine with its key.
#
#   scripts/corral-host.sh SSH_HOST [NAME]
#
# The machine needs SSH from here, Tailscale, and Claude Code or Codex signed in. macOS runs it
# with a LaunchAgent; Windows with a scheduled task at logon. Builds use Zig (cargo-zigbuild),
# so no Apple or Microsoft SDK is needed here. Run it again to update the program.
set -euo pipefail
host=${1:?usage: corral-host.sh SSH_HOST [NAME]}
name=${2:-$host}
port=4190
root=$(cd "$(dirname "$0")/.." && pwd)
build() {
  cargo zigbuild --quiet --release --manifest-path "$root/backend/Cargo.toml" -p corral \
    --bin corral --target "$1"
  echo "$root/backend/target/$1/release/corral$2"
}
ip=$(tailscale ip -4 "$host")
listen="$ip:$port"
# Windows' OpenSSH runs cmd, which has no uname.
kind=$(ssh -o BatchMode=yes "$host" uname -sm 2>/dev/null || echo Windows)
case $kind in
Darwin*)
  [[ $kind == *arm64 ]] && target=aarch64-apple-darwin || target=x86_64-apple-darwin
  binary=$(build $target '')
  ssh -o BatchMode=yes "$host" 'mkdir -p ~/.local/bin ~/Corral ~/Library/LaunchAgents'
  scp -q "$binary" "$host:.local/bin/corral.new"
  ssh -o BatchMode=yes "$host" bash -s -- "$listen" "$name" <<'EOF'
set -e
mv ~/.local/bin/corral.new ~/.local/bin/corral
plist=~/Library/LaunchAgents/dev.corral.serve.plist
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.corral.serve</string>
  <key>ProgramArguments</key><array>
    <string>$HOME/.local/bin/corral</string><string>serve</string>
    <string>--listen</string><string>$1</string><string>--name</string><string>$2</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Corral/corral.log</string>
</dict></plist>
PLIST
# The login session, which has the keychain Claude Code signs in with; else the user's.
uid=$(id -u)
for domain in gui/$uid user/$uid; do
  launchctl bootout "$domain" "$plist" 2>/dev/null || true
  launchctl bootstrap "$domain" "$plist" 2>/dev/null && exit 0
done
echo "launchctl could not load $plist" >&2
exit 1
EOF
  key=$(ssh -o BatchMode=yes "$host" '~/.local/bin/corral key')
  ;;
*)
  binary=$(build x86_64-pc-windows-gnu .exe)
  task=$(mktemp)
  cat >"$task" <<EOF
\$exe = "\$env:USERPROFILE\\.local\\bin\\corral.exe"
\$log = "\$env:USERPROFILE\\Corral\\corral.log"
New-Item -ItemType Directory -Force -Path "\$env:USERPROFILE\\Corral" | Out-Null
Stop-ScheduledTask -TaskName Corral -ErrorAction SilentlyContinue
Stop-Process -Name corral -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Move-Item -Force "\$exe.new" \$exe
# conhost --headless keeps the console program's window from showing.
\$arguments = "--headless cmd.exe /c \`"\`"\$exe\`" serve --listen $listen --name $name >> \`"\$log\`" 2>&1\`""
\$action = New-ScheduledTaskAction -Execute "\$env:SystemRoot\\System32\\conhost.exe" -Argument \$arguments -WorkingDirectory \$env:USERPROFILE
\$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
\$trigger = New-ScheduledTaskTrigger -AtLogOn -User \$user
\$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
\$principal = New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName Corral -Description "Corral: this machine's agents, for the person's Corral" -Action \$action -Trigger \$trigger -Settings \$settings -Principal \$principal -Force | Out-Null
Start-ScheduledTask -TaskName Corral
EOF
  ssh -o BatchMode=yes "$host" 'if not exist "%USERPROFILE%\.local\bin" mkdir "%USERPROFILE%\.local\bin"' 2>/dev/null
  scp -q "$binary" "$host:.local/bin/corral.exe.new"
  scp -q "$task" "$host:corral-task.ps1"
  rm -f "$task"
  ssh -o BatchMode=yes "$host" \
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%USERPROFILE%\corral-task.ps1" & del "%USERPROFILE%\corral-task.ps1"' 2>/dev/null
  key=$(ssh -o BatchMode=yes "$host" '"%USERPROFILE%\.local\bin\corral.exe" key' 2>/dev/null | tr -d '\r')
  ;;
esac
# The key goes in hosts.json, readable only by this account, and is never printed.
python3 - "$name" "http://$listen" "$key" <<'EOF'
import json, os, sys
name, url, key = sys.argv[1:]
path = os.path.join(os.environ.get('OMARCHY_CORRAL_DIR') or os.path.expanduser('~/Corral'), 'hosts.json')
hosts = json.load(open(path)) if os.path.exists(path) else []
hosts = [h for h in hosts if h['name'] != name] + [{'name': name, 'url': url, 'key': key}]
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, (json.dumps(hosts, indent=2) + '\n').encode())
os.close(fd)
EOF
for _ in 1 2 3 4 5 6; do
  if printf 'header = "Authorization: Bearer %s"\n' "$key" |
    curl -sf -m 5 --config - "http://$listen/api/corral/host" >/dev/null; then
    echo "$name: Corral is running at http://$listen and listed in hosts.json."
    exit 0
  fi
  sleep 2
done
echo "$name: listed in hosts.json, but Corral does not answer at http://$listen yet." >&2
exit 1
