#!/bin/sh
# Render deploy/*.service for this checkout and enable them as systemd user services.
# Usage: deploy/install.sh [--no-enable]
# Environment: OMARCHY_NODE (node binary, default: the node on PATH),
#              SYSTEMD_USER_DIR (default: ~/.config/systemd/user).
set -eu
repo=$(cd "$(dirname "$0")/.." && pwd)
node=${OMARCHY_NODE:-$(command -v node)}
target=${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}
env_file=$HOME/.config/omarchy-remote/backend.env
if [ ! -f "$env_file" ]; then
  echo "Create $env_file first (see README.md, Install on the host)." >&2
  exit 1
fi
if [ ! -x "$repo/backend/target/release/omarchy-remote" ]; then
  echo "Build the backend first: cargo build --release --manifest-path backend/Cargo.toml" >&2
  exit 1
fi
mkdir -p "$target"
for unit in omarchy-remote.service omarchy-remote-dev.service; do
  sed -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node|g" "$repo/deploy/$unit" > "$target/$unit"
done
echo "Wrote $target/omarchy-remote.service and $target/omarchy-remote-dev.service"
if [ "${1:-}" = "--no-enable" ]; then
  exit 0
fi
systemctl --user daemon-reload
systemctl --user enable --now omarchy-remote.service omarchy-remote-dev.service
systemctl --user --no-pager status omarchy-remote.service omarchy-remote-dev.service || true
