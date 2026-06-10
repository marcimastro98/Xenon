'use strict';

const defaultRunner = require('./runner');

const EXE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

function createTailscale({ runner = defaultRunner, exe = EXE } = {}) {
  async function getStatus() {
    const r = await runner.run(exe, ['status', '--json']);
    if (r.code !== 0) {
      return { installed: false, connected: false, ip: '' };
    }
    let data = {};
    try { data = JSON.parse(r.stdout); } catch { /* output non-JSON: trattare come non connesso */ }
    const connected = data.BackendState === 'Running';
    const ip = (data.Self && Array.isArray(data.Self.TailscaleIPs) && data.Self.TailscaleIPs[0]) || '';
    return { installed: true, connected, ip };
  }

  // Fire-and-observe: `tailscale up` apre il browser per il login OAuth e puo
  // restare in attesa. Timeout breve per non bloccare il server; il login reale
  // prosegue in background e lo stato si rileva poi via getStatus() (polling).
  async function startLogin() {
    return runner.run(exe, ['up'], { timeoutMs: 5000 });
  }

  return { getStatus, startLogin };
}

module.exports = { createTailscale, TAILSCALE_EXE: EXE };
