// What the last look at the task that starts Xenon at sign-in found, and what was repaired.

const startupTaskCheck = {
  // The in-app updater applies only the signed source zip, and the native helper is
  // a separate release asset (the Windows exe, the macOS tar.gz), so an updated install
  // kept a stale helper until INSTALL ran again. Heal it here — once per app version, and only
  // when a helper is already present — via helper-update.js, which installs only bytes
  // whose SHA-256 the release's Ed25519-SIGNED SHA256SUMS lists (pinned key, fail closed),
  // so this auto path never runs a swapped/MITM'd binary. Best-effort, off the boot hot
  // path; the fallbacks cover the gap until the next restart.
  // Last look at the per-logon startup task: whether Xenon will still be here
  // after the next sign-in. Held in memory so the dashboard can ask without
  // paying for a schtasks spawn per page load — see startup-task.js for why this
  // is checked at all, and why the three conditions are repaired while `disabled`
  // is only ever reported.
  last: { checked: false, found: false, problems: [], repaired: [], failed: '', at: 0 },
};

module.exports = { startupTaskCheck };
