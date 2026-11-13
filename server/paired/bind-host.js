// The address the engine listens on: this computer alone, or every network once paired devices
// are let in.

const { hub } = require('../settings/current.js');

// Where to bind. Loopback ONLY by default.
//
// This used to be '::', chosen for dual-stack loopback — the comment said
// "accepts both 127.0.0.1 and ::1", which is true but not the whole truth:
// '::' accepts from every address on the machine, so the dashboard was
// answering on the LAN. That is a real exposure, not a theoretical one. Xenon
// serves file search, a disk map, notes, calendar and an AI assistant with
// system actions behind no authentication at all, because it was designed on
// the premise that only this machine can reach it. Remote PC control is a
// separate thing entirely (Sunshine over Tailscale), and the Widget SDK
// documents "no network access". Nothing in the product needs the wider bind.
//
// On Windows the firewall prompt hid this; on Linux it depends on the distro —
// Fedora's firewalld blocks it, a minimal Arch or Debian desktop does not.
//
// Cost of the change: '[::1]:3030' no longer answers. Every caller in the tree
// uses 127.0.0.1 (the native app, install.sh, the bootstrap, the docs), so this
// is a URL nobody dials, and IPv6 loopback cannot be added without a second
// listener that would also have to duplicate the 'upgrade' handling below.
//
// XENON_BIND_HOST is the deliberate way back out — set it to '::' to restore
// the old all-interfaces behaviour, on purpose and in one place.
//
// CORRECTION, and the reason this is no longer a constant. Binding loopback
// unconditionally was an over-correction that silently killed the paired-device
// feature: the QR code advertises http://<lan-ip>:3030/pair, and nothing was
// listening there, so a phone on the same Wi-Fi got "Safari cannot connect".
// The reasoning above missed that the exposure it describes already HAS a
// guard — the paired-device door (see isAllowedRequest and the note beside it):
// off by default, deny-by-default allowlist, Host must be an IP literal this
// machine owns, per-device hashed token. That door is the thing the wider bind
// exists for, and it is the user's explicit opt-in.
//
// So: loopback while paired access is OFF, all interfaces while it is ON, and
// the switch rebinds. The default state of a fresh install is unchanged.
const BIND_HOST_ENV = process.env.XENON_BIND_HOST || '';
const BIND_LOOPBACK = '127.0.0.1';
const BIND_SHARED = '0.0.0.0';

function desiredBindHost() {
  if (BIND_HOST_ENV) return BIND_HOST_ENV;
  const ra = hub.settings && hub.settings.remoteAccess;
  return ra && ra.enabled === true ? BIND_SHARED : BIND_LOOPBACK;
}

const BIND_HOST = BIND_HOST_ENV || BIND_LOOPBACK;

module.exports = { BIND_HOST_ENV, BIND_LOOPBACK, BIND_SHARED, desiredBindHost, BIND_HOST };
