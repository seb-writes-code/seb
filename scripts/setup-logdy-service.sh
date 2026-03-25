#!/bin/bash
# Set up logdy as a systemd user service
# Usage: ./scripts/setup-logdy-service.sh <project-root> [port] [password]

set -euo pipefail

PROJECT_ROOT="${1:?Usage: setup-logdy-service.sh <project-root> [port] [password]}"
PORT="${2:-8080}"
PASSWORD="${3:-}"
LOGDY_BIN="${HOME}/.local/bin/logdy"

if [ ! -x "$LOGDY_BIN" ]; then
  echo "logdy not found at $LOGDY_BIN — run scripts/install-logdy.sh first"
  exit 1
fi

UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "$UNIT_DIR"

# Build ExecStart with optional password
EXEC_START="${LOGDY_BIN} follow ${PROJECT_ROOT}/logs/nanoclaw.json.log --port ${PORT}"
if [ -n "$PASSWORD" ]; then
  EXEC_START="${EXEC_START} --ui-pass ${PASSWORD}"
fi

cat > "${UNIT_DIR}/logdy.service" <<EOF
[Unit]
Description=Logdy Log Viewer for NanoClaw
After=network.target nanoclaw.service

[Service]
Type=simple
ExecStart=${EXEC_START}
WorkingDirectory=${PROJECT_ROOT}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable logdy
systemctl --user restart logdy

echo "logdy service started on port ${PORT}"
echo "Access: http://localhost:${PORT}"
