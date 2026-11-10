#!/bin/bash
# Inside the VM, as root, at boot. Walks what a Linux user with a GIGABYTE board goes
# through, on the real server, and writes down what happened for check-run.mjs: the
# chip logs its side, this script the marks between the phases. Always ends in a real
# shutdown, which is both the last phase and how the host learns the run is over.
set -u

S=/mnt/share
APP=$S/app
NODE=$S/node/bin/node
U=xenon
[ -f "$S/battery-run" ] && exec bash "$APP/tools/linux-rgb-vm/guest-battery.sh"
[ -f "$S/airpods-run" ] && exec bash "$APP/tools/linux-rgb-vm/guest-airpods.sh"
USER_ID=$(id -u "$U")
API=http://127.0.0.1:3030
SERVER_UP_MAX_S=600
WAKE_MAX_S=120
SETTLE_AFTER_WAKE_S=15

say()  { echo "[$(date +%T)] $*" | tee -a "$S/guest.log"; }
mark() { echo "{\"t\":$(date +%s%3N),\"mark\":\"$1\"}" >> "$S/marks.jsonl"; say "== $1"; }
as_user() { runuser -u "$U" -- env XDG_RUNTIME_DIR="/run/user/$USER_ID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$USER_ID/bus" "$@"; }
post() { curl -s -m 60 -X POST -H 'Content-Type: application/json' -d "$2" "$API$1" >/dev/null; }
status() { curl -s -m 30 "$API/api/lighting/status"; }

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

server_up() { curl -s -m 5 -o /dev/null "$API/version"; }
native_settled() { [ "$(status | jq -r .native.starting)" = false ]; }
controller_open() { [ "$(status | jq -r '.native.controllers | length')" = 1 ]; }
user_session() { loginctl show-user "$U" -p State 2>/dev/null | grep -q active; }
chip_node() { grep -l '048D:00005711' /sys/class/hidraw/hidraw*/device/uevent 2>/dev/null | head -n1 | cut -d/ -f5; }
chip_ready() { [ -n "$(chip_node)" ]; }
woke_up() { dmesg | grep -q 'PM: suspend exit'; }

start_server() {
  as_user systemd-run --user --quiet --collect --unit=xenon-server --working-directory="$APP/server" "$NODE" "$APP/server/server.js"
  wait_for "$SERVER_UP_MAX_S" 'the server' server_up
}

say "kernel $(uname -r), sleep states: $(cat /sys/power/state)"
say "tools: $(command -v gdbus dbus-monitor systemd-inhibit | tr '\n' ' ')"
modprobe uhid
# So a sleep that goes wrong says where.
dmesg -n 8
echo N > /sys/module/printk/parameters/console_suspend
echo 1 > /sys/power/pm_print_times
echo 1 > /sys/power/pm_debug_messages
wait_for 300 'the login on tty1' user_session
loginctl list-sessions --no-legend | tee -a "$S/guest.log"

# Stops after the user's services at a shutdown, so a late write still reaches it.
cat > /run/systemd/system/fake-chip.service <<EOF
[Unit]
After=user.slice systemd-logind.service
RequiresMountsFor=$S
[Service]
ExecStart=$NODE $APP/tools/linux-rgb-vm/fake-it5711.mjs $S/chip.jsonl
EOF
systemctl daemon-reload
systemctl start fake-chip
wait_for 60 'the simulated chip' chip_ready
CHIP=/dev/$(chip_node)
say "chip at $CHIP"
getfacl -p "$CHIP" > "$S/acl-before.txt" 2>&1

# What logind actually sends, seen by the same tools, as the same user, as the server.
as_user gdbus monitor --system --dest org.freedesktop.login1 --object-path /org/freedesktop/login1 > "$S/gdbus.txt" 2>&1 &
as_user dbus-monitor --system "type='signal',sender='org.freedesktop.login1',interface='org.freedesktop.login1.Manager'" > "$S/dbus-monitor.txt" 2>&1 &

start_server

mark refused
post /api/lighting/native '{"enabled":true}'
sleep 3
wait_for 60 'native lighting to settle' native_settled
status > "$S/refused.json"

mark permission
as_user bash -c "$(jq -r .native.accessCommand "$S/refused.json")" >> "$S/guest.log" 2>&1
sleep 3
getfacl -p "$CHIP" > "$S/acl-after.txt" 2>&1

mark found
post /api/lighting/native/scan '{}'
wait_for 60 'the controller' controller_open
status > "$S/found.json"

mark paint
post /api/lighting/effects '{"enabled":true}'
post /api/lighting/manual '{"color":"red"}'
sleep 10
systemd-inhibit --list --no-pager > "$S/inhibit.txt" 2>&1

mark quit
as_user systemctl --user stop xenon-server
sleep 3
start_server
wait_for 120 'the controller again' controller_open
sleep 10

# Suspend to idle, ended by a key the host presses (run-in-docker.sh). Coming back from
# S3 panics this kernel on QEMU's emulated CPU (a bogus debug exception in syscore_resume);
# what Xenon sees is the same.
mark suspend
echo s2idle > /sys/power/mem_sleep
echo enabled > /sys/devices/platform/i8042/serio0/power/wakeup
systemctl suspend
wait_for "$WAKE_MAX_S" 'the wake' woke_up
sleep "$SETTLE_AFTER_WAKE_S"
mark woke
systemd-inhibit --list --no-pager > "$S/inhibit-after.txt" 2>&1
dmesg | grep -E 'PM: suspend (entry|exit)' > "$S/suspend-kernel.txt"
sleep 5

mark poweroff
systemctl poweroff
