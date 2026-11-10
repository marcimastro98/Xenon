'use strict';
// What the OS needs before dongles can be read, for the UI to say. Linux keeps hidraw
// nodes for root until a udev rule grants them to the logged-in user, for these vendors
// only; macOS asks for Input Monitoring, which only the person can turn on.

const { vendorIds } = require('./brands');
const razer = require('./razer');

const RULES_FILE = '/etc/udev/rules.d/70-xenon-battery.rules';

// KERNELS is the name of the HID device above the hidraw node: bus, vendor, product. It
// has the same shape on any USB device, the way lighting's rule matches its chip.
function udevRule() {
  const devices = [...new Set([...vendorIds, razer.VENDOR_ID])]
    .map((id) => `0003:${id.toString(16).toUpperCase().padStart(4, '0')}:*`)
    .sort();
  return `KERNEL=="hidraw*", KERNELS=="${devices.join('|')}", TAG+="uaccess"`;
}

function udevCommand() {
  return `echo '${udevRule()}' | sudo tee ${RULES_FILE} >/dev/null && sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=hidraw`;
}

function accessFor(platform) {
  if (platform === 'darwin') return { kind: 'input-monitoring' };
  if (platform === 'linux') return { kind: 'udev', command: udevCommand() };
  return null;
}

module.exports = { accessFor, udevRule };
