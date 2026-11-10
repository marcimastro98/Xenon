'use strict';
// Ping and packet loss for the Game performance tile. Network readings cost a
// collector run, so they are only taken while someone chose to see them, at most
// once every `minGapMs`, and ride the system tick: no timer of their own, and
// nothing runs with no client connected. Unlike the frame rate they mean
// something outside a game, so this does not depend on one running.
//
// deps (injected):
//   read()       → Promise<{ ping, loss }>   (getNetworkInfo)
//   wanted()     → boolean
//   broadcast(d) → void

const MIN_GAP_MS = 5000;

function createPerfNet({ read, wanted, broadcast, minGapMs = MIN_GAP_MS, now = Date.now }) {
  let lastAt = -Infinity;
  let busy = false;

  async function tick() {
    if (busy || !wanted() || now() - lastAt < minGapMs) return;
    lastAt = now();
    busy = true;
    try {
      const d = await read();
      broadcast({ ping: d.ping ?? null, loss: d.loss ?? null });
    } catch {
      // Said as "no reading": an old number would look like a live one.
      broadcast({ ping: null, loss: null });
    } finally {
      busy = false;
    }
  }

  return { tick };
}

module.exports = { createPerfNet, MIN_GAP_MS };
