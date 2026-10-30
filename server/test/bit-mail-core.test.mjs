// Bit's mail (js/bit-mail-core.js): the letters store every promo channel files
// into instead of opening its own popup, and the one rule for when Bit may say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Core = require('../js/bit-mail-core.js');

const DAY = 24 * 3600 * 1000;

function makeStorage(seed) {
  const map = new Map(Object.entries(seed || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    _map: map,
  };
}

function harness(o = {}) {
  const clock = { t: o.now || 1_800_000_000_000 };
  const storage = makeStorage(o.seed);
  const state = { classes: o.classes || [], busy: !!o.busy, active: o.active || null, claims: 0, budget: o.budget !== false };
  const interrupts = {
    busy: () => state.busy,
    claimDaily: (ch) => { state.lastClaim = ch; if (!state.budget) return false; state.budget = false; state.claims++; return true; },
  };
  const doc = {
    body: { classList: { contains: (c) => state.classes.includes(c) } },
    get activeElement() { return state.active; },
  };
  const mail = Core.create({ storage, now: () => clock.t, interrupts, doc });
  return { mail, storage, clock, state };
}

const letter = (id, extra) => Object.assign({ id, kind: 'drop', title: 'Nitrato', line: 'This month’s supporter pack.' }, extra);

test('a letter is filed once: the same id posted again is not a second letter', () => {
  const { mail } = harness();
  assert.equal(mail.post(letter('drop:nitrato')), true);
  assert.equal(mail.post(letter('drop:nitrato')), false);
  assert.equal(mail.list().length, 1);
  assert.equal(mail.unread(), 1);
});

test('newest first, read marks it, and the count follows', () => {
  const { mail, clock } = harness();
  mail.post(letter('a'));
  clock.t += 1000;
  mail.post(letter('b'));
  assert.deepEqual(mail.list().map((l) => l.id), ['b', 'a']);
  mail.markRead('a');
  assert.equal(mail.unread(), 1);
  assert.equal(mail.list().find((l) => l.id === 'a').read, true);
});

test('a letter the user threw away never comes back, even when the channel posts it again', () => {
  const { mail } = harness();
  mail.post(letter('drop:nitrato'));
  mail.remove('drop:nitrato');
  assert.equal(mail.list().length, 0);
  assert.equal(mail.post(letter('drop:nitrato')), false);
  assert.equal(mail.list().length, 0);
});

test('it survives a reload: what was filed is read back from storage', () => {
  const { storage } = (() => { const h = harness(); h.mail.post(letter('a')); h.mail.markRead('a'); return h; })();
  const again = Core.create({ storage, now: () => 1_800_000_000_000, interrupts: null, doc: null });
  assert.equal(again.list().length, 1);
  assert.equal(again.list()[0].read, true);
});

test('stored data is checked on the way in: junk letters are dropped, never thrown on', () => {
  const seed = {
    [Core.K_MAIL]: JSON.stringify({
      letters: [
        { id: 'ok', kind: 'drop', title: 'Fine', line: '', at: 1_800_000_000_000, read: false, data: { entryId: 'nitrato' } },
        { id: '<img src=x>', kind: 'drop', title: 'bad id', at: 1 },
        { id: 'no-title', kind: 'drop', at: 1_800_000_000_000 },
        { id: 'bad-kind', kind: 'DROP!', title: 'x', at: 1_800_000_000_000 },
        'a string',
        null,
      ],
      gone: ['x', 42, '<script>'],
    }),
  };
  const { mail } = harness({ seed });
  assert.deepEqual(mail.list().map((l) => l.id), ['ok']);
  assert.deepEqual(mail.list()[0].data, { entryId: 'nitrato' });
  const broken = harness({ seed: { [Core.K_MAIL]: '{not json' } });
  assert.deepEqual(broken.mail.list(), []);
});

test('long text is cut to size and the data must be plain and small', () => {
  const { mail } = harness();
  mail.post(letter('long', { title: 'x'.repeat(500), line: 'y'.repeat(900), data: { big: 'z'.repeat(20000) } }));
  const l = mail.list()[0];
  assert.equal(l.title.length, Core.TITLE_MAX);
  assert.equal(l.line.length, Core.LINE_MAX);
  assert.deepEqual(l.data, {});
});

test('the box keeps the newest letters and forgets old ones', () => {
  const { mail, clock } = harness();
  for (let i = 0; i < Core.MAX_LETTERS + 5; i++) { mail.post(letter('n' + i)); clock.t += 1000; }
  assert.equal(mail.list().length, Core.MAX_LETTERS);
  assert.equal(mail.list().at(-1).id, 'n5');
  clock.t += Core.KEEP_DAYS * DAY + 1;
  mail.post(letter('fresh'));
  assert.deepEqual(mail.list().map((l) => l.id), ['fresh']);
});

test('a blocked storage loses nothing on screen and throws nothing', () => {
  const storage = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  const mail = Core.create({ storage, now: () => 1, interrupts: null, doc: null });
  assert.equal(mail.post(letter('a')), true);
  assert.equal(mail.unread(), 1);
});

test('Bit stays quiet while a game, a scene or a dialog is up (the arbiter says busy)', () => {
  const { mail, state } = harness();
  assert.equal(mail.quiet(), false);
  state.busy = true;
  assert.equal(mail.quiet(), true);
});

test('Bit stays quiet while you talk to it', () => {
  for (const c of ['ai-voice-mode', 'ai-listening']) {
    const { mail } = harness({ classes: [c] });
    assert.equal(mail.quiet(), true, c);
  }
});

test('Bit stays quiet while you type, in any text field or editable area', () => {
  const field = (tag, type, editable) => ({ tagName: tag, type: type || '', isContentEditable: !!editable });
  for (const el of [field('INPUT', 'text'), field('INPUT', 'search'), field('TEXTAREA'), field('DIV', '', true)]) {
    const { mail } = harness({ active: el });
    assert.equal(mail.quiet(), true, el.tagName + el.type);
  }
  for (const el of [field('BUTTON'), field('INPUT', 'checkbox'), field('INPUT', 'range'), field('BODY')]) {
    const { mail } = harness({ active: el });
    assert.equal(mail.quiet(), false, el.tagName + el.type);
  }
});

test('one note a day, shared with every other channel through the arbiter budget', () => {
  const { mail, state } = harness();
  assert.equal(mail.claimNote(), true);
  assert.equal(state.lastClaim, 'bit-mail');
  assert.equal(mail.claimNote(), false);
  assert.equal(state.claims, 1);
});
