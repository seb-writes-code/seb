#!/bin/bash
# NanoClaw VM guest init script.
# Runs on boot inside the QEMU VM to:
#   1. Mount 9p shared directories (host volumes)
#   2. Parse environment variables from kernel command line
#   3. Start the agent runner with virtio-serial as transport
#
# Communication:
#   - Input:  Read from /dev/vport0p1 (virtio-serial, connected to host Unix socket)
#   - Output: Write to /dev/vport0p1

set -e

VIRTIO_PORT="/dev/vport0p1"

# Wait for virtio-serial port to appear
echo "Waiting for virtio-serial port..."
for i in $(seq 1 30); do
  [ -e "$VIRTIO_PORT" ] && break
  sleep 0.5
done

if [ ! -e "$VIRTIO_PORT" ]; then
  echo "ERROR: virtio-serial port $VIRTIO_PORT not found after 15s" >&2
  exit 1
fi

# Parse kernel command line for nanoclaw.mounts="mount0:/path,mount1:/path"
MOUNT_META=""
CMDLINE=$(cat /proc/cmdline)
if [[ "$CMDLINE" =~ nanoclaw\.mounts=\"([^\"]+)\" ]]; then
  MOUNT_META="${BASH_REMATCH[1]}"
fi

# Mount 9p shared directories
if [ -n "$MOUNT_META" ]; then
  IFS=',' read -ra MOUNT_PAIRS <<< "$MOUNT_META"
  for pair in "${MOUNT_PAIRS[@]}"; do
    TAG="${pair%%:*}"
    CONTAINER_PATH="${pair#*:}"
    mkdir -p "$CONTAINER_PATH"
    mount -t 9p -o trans=virtio,version=9p2000.L "$TAG" "$CONTAINER_PATH" 2>/dev/null || \
      echo "WARN: Failed to mount $TAG at $CONTAINER_PATH" >&2
  done
fi

# Parse kernel command line for nanoclaw.env="KEY=VAL,KEY=VAL"
if [[ "$CMDLINE" =~ nanoclaw\.env=\"([^\"]+)\" ]]; then
  ENV_PAIRS="${BASH_REMATCH[1]}"
  IFS=',' read -ra PAIRS <<< "$ENV_PAIRS"
  for pair in "${PAIRS[@]}"; do
    export "$pair"
  done
fi

# Compile agent-runner (same as Docker entrypoint)
cd /app
npx tsc --outDir /tmp/dist 2>&1 >&2
ln -sf /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Run agent-runner with virtio-serial as transport
# Input comes from virtio-serial, output goes to virtio-serial
echo "Starting agent runner via virtio-serial..."
cat "$VIRTIO_PORT" > /tmp/input.json &
CAT_PID=$!

# Wait for input (the host will write JSON then close the write end)
wait "$CAT_PID" 2>/dev/null || true

# Run the agent, piping output back through virtio-serial
node /tmp/dist/index.js < /tmp/input.json > "$VIRTIO_PORT" 2>/dev/null

# Signal completion and shut down
echo "Agent runner finished, shutting down VM..."
poweroff -f
