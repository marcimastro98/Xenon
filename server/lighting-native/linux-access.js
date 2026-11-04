'use strict';
// Linux keeps a USB controller's device node for root. One udev rule gives it to
// whoever sits at the PC, the only way to reach the controller without running
// Xenon as root, and writing that rule takes root: the user pastes one line, once.
// Built here from the chip list, so a new chip can never miss it.

const P = require('./fusion2-protocol');

const RULE_FILE = '/etc/udev/rules.d/60-xenon-rgb.rules';   // below 73: uaccess is applied there

const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, '0');

// KERNELS is the name of the HID device above the hidraw node: bus, vendor, product.
function udevRule() {
  const devices = P.PRODUCT_IDS.map(id => `0003:${hex4(P.VENDOR_ID)}:${hex4(id)}.*`).join('|');
  return `KERNEL=="hidraw*", KERNELS=="${devices}", TAG+="uaccess"`;
}

function accessCommand() {
  return `echo '${udevRule()}' | sudo tee ${RULE_FILE} && sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=hidraw`;
}

module.exports = { udevRule, accessCommand };
