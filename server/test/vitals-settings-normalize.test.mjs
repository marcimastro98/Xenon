// The Vitals settings the dashboard (js/settings.js) and the server (server.js)
// both rebuild from known keys: natural breaks and Bit's quiet window survive a
// save on either side, with the same defaults and the same clamps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

// One top-level declaration, from its first line to the closing brace at column 0.
function slice(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  const end = src.indexOf('\n}', at);
  return src.slice(at, end + 2);
}

function normalizerFrom(file) {
  const src = read(file);
  const consts = ['VITALS_IDS', 'VITALS_DEFAULT_MIN', 'VITALS_DEFAULT_ON', 'VITALS_PET_STAGES', 'VITALS_PET_DEFAULT_THR']
    .map((name) => src.match(new RegExp('^const ' + name + ' = .*;$', 'm'))[0]);
  const hour = src.match(/^function vitalsHour\(.*\}$/m)[0];
  const code = consts.join('\n') + '\n' + hour + '\n' + slice(src, 'function clampNumber(') + '\n' + slice(src, 'function normalizeVitals(') + '\nthis.normalizeVitals = normalizeVitals;';
  const box = {};
  vm.runInNewContext(code, box);
  return box.normalizeVitals;
}

const SIDES = [['dashboard', normalizerFrom('js/settings.js')], ['server', normalizerFrom('server.js')]];

test('natural breaks are on unless turned off, on both sides', () => {
  for (const [side, norm] of SIDES) {
    assert.equal(norm({}).naturalBreaks, true, side + ' default');
    assert.equal(norm({ naturalBreaks: false }).naturalBreaks, false, side + ' off');
    assert.equal(norm({ naturalBreaks: 'no' }).naturalBreaks, true, side + ' junk reads as the default');
  }
});

test('Bit\'s quiet window defaults to 23-7 and keeps whole hours from 0 to 23, on both sides', () => {
  for (const [side, norm] of SIDES) {
    const def = norm({}).pet;
    assert.deepEqual([def.quietFrom, def.quietTo], [23, 7], side + ' default');
    const set = norm({ pet: { quietFrom: 1, quietTo: 9 } }).pet;
    assert.deepEqual([set.quietFrom, set.quietTo], [1, 9], side + ' kept');
    const wild = norm({ pet: { quietFrom: 40, quietTo: -3 } }).pet;
    assert.deepEqual([wild.quietFrom, wild.quietTo], [23, 7], side + ' out of range reads as the default');
    const frac = norm({ pet: { quietFrom: 22.5, quietTo: '6' } }).pet;
    assert.deepEqual([frac.quietFrom, frac.quietTo], [23, 7], side + ' only whole numeric hours');
    const junk = norm({ pet: { quietFrom: 'late', quietTo: null } }).pet;
    assert.deepEqual([junk.quietFrom, junk.quietTo], [23, 7], side + ' junk reads as the default');
  }
});

test('wiring: a natural break refills after Bit\'s episodes move, and the pet sleeps in the chosen window', () => {
  const vitals = read('js/vitals.js');
  const shift = vitals.indexOf('petPatch = { ...ps, ep };');
  const brk = vitals.indexOf("v.naturalBreaks !== false ? core.naturalBreak(");
  assert.ok(shift > 0 && brk > shift, 'the refill is not counted as an episode shift');
  assert.match(read('js/vitals-pet.js'), /core\.isNight\(new Date\(\)\.getHours\(\), pet\.quietFrom, pet\.quietTo\)/);
  const html = read('index.html');
  assert.match(html, /id="settings-vitals-naturalbreaks" type="checkbox" onchange="updateVitalsSetting\('naturalBreaks', this\.checked\)"/);
  for (const [id, field] of [['quiet-from', 'quietFrom'], ['quiet-to', 'quietTo']]) {
    const sel = html.match(new RegExp('<select[^>]*id="settings-vpet-' + id + '"[^>]*>([\\s\\S]*?)</select>'));
    assert.ok(sel, id);
    assert.ok(sel[0].includes("updateVitalsPetQuietHour('" + field + "', this.value)"), id + ' saves ' + field);
    assert.equal((sel[1].match(/<option value="\d+"/g) || []).length, 24, id + ' offers every hour');
  }
});
