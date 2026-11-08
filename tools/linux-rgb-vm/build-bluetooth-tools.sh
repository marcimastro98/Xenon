#!/bin/bash
# For `start.mjs airpods`, in the container, once: btvirt with a signal strength. Stock it
# reports LE adverts as "RSSI not available", which a real radio never does and which the
# reader rightly ignores.
set -euo pipefail

OUT=${1:?where to put the tools}
BLUEZ=bluez-5.82
BLUEZ_URL=https://www.kernel.org/pub/linux/bluetooth/$BLUEZ.tar.xz
ADVERT_RSSI=-50

DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  build-essential pkg-config libglib2.0-dev libdbus-1-dev libreadline-dev xz-utils >/dev/null

WORK=$(mktemp -d)
curl -fsSL "$BLUEZ_URL" | tar -C "$WORK" -xJ
sed -i "s/lear\.rssi = 127;/lear.rssi = $ADVERT_RSSI;/; s/pdu\.ev\.rssi = 127;/pdu.ev.rssi = $ADVERT_RSSI;/" "$WORK/$BLUEZ/emulator/btdev.c"
(cd "$WORK/$BLUEZ" && ./configure -q --enable-testing --disable-systemd --disable-udev --disable-cups \
  --disable-obex --disable-manpages --disable-mesh --disable-midi --disable-datafiles >/dev/null \
  && mkdir -p lib/bluetooth && cp lib/*.h lib/bluetooth/ && make -s -j4 emulator/btvirt >/dev/null 2>&1)

mkdir -p "$OUT"
cp "$WORK/$BLUEZ/emulator/btvirt" "$OUT/btvirt"
rm -rf "$WORK"
