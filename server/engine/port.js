// The port the engine listens on: 3030, or the one XENON_PORT names for a copy run beside it.

// Local backend port. Overridable via XENON_PORT for side-by-side debugging;
// any invalid/out-of-range value falls back to the canonical 3030 so a typo in
// the env var can never strand the server on a random port with a broken host allowlist.
const PORT = (() => {
  const raw = parseInt(process.env.XENON_PORT, 10);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 3030;
})();

module.exports = { PORT };
