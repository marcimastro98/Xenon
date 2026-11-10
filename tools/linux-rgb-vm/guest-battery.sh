#!/bin/bash
# Inside the VM, as root, at boot: what a Linux user with a 2.4 GHz dongle goes through.
# Refused, paste the line the widget shows, read. check-battery-run.mjs judges the files
# this leaves. Started by guest-run.sh; always ends in a shutdown, which tells the host.
set -u

S=/mnt/share
APP=$S/app
NODE=$S/node/bin/node
U=xenon
USER_ID=$(id -u "$U")
READ_MAX_S=180

say()  { echo "[$(date +%T)] $*" | tee -a "$S/guest.log"; }
mark() { echo "{\"t\":$(date +%s%3N),\"mark\":\"$1\"}" >> "$S/marks.jsonl"; say "== $1"; }
as_user() { runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" "$@"; }
finish() { say 'done'; sync; systemctl poweroff; exit 0; }

wait_for() {   # wait_for <seconds> <what> <command...>
  local max=$1 what=$2
  shift 2
  for _ in $(seq "$max"); do
    "$@" >/dev/null 2>&1 && return 0
    sleep 1
  done
  say "TIMED OUT waiting for $what"
  return 1
}

user_session() { loginctl show-user "$U" -p State 2>/dev/null | grep -q active; }
nodes_ready() { [ "$(grep -l '^HID_ID=0003:0000\(3151\|046D\):' /sys/class/hidraw/hidraw*/device/uevent 2>/dev/null | wc -l)" -ge 4 ]; }
akko_node() { grep -l '3151:00004011' /sys/class/hidraw/hidraw*/device/uevent | head -n1 | cut -d/ -f5; }
user_can_open() { getfacl -p "/dev/$(akko_node)" 2>/dev/null | grep -q "^user:$U:rw"; }

read_as_user() {   # read_as_user <true|false> <file>
  as_user timeout "$READ_MAX_S" "$NODE" -e "require('$APP/server/device-battery').read({ask:$1}).then(r=>console.log(JSON.stringify(r)))" > "$S/$2" 2>> "$S/guest.log"
  say "$2: $(cat "$S/$2")"
}

say "kernel $(uname -r)"
modprobe uhid
wait_for 300 'the login on tty1' user_session || finish
"$NODE" "$APP/tools/linux-rgb-vm/fake-dongle.mjs" "$S/devices.jsonl" &
wait_for 60 'the simulated dongles' nodes_ready || finish
getfacl -p "/dev/$(akko_node)" > "$S/acl-before.txt" 2>&1

mark refused-start
read_as_user true read-refused.json
mark refused-end

# Exactly what the widget tells the person to paste.
"$NODE" -p "require('$APP/server/device-battery/access').accessFor('linux').command" > "$S/command.txt"
say "pasting: $(cat "$S/command.txt")"
as_user sh -c "$(cat "$S/command.txt")" >> "$S/guest.log" 2>&1
wait_for 60 'the access rule' user_can_open
getfacl -p "/dev/$(akko_node)" > "$S/acl-after.txt" 2>&1

mark allowed-start
read_as_user true read-allowed.json
mark allowed-end

read_as_user false read-switched-off.json
mark switched-off-end

finish
