'use strict';
// Which package gives Sunshine and Tailscale on Windows, on each Linux package manager and on
// macOS, and the Windows services they install.

const { SUNSHINE_SERVICE, TAILSCALE_SERVICE } = require('./service.js');

// The Windows service each tool registers when it installs.
const WIN_SERVICES = { sunshine: SUNSHINE_SERVICE, tailscale: TAILSCALE_SERVICE };

const PACKAGES = {
  sunshine: 'LizardByte.Sunshine',
  tailscale: 'Tailscale.Tailscale',
  // Signed (MIT) Indirect Display Driver for the Second-screen feature — the only
  // external dependency; capture/encode lives in the Xenon Helper we already ship.
  // Windows-only for good: an Indirect Display Driver is a public, documented
  // Windows API with no counterpart elsewhere. macOS exposes no public virtual
  // display API at all, and on Linux it needs the evdi kernel module AND a
  // compositor willing to add an output — which GNOME's Wayland session is not.
  vdd: 'VirtualDrivers.Virtual-Display-Driver',
  // Only ever installed off Windows: on Windows the Browser widget uses Edge,
  // which ships with the OS. Listed here so resolveId() accepts the name.
  chromium: 'Hibbiki.Chromium',
};

// Linux: the same two packages, per package manager. The subcommand differs
// enough between families that a template is less readable than the list.
//
// VERIFIED: dnf, on the Fedora 43 machine this port was built against, where
// `tailscale` is 1.94.2 in Fedora's OWN repositories — no third-party repo to
// add, so the install is one prompt and nothing else. The other three are the
// same package under the same name in the same role, written from the
// distributions' conventions and NOT exercised here; they degrade to the manual
// instructions if the install fails, never to a wrong silent success.
const LINUX_PM = {
  dnf: (pkg) => ['dnf', 'install', '-y', pkg],
  'apt-get': (pkg) => ['apt-get', 'install', '-y', pkg],
  zypper: (pkg) => ['zypper', '--non-interactive', 'install', pkg],
  pacman: (pkg) => ['pacman', '-S', '--noconfirm', pkg],
};

const LINUX_PACKAGES = {
  // Installing the package is not enough, twice over, and both extras ride in
  // the SAME elevation — one prompt for the whole thing rather than three,
  // which is the difference between one click and a chore.
  //
  //  · the daemon does not start by itself, so the panel would report
  //    `not_running` immediately after a successful install;
  //  · and the user still could not drive it. tailscaled allows READS from
  //    anyone (its socket is srw-rw-rw-) but guards writes, so `tailscale up`
  //    comes back "Access denied: checkprefs access denied" while everything
  //    else looks healthy. The operator grant is the documented one-time fix,
  //    and doing it here means the user never meets the error at all.
  //
  // %USER% is substituted with the account the server runs as — never with
  // anything that came from a request.
  tailscale: {
    pkg: 'tailscale',
    service: 'tailscaled',
    post: ['tailscale set --operator=%USER%'],
  },
  // Sunshine is not in the distributions' repos, but IS on Flathub as the
  // project's own published build. Flatpak is tried first for exactly that
  // reason, and because it is the only route here that can install without
  // touching the system at all.
  sunshine: { pkg: 'sunshine', flatpak: 'dev.lizardbyte.app.Sunshine' },
  // The Browser widget drives any Chromium over the DevTools protocol — nothing
  // in it is Edge-specific. Chromium is the honest pick off Windows: it is in
  // every distribution's own repositories, and unlike Chrome or Edge it needs
  // no third-party repo and carries no extra terms to accept on somebody's
  // behalf.
  //
  // `preferNative` is the deliberate exception to flatpak-first, and it was
  // measured rather than assumed. The Flathub build launches fine and DevTools
  // even reports "listening on ws://127.0.0.1:PORT" — but the sandbox remaps
  // the filesystem, so `--user-data-dir` lands somewhere the host cannot see
  // and DevToolsActivePort never appears at the path the module reads. The
  // ad-blocker has the same problem: it passes --load-extension pointing into
  // DATA_DIR, which the sandbox cannot reach either. This widget has to hand
  // Chromium paths OUTSIDE its sandbox, so a sandboxed Chromium cannot serve
  // it. Costs one authorisation prompt and actually works.
  chromium: { pkg: 'chromium', flatpak: 'org.chromium.Chromium', preferNative: true },
};

// macOS: Homebrew or nothing. There is no system package manager to fall back
// on, and `brew` is the user's tool — if they do not have it, Xenon says so
// rather than installing a package manager behind their back.
//
// NOT VERIFIED ON A MAC. Both entries were checked against the upstream
// sources rather than guessed — `tailscale` is in homebrew-core and ships both
// the CLI and tailscaled; `sunshine` is NOT in core and needs LizardByte's own
// tap, which an earlier version of this table got wrong — but no Mac has run
// them. Every failure here lands on the manual-instructions path.
const MAC_PACKAGES = {
  // `brew services` would need root to install a daemon into
  // /Library/LaunchDaemons, but brew is never run as root (see installMac).
  tailscale: { brew: 'tailscale', service: 'tailscaled' },
  sunshine: { brew: 'sunshine', tap: 'LizardByte/homebrew' },
  // A cask, not a formula: it installs Chromium.app into /Applications, which
  // is exactly where BROWSER_CANDIDATES.darwin looks for it.
  chromium: { brew: 'chromium', cask: true },
};

module.exports = { WIN_SERVICES, PACKAGES, LINUX_PM, LINUX_PACKAGES, MAC_PACKAGES };
