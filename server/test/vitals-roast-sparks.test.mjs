// Bit's AI roasts on Sparks (server/vitals-roast-sparks.js): never without a
// daily number the user picked, never past it, counted across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from './browser-source.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';

const require = createRequire(import.meta.url);
const R = require('../vitals-roast-sparks.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const reply = (credits) => async () => ({ text: 'Drink some water.', credits });

test('the daily number: only the offered values, none by default', () => {
  assert.equal(R.cleanRoastSparksCap(25), 25);
  assert.equal(R.cleanRoastSparksCap('50'), 50);
  for (const bad of [undefined, null, 7, -10, 1e9, 'lots']) assert.equal(R.cleanRoastSparksCap(bad), 0);
});

test('no number, no roast: the provider is never asked', async () => {
  const r = R.createRoastSparks();
  let asked = 0;
  assert.equal(await r.spend(0, async () => { asked++; return { text: 'x' }; }), '');
  assert.equal(await r.spend(undefined, async () => { asked++; return { text: 'x' }; }), '');
  assert.equal(asked, 0);
});

test('spends up to the number, then stops until the next day', async () => {
  let t = new Date(2026, 9, 30, 12).getTime();
  const r = R.createRoastSparks({ now: () => t });
  assert.equal(await r.spend(10, reply(6)), 'Drink some water.');
  assert.equal(await r.spend(10, reply(6)), 'Drink some water.', '6 of 10 spent: one more fits');
  let asked = false;
  assert.equal(await r.spend(10, async () => { asked = true; return { text: 'x' }; }), '', '12 of 10: over');
  assert.equal(asked, false);
  t = new Date(2026, 9, 31, 8).getTime();
  assert.equal(await r.spend(10, reply(1)), 'Drink some water.', 'a new day');
});

test('a reply without a charge still counts one Spark; a refusal that billed nothing counts none', async () => {
  const r = R.createRoastSparks();
  for (let i = 0; i < 10; i++) await r.spend(10, reply(undefined));
  assert.equal(await r.spend(10, reply(1)), '', 'ten uncharged replies used the ten');
  const r2 = R.createRoastSparks();
  const noCredits = async () => { throw Object.assign(new Error('empty'), { code: 'no_credits' }); };
  for (let i = 0; i < 20; i++) assert.equal(await r2.spend(10, noCredits), '');
  assert.equal(await r2.spend(10, reply(1)), 'Drink some water.');
  const r3 = R.createRoastSparks();
  const broke = async () => { throw new Error('socket hang up'); };
  for (let i = 0; i < 10; i++) await r3.spend(10, broke);
  assert.equal(await r3.spend(10, reply(1)), '', 'a broken call may have billed');
});

test('one roast at a time', async () => {
  const r = R.createRoastSparks();
  let release;
  const slow = r.spend(10, () => new Promise((res) => { release = () => res({ text: 'first', credits: 1 }); }));
  await new Promise((res) => setImmediate(res));
  assert.equal(await r.spend(10, reply(1)), '', 'the second is refused while the first is out');
  release();
  assert.equal(await slow, 'first');
});

test('the count survives a restart', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'roast-sparks-'));
  try {
    const t = new Date(2026, 9, 30, 12).getTime();
    await R.createRoastSparks({ dataDir: dir, now: () => t }).spend(25, reply(25));
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'vitals-roast-sparks.json'), 'utf8')), { day: '2026-10-30', spent: 25 });
    assert.equal(await R.createRoastSparks({ dataDir: dir, now: () => t }).spend(25, reply(1)), '', 'restarted: still spent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring: settings on both sides, the roast route, the client and the row', () => {
  const S = engineSource();
  assert.match(S, /roastSparksCap: cleanRoastSparksCap\(petSrc\.roastSparksCap\),/);
  assert.match(S, /const roastSparks = createRoastSparks\(\{ dataDir: DATA_DIR \}\);/);
  const roast = S.slice(S.indexOf("reqPath === '/api/vitals/roast'"), S.indexOf("reqPath === '/api/log'"));
  assert.match(roast, /\} else if \(provider === 'xenon'\) \{[\s\S]{0,200}text = await roastSparks\.spend\(petCfg\.roastSparksCap,/);
  const settings = read('../js/settings.js');
  assert.match(settings, /const VITALS_ROAST_SPARKS_CAPS = Object\.freeze\(\[0, 10, 25, 50, 100\]\);/);
  assert.deepEqual([...R.ROAST_SPARKS_CAPS], [0, 10, 25, 50, 100], 'client and server offer the same numbers');
  assert.match(settings, /roastSparksCap: VITALS_ROAST_SPARKS_CAPS\.includes\(Number\(petSrc\.roastSparksCap\)\) \? Number\(petSrc\.roastSparksCap\) : 0,/);
  assert.match(settings, /row\.hidden = hubSettings\.aiProvider !== 'xenon';/);
  assert.match(read('../js/vitals-pet.js'), /if \(onSparks && !\(Number\(pet\.roastSparksCap\) > 0\)\) return bank\(\);/);
  assert.match(read('../index.html'), /<select [^>]*id="settings-vpet-sparks"[^>]*onchange="updateVitalsRoastSparksCap\(this\.value\)"/);
});
