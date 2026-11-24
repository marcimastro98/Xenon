// The colour step of the LINK probe (--colours): the chain laid out as Xenon lays it out
// (server/airflow/corsair-link-lights.js), then frames anyone can check by eye: every light
// red, green, blue, then one white light running round each part in the order the lighting
// map draws it (a pump starts where iCUE starts its ring). A chain with a device whose LEDs
// were never measured is not painted: the log says so, for a tester to report.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../server/airflow/corsair-link-protocol.js');
const { layoutOf, frameOf } = require('../../server/airflow/corsair-link-lights.js');

const STILL = Object.freeze([['red', { r: 255, g: 0, b: 0 }], ['green', { r: 0, g: 255, b: 0 }], ['blue', { r: 0, g: 0, b: 255 }]]);
const WHITE = Object.freeze({ r: 255, g: 255, b: 255 });
const DIM = Object.freeze({ r: 0, g: 0, b: 24 });
// A still colour is sent again every REPEAT_MS for STILL_MS: the hub keeps its software mode.
const STILL_MS = 1500;
const REPEAT_MS = 500;
const SPIN_MS = 100;

/**
 * @param {{ s: any, chain: { channel: number, type: number, model: number }[], log: (m: string) => void,
 *   sleep: (ms: number) => Promise<void>, stop: () => Promise<boolean> }} o
 *   s: the session; stop: reads the speeds, true when a pump fell (the probe stops)
 * @returns {Promise<{ painted: number, why: string|null }>}
 */
export async function paintSteps({ s, chain, log, sleep, stop }) {
  const layout = layoutOf(chain);
  if (!layout.ok) {
    log(`colours: not painted (${layout.why})`);
    return { painted: 0, why: layout.why };
  }
  const ids = layout.segments.flatMap((g) => g.ledIds);
  let painted = 0;
  const paint = async (colorOf) => {
    await s.paint(P.colourData(frameOf(layout, ids, ids.map(colorOf))));
    painted++;
  };
  for (const [name, c] of STILL) {
    log(`colours: every light ${name}`);
    for (let t = 0; t < STILL_MS; t += REPEAT_MS) {
      await paint(() => c);
      await sleep(REPEAT_MS);
    }
    if (await stop()) return { painted, why: 'stopped' };
  }
  for (const g of layout.segments) {
    log(`colours: a white light round the ${g.kind} (${g.ledIds.length} lights)`);
    for (const lit of g.ledIds) {
      await paint((id) => (id === lit ? WHITE : DIM));
      await sleep(SPIN_MS);
    }
    if (await stop()) return { painted, why: 'stopped' };
  }
  return { painted, why: null };
}
