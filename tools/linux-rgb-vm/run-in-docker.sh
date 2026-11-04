#!/bin/bash
# The host side of the run, inside a throwaway container (start.mjs). The VM's disks and
# the files of the last run stay in the /cache volume between runs.
set -euo pipefail

CACHE=/cache
SHARE=$CACHE/share
TOOL=/repo/tools/linux-rgb-vm
IMAGE_URL=https://cloud.debian.org/images/cloud/trixie/latest/debian-13-generic-amd64.qcow2
BASE=$CACHE/debian-13.qcow2
PREPARED=$CACHE/prepared-$(sha256sum "$TOOL/cloud-init.yaml" | cut -c1-12).qcow2
SHARE_DISK=$CACHE/share.img
SERIAL=$CACHE/serial.log
RUN_DISK=/tmp/run.qcow2
SHARE_SPARE_MB=256
PREPARE_MAX_S=3000
RUN_MAX_S=600
ASLEEP_S=30
MONITOR_PORT=4444

log() { echo "[$(date +%T)] $*"; }

# No KVM under Docker Desktop, so the CPU is emulated: slow, and fine for this.
boot() {   # boot <disk> <serial log> <max seconds> [more qemu arguments]
  local disk=$1 serial=$2 max=$3
  shift 3
  timeout "$max" qemu-system-x86_64 -machine pc -accel tcg,thread=multi -cpu max -smp 4 -m 3072 \
    -drive "file=$disk,if=virtio" -drive "file=$SHARE_DISK,format=raw,if=virtio" \
    -nic user,model=virtio-net-pci -display none -serial "file:$serial" -no-reboot "$@"
}

# What we share with the VM is a disk, not a 9p folder: virtio-9p has no way back from a
# sleep, and whatever touches it hangs after waking.
make_share_disk() {   # make_share_disk <folder>
  rm -f "$SHARE_DISK"
  mke2fs -q -t ext4 -L share -d "$1" "$SHARE_DISK" "$(( $(du -sm "$1" | cut -f1) + SHARE_SPARE_MB ))M"
}

read_share_disk() {
  e2fsck -fy "$SHARE_DISK" >/dev/null 2>&1 || true   # a VM that died left its journal open
  rm -rf "$SHARE"
  mkdir -p "$SHARE"
  debugfs -R "rdump / $SHARE" "$SHARE_DISK" >/dev/null 2>&1
}

# Ends the sleep the way a person does. The clock alarm cannot: on ACPI it wakes through
# an event QEMU only raises from S3, and S3 panics here (guest-run.sh). Stays connected
# a moment, because QEMU drops a line from a client that hung up before its banner.
press_key_when_asleep() {
  until grep -qs 'PM: suspend entry' "$SERIAL"; do sleep 1; done
  sleep "$ASLEEP_S"
  exec 3<>"/dev/tcp/127.0.0.1/$MONITOR_PORT"
  sleep 1
  echo 'sendkey shift' >&3
  sleep 1
}

log 'installing qemu'
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  qemu-system-x86 qemu-utils genisoimage e2fsprogs curl ca-certificates >/dev/null

if [ ! -f "$BASE" ]; then
  log 'downloading Debian'
  curl -fsSL -o "$BASE.part" "$IMAGE_URL"
  mv "$BASE.part" "$BASE"
fi

if [ ! -f "$PREPARED" ]; then
  log 'preparing the VM (first run, or cloud-init.yaml changed)'
  rm -f "$CACHE"/prepared*.qcow2*
  cp "$BASE" "$PREPARED.part"
  qemu-img resize -q "$PREPARED.part" 6G
  mkdir -p /tmp/seed /tmp/empty
  cp "$TOOL/cloud-init.yaml" /tmp/seed/user-data
  printf 'instance-id: xenon-rgb-vm\nlocal-hostname: xenon-vm\n' > /tmp/seed/meta-data
  genisoimage -quiet -output /tmp/seed.iso -volid cidata -joliet -rock /tmp/seed/user-data /tmp/seed/meta-data
  make_share_disk /tmp/empty
  boot "$PREPARED.part" "$CACHE/prepare-serial.log" "$PREPARE_MAX_S" -drive file=/tmp/seed.iso,media=cdrom || true
  read_share_disk
  if [ ! -f "$SHARE/prepared-ok" ]; then
    log 'the VM did not finish preparing:'
    tail -n 40 "$CACHE/prepare-serial.log"
    exit 1
  fi
  mv "$PREPARED.part" "$PREPARED"
fi

log 'staging the app'
rm -rf "$SHARE"
mkdir -p "$SHARE/app" "$SHARE/node/bin"
cp "$(command -v node)" "$SHARE/node/bin/node"
tar -C /repo --exclude=server/data --exclude=server/whisper --exclude=server/helper \
  --exclude=server/test --exclude=server/shared -cf - server packages/core tools/linux-rgb-vm | tar -C "$SHARE/app" -xf -
ln -s ../packages/core "$SHARE/app/server/shared"
chmod -R a+rwX "$SHARE/app/server"   # the server runs as a normal user in the VM
version() { node -p "JSON.parse(require('fs').readFileSync('/repo/node_modules/$1/package.json')).version"; }
(cd "$SHARE/app" && npm init -y >/dev/null && npm install --omit=dev --no-audit --no-fund --loglevel=error \
  "koffi@$(version koffi)" "ws@$(version ws)" "msedge-tts@$(version msedge-tts)" >/dev/null)
make_share_disk "$SHARE"

log 'running the test in the VM'
qemu-img create -q -f qcow2 -F qcow2 -b "$PREPARED" "$RUN_DISK"
rm -f "$SERIAL"
press_key_when_asleep &
boot "$RUN_DISK" "$SERIAL" "$RUN_MAX_S" -monitor "tcp:127.0.0.1:$MONITOR_PORT,server,nowait" || log "qemu ended with $?"
read_share_disk

log 'checking what the chip saw'
node "$TOOL/check-run.mjs" "$SHARE"
