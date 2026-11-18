'use strict';
// This PC's IPv4 address on the local network, for the System tile's Network card. Read from
// os.networkInterfaces(), so it needs no PowerShell and reads the same on Windows, macOS and Linux.
//
// Only GET /network adds it, and only while the settings have networkShowIp on: getNetworkInfo() and
// the Widget SDK's `network` stream never carry it, so a third-party widget cannot read it.

const os = require('node:os');
const { pairingAddresses } = require('../paired/own-address.js');

// Adapters that are not the PC's own link to the router: hypervisor switches, containers, VPNs and
// tunnels, Apple's peer-to-peer links. Node names an interface by its system name (Windows: the
// name in Network Connections; macOS/Linux: en0, eth0, wlan0...).
const VIRTUAL_NAME = /virtual|vethernet|hyper-v|vmware|vmnet|virtualbox|vbox|docker|podman|wsl|^br-|^veth|^virbr|^lxc|^lxd|tailscale|zerotier|^zt|^utun|^tun|^tap|^wg|wireguard|vpn|^ppp|^ipsec|^awdl|^llw|^bridge|^anpi|^ham|loopback|bluetooth|^lo\d*$/i;
const LINK_LOCAL = /^169\.254\./;

/** @param {Record<string, any[]>} interfaces @param {(name: string) => boolean} keep */
function bestOf(interfaces, keep) {
  const kept = {};
  for (const [name, list] of Object.entries(interfaces || {})) {
    if (keep(name) && !VIRTUAL_NAME.test(name)) kept[name] = list;
  }
  // pairingAddresses ranks a home network's 192.168/10/172.16 first, as the pairing card does.
  return pairingAddresses(kept).find((a) => !LINK_LOCAL.test(a)) || null;
}

/**
 * The LAN IPv4 address, or null when the PC has none (offline, or only virtual adapters).
 * @param {{ interfaces?: Array<{ name?: string, kind?: string, up?: boolean }> } | null} [network]
 *   the network collector's reading: its physical, connected adapters are tried first, because the
 *   collector knows the hardware (on Windows the adapter's description) better than a name does.
 * @param {Record<string, any[]>} [interfaces] os.networkInterfaces(), given in tests
 * @returns {string | null}
 */
function lanAddress(network, interfaces = os.networkInterfaces()) {
  const list = network && Array.isArray(network.interfaces) ? network.interfaces : [];
  const physical = new Set(list.filter((n) => n && n.kind === 'physical' && n.up !== false).map((n) => String(n.name || '')));
  const fromHardware = physical.size ? bestOf(interfaces, (name) => physical.has(name)) : null;
  return fromHardware || bestOf(interfaces, () => true);
}

module.exports = { lanAddress };
