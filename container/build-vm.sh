#!/bin/bash
# Build a QEMU qcow2 image from the Docker container image.
# Exports the Docker filesystem and converts it into a bootable VM image.
#
# Prerequisites:
#   - Docker (to export the container filesystem)
#   - qemu-img (to create the qcow2 image)
#   - virt-make-fs (from libguestfs-tools, to build the filesystem)
#   - supermin / libguestfs (dependency of virt-make-fs)
#
# Usage:
#   ./container/build-vm.sh [output-path]
#
# The output defaults to /var/lib/nanoclaw/vm/nanoclaw-agent.qcow2

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DOCKER_IMAGE="${DOCKER_IMAGE:-nanoclaw-agent:latest}"
OUTPUT="${1:-/var/lib/nanoclaw/vm/nanoclaw-agent.qcow2}"
WORK_DIR=$(mktemp -d)

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

echo "=== Building NanoClaw VM image ==="
echo "Docker image: $DOCKER_IMAGE"
echo "Output: $OUTPUT"
echo ""

# Step 1: Ensure Docker image is built
echo "[1/5] Ensuring Docker image exists..."
if ! docker image inspect "$DOCKER_IMAGE" >/dev/null 2>&1; then
  echo "  Building Docker image first..."
  "$SCRIPT_DIR/build.sh"
fi

# Step 2: Export Docker filesystem
echo "[2/5] Exporting Docker filesystem..."
CONTAINER_ID=$(docker create "$DOCKER_IMAGE")
docker export "$CONTAINER_ID" > "$WORK_DIR/rootfs.tar"
docker rm "$CONTAINER_ID" >/dev/null
echo "  Exported $(du -sh "$WORK_DIR/rootfs.tar" | cut -f1)"

# Step 3: Add VM-specific files to the rootfs
echo "[3/5] Adding VM init scripts..."
# Create a temporary directory to add our init scripts
mkdir -p "$WORK_DIR/extra/etc/init.d"
mkdir -p "$WORK_DIR/extra/usr/local/bin"

# Copy the VM init script
cp "$SCRIPT_DIR/vm-init.sh" "$WORK_DIR/extra/usr/local/bin/nanoclaw-init.sh"
chmod +x "$WORK_DIR/extra/usr/local/bin/nanoclaw-init.sh"

# Create an init entry that runs our script on boot
cat > "$WORK_DIR/extra/etc/init.d/nanoclaw" << 'INITEOF'
#!/bin/bash
### BEGIN INIT INFO
# Provides:          nanoclaw
# Required-Start:    $local_fs
# Required-Stop:
# Default-Start:     2 3 4 5
# Default-Stop:
# Description:       NanoClaw agent runner
### END INIT INFO

case "$1" in
  start)
    /usr/local/bin/nanoclaw-init.sh &
    ;;
esac
INITEOF
chmod +x "$WORK_DIR/extra/etc/init.d/nanoclaw"

# Append the extra files to the rootfs tar
(cd "$WORK_DIR/extra" && tar rf "$WORK_DIR/rootfs.tar" .)

# Step 4: Create the qcow2 image
echo "[4/5] Creating qcow2 image (this may take a minute)..."
# Use virt-make-fs to create a bootable ext4 image from the tarball
# Size is generous to accommodate the full agent environment
virt-make-fs \
  --format=qcow2 \
  --type=ext4 \
  --size=+2G \
  "$WORK_DIR/rootfs.tar" \
  "$WORK_DIR/nanoclaw-agent.qcow2"

# Step 5: Install to output path
echo "[5/5] Installing image..."
mkdir -p "$(dirname "$OUTPUT")"
mv "$WORK_DIR/nanoclaw-agent.qcow2" "$OUTPUT"

echo ""
echo "=== VM image built successfully ==="
echo "Output: $OUTPUT"
echo "Size: $(du -sh "$OUTPUT" | cut -f1)"
echo ""
echo "To use: set QEMU_BASE_IMAGE=$OUTPUT"
echo "Then configure a group with runtime: 'qemu'"
