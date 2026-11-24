'use strict';
// Linux keeps a fan chip's controls (/sys/class/hwmon/*/pwmN and pwmN_enable) for root,
// and Xenon never runs as root. One udev rule hands those two kinds of file, and nothing
// else, to a group the person joins, each time the kernel adds a fan chip. Writing the
// rule takes root, so the person pastes one line, once (shown in the Fans section), then
// signs out and in again for the group to count. Sysfs files take no `uaccess` tag, unlike
// the USB controllers of lighting-native/linux-access.js, hence a group.

const GROUP = 'xenon-fans';
const RULE_FILE = '/etc/udev/rules.d/60-xenon-fans.rules';
// %p is the chip's path under /sys; a chip with no control leaves the glob unmatched.
const FILES = '/sys%p/pwm[0-9] /sys%p/pwm[0-9]_enable';

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

function udevRule() {
  return `ACTION=="add", SUBSYSTEM=="hwmon", RUN+="/bin/sh -c 'chgrp ${GROUP} ${FILES} 2>/dev/null; chmod g+w ${FILES} 2>/dev/null'"`;
}

function accessCommand() {
  return [
    `sudo groupadd -f ${GROUP}`,
    `sudo usermod -aG ${GROUP} "$USER"`,
    `echo ${shellQuote(udevRule())} | sudo tee ${RULE_FILE} >/dev/null`,
    'sudo udevadm control --reload-rules',
    'sudo udevadm trigger --subsystem-match=hwmon --action=add',
  ].join(' && ');
}

module.exports = { udevRule, accessCommand, GROUP, RULE_FILE };
