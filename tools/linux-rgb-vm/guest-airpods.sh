#!/bin/bash
# Inside the VM, as root, at boot: the AirPods reader against the real bluetoothd and kernel
# Bluetooth stack. btvirt gives two virtual controllers on one virtual air: hci1 plays the pair,
# broadcasting the bytes heard from real AirPods Pro, hci0 is the PC. check-airpods-run.mjs
# judges the files this leaves. Started by guest-run.sh; always ends in a shutdown.
set -u

S=/mnt/share
APP=$S/app
NODE=$S/node/bin/node
U=xenon
# The start of what a real pair in its case sent on 4 Nov 2026: both buds 100, case 70. Not all
# 27 bytes: a full-length advert overflows a buffer in btvirt, which then aborts.
ADVERT="0x07 0x19 0x01 0x24 0x20 0x73 0xaa 0x97 0x31 0x00 0x04 0x1d"
READ_MAX_S=40
TOTAL_MAX_S=420

say() { echo "[$(date +%T)] $*" | tee -a "$S/guest.log"; }
finish() { say 'done'; sync; systemctl poweroff; exit 0; }
as_user() { runuser -u "$U" -- "$@"; }
pair_prop() { busctl --system set-property org.bluez /org/bluez/hci1 org.bluez.Adapter1 "$@"; }

read_as_user() {   # read_as_user <true|false> <file>
  as_user timeout "$READ_MAX_S" "$NODE" -e "require('$APP/server/device-battery').read({ask:$1}).then(r=>console.log(JSON.stringify(r)))" > "$S/$2" 2>&1
  say "$2: $(cut -c1-300 "$S/$2")"
}

connected() {
  bluetoothctl info "$PAIR" </dev/null 2>/dev/null | grep -q 'Connected: yes'
}

( sleep "$TOTAL_MAX_S"; say 'time is up'; sync; systemctl poweroff ) &

say "kernel $(uname -r), $(bluetoothctl --version)"
modprobe hci_vhci
printf '[General]\nClass = 0x240404\nDeviceID = bluetooth:004C:2024:0B80\nDiscoverableTimeout = 0\nPairableTimeout = 0\n' > /etc/bluetooth/main.conf
"$S/bluetooth-tools/btvirt" -l2 >> "$S/btvirt.log" 2>&1 &
sleep 6
systemctl restart bluetooth
sleep 4
PC=$(bluetoothctl list </dev/null | sed -n '1s/Controller \([0-9A-F:]*\).*/\1/p')
PAIR=$(bluetoothctl list </dev/null | sed -n '2s/Controller \([0-9A-F:]*\).*/\1/p')
say "PC $PC, pair $PAIR"

pair_prop Powered b true
pair_prop Alias s 'AirPods Pro'
pair_prop Pairable b true
pair_prop Discoverable b true

# The pair's side stays up to the end: its output also shows every scan the PC starts.
mkfifo /tmp/pair-in
timeout 320 bluetoothctl < /tmp/pair-in > "$S/pair.log" 2>&1 &
exec 3> /tmp/pair-in
sleep 2
printf 'select %s\nagent NoInputNoOutput\ndefault-agent\n' "$PAIR" >&3
sleep 1

# Real AirPods pair over classic Bluetooth and broadcast apart, so pairing comes first: with an
# advert in the air bluetoothd would try LE.
say '== pairing'
( for _ in $(seq 10); do sleep 2; printf 'yes\n' >&3; done ) &
( sleep 2
  printf 'select %s\nagent NoInputNoOutput\ndefault-agent\nscan on\n' "$PC"; sleep 8
  printf 'pair %s\n' "$PAIR"
  for _ in $(seq 6); do sleep 2; printf 'yes\n'; done
  printf 'scan off\n'; sleep 1
  printf 'info %s\nquit\n' "$PAIR"
) | timeout 40 bluetoothctl > "$S/connect.log" 2>&1
wait_paired=$(bluetoothctl info "$PAIR" </dev/null 2>/dev/null | grep -c 'Paired: yes')
say "paired: $wait_paired"

printf 'menu advertise\nmanufacturer 0x004c %s\nname off\nback\nadvertise peripheral\n' "$ADVERT" >&3
sleep 4

bluetoothctl disconnect "$PAIR" </dev/null >/dev/null 2>&1
for _ in $(seq 15); do connected || break; sleep 1; done

say '== paired but not connected, advert in the air'
cp "$S/pair.log" "$S/pair-before.log"
read_as_user true read-none.json
cp "$S/pair.log" "$S/pair-none.log"

# The virtual pair has no audio profile, so BlueZ drops an idle link: pings hold it up.
( while :; do l2ping -c 2 -t 2 "$PAIR" >> "$S/l2ping.log" 2>&1; done ) &
PING=$!
for _ in $(seq 15); do connected && break; sleep 1; done
connected && say 'pair connected' || say 'pair NOT connected'

say '== connected'
btmon -i hci0 > "$S/btmon.log" 2>&1 &
MON=$!
sleep 1
read_as_user true read-connected.json
kill "$MON"
bluetoothctl show "$PC" </dev/null | grep 'Discovering' > "$S/after-read.txt"
cp "$S/pair.log" "$S/pair-connected.log"

say '== asking off'
read_as_user false read-off.json

say '== reader killed in the middle of its scan'
# The pings let the virtual link lapse now and then, and a reader that finds it down never scans.
for _ in $(seq 6); do
  until connected; do sleep 0.2; done
  as_user "$NODE" -e "require('$APP/server/device-battery/bluez.js').readBluez({ask:true,guard:{enter(){},leave(){}}})" &
  for _ in $(seq 25); do
    bluetoothctl show "$PC" </dev/null | grep 'Discovering' > "$S/during-kill.txt"
    grep -q 'Discovering: yes' "$S/during-kill.txt" && break 2
    sleep 0.2
  done
done
say "before the kill: $(cat "$S/during-kill.txt")"
pkill -9 -f readBluez
sleep 3
bluetoothctl show "$PC" </dev/null | grep 'Discovering' > "$S/after-kill.txt"

say '== disconnected'
kill "$PING"
bluetoothctl disconnect "$PAIR" </dev/null >/dev/null 2>&1
sleep 3
read_as_user true read-gone.json
finish
