import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cd = require('../call-detect.js');

// The classifier is the only thing standing between "a toast arrived" and "take
// over the whole screen with a ringing card", and it is a HEURISTIC for every
// source except Discord's structural path. So the tests are weighted towards
// the refusals: a missed call that raises a card is worse than a real call that
// does not, because the first one interrupts the user for something they cannot
// act on and trains them to ignore the card.

const teams = { app: 'Microsoft Teams', aumid: 'MSTeams_8wekyb3d8bbwe!MSTeams', title: 'Marco Rossi', body: 'Incoming call' };
const zoom = { app: 'Zoom', aumid: 'Zoom.exe', title: 'Zoom', body: 'Marco Rossi is calling you' };

test('a Teams ring is a call, and the caller is the title', () => {
  const c = cd.classifyNotification(teams, {});
  assert.ok(c, 'Teams incoming call should classify');
  assert.equal(c.appId, 'teams');
  assert.equal(c.caller, 'Marco Rossi');
  assert.equal(c.source, 'notification');
  assert.equal(c.video, false);
});

test('a Zoom ring puts the app name in the title, so the caller comes out of the body', () => {
  const c = cd.classifyNotification(zoom, {});
  assert.ok(c);
  assert.equal(c.appId, 'zoom');
  assert.equal(c.caller, 'Marco Rossi');
});

test('the ring is recognised in every language the dashboard speaks', () => {
  const rings = [
    ['it', 'Chiamata in arrivo'],
    ['es', 'Llamada entrante'],
    ['fr', 'Appel entrant'],
    ['de', 'Eingehender Anruf'],
    ['pt', 'Chamada recebida'],
    ['nl', 'Inkomende oproep'],
    ['ru', 'Входящий вызов'],
    ['ja', '着信'],
    ['ko', '수신 전화'],
    ['zh', '来电'],
  ];
  for (const [lang, body] of rings) {
    const c = cd.classifyNotification({ ...teams, body }, {});
    assert.ok(c, `${lang}: "${body}" should read as a ring`);
    assert.equal(c.caller, 'Marco Rossi', `${lang}: caller survives`);
  }
});

test('a MISSED call never rings — in any language', () => {
  const missed = [
    'Missed call', 'Chiamata persa', 'Llamada perdida', 'Appel manqué',
    'Verpasster Anruf', 'Chamada perdida', 'Gemiste oproep',
    'Пропущенный вызов', '不在着信', '부재중 전화', '未接来电',
  ];
  for (const body of missed) {
    assert.equal(cd.classifyNotification({ ...teams, body }, {}), null, `"${body}" must not ring`);
  }
});

test('a call that ENDED never rings', () => {
  for (const body of ['Call ended', 'Chiamata terminata', 'Anruf beendet', 'Call declined', '通话已结束']) {
    assert.equal(cd.classifyNotification({ ...teams, body }, {}), null, `"${body}" must not ring`);
  }
});

test('an app nobody configured is ignored, however call-like the text is', () => {
  const c = cd.classifyNotification({ app: 'Solitaire', aumid: 'games.solitaire', title: 'Anna', body: 'Incoming call' }, {});
  assert.equal(c, null);
});

test('an ordinary chat message from a configured app does not ring', () => {
  for (const body of ['Ci sentiamo dopo', 'sent a photo', 'Ok perfetto', 'ha reagito al tuo messaggio']) {
    assert.equal(cd.classifyNotification({ ...teams, body }, {}), null, `"${body}" must not ring`);
  }
});

test('the allowed list gates which apps may ring', () => {
  assert.ok(cd.classifyNotification(teams, { allowed: ['teams', 'zoom'] }));
  assert.equal(cd.classifyNotification(teams, { allowed: ['zoom'] }), null);
});

test('a user entry wins over a default for the same app', () => {
  const apps = [{ id: 'mine', name: 'Il mio telefono', match: ['msteams'] }];
  const c = cd.classifyNotification(teams, { apps });
  assert.ok(c);
  assert.equal(c.appId, 'mine', 'the user list is consulted first');
});

test('a video ring is flagged, because Teams accepts it with a different key', () => {
  assert.equal(cd.classifyNotification({ ...teams, body: 'Incoming video call' }, {}).video, true);
  assert.equal(cd.classifyNotification({ ...teams, body: 'Videochiamata in arrivo' }, {}).video, true);
  assert.equal(cd.classifyNotification({ ...teams, body: 'Incoming call' }, {}).video, false);
});

test('the same ring announced twice carries the same dedupe key', () => {
  const a = cd.classifyNotification(teams, {});
  const b = cd.classifyNotification({ ...teams, at: Date.now() + 1000 }, {});
  assert.equal(a.key, b.key);
  const other = cd.classifyNotification({ ...teams, title: 'Anna Bianchi' }, {});
  assert.notEqual(a.key, other.key, 'a different caller is a different call');
});

// ── Discord ────────────────────────────────────────────────────────────────

test('a Discord CALL message rings with no text matching at all', () => {
  const c = cd.classifyDiscord({ title: 'Marco', body: '', channelId: '123456789012345', messageType: 3 }, {});
  assert.ok(c);
  assert.equal(c.structural, true);
  assert.equal(c.channelId, '123456789012345');
  assert.equal(c.key, 'd:123456789012345', 'the channel identifies the call and is what answering needs');
});

test('a Discord CALL message that says the call ended is still refused', () => {
  const c = cd.classifyDiscord({ title: 'Marco', body: 'Call ended', channelId: '123456789012345', messageType: 3 }, {});
  assert.equal(c, null, 'type 3 is written on hang-up too — the wording keeps its veto');
});

test('Discord falls back to the wording when no message type arrives', () => {
  const c = cd.classifyDiscord({ title: 'Marco', body: 'is calling you', channelId: '999999999999999' }, {});
  assert.ok(c, 'the fallback exists because the structural path is unverified on a live ring');
  assert.equal(c.structural, false);
  assert.equal(c.caller, 'Marco');
});

test('an ordinary Discord DM does not ring', () => {
  assert.equal(cd.classifyDiscord({ title: 'Marco', body: 'ci sei?', channelId: '999999999999999' }, {}), null);
});

test('Discord obeys the allowed list like every other source', () => {
  const n = { title: 'Marco', body: '', channelId: '123456789012345', messageType: 3 };
  assert.ok(cd.classifyDiscord(n, { allowed: ['discord'] }));
  assert.equal(cd.classifyDiscord(n, { allowed: ['teams'] }), null);
});

// ── The pure helpers ───────────────────────────────────────────────────────

test('folding removes accents and is SYMMETRIC, which is the property that matters', () => {
  assert.equal(cd.foldText('Está a ligar'), 'esta a ligar');
  assert.equal(cd.foldText('Appel entrant'), 'appel entrant');
  assert.equal(cd.foldText('来电'), '来电');
  // Cyrillic и-breve (й) decomposes under NFD into и + U+0306, which sits inside
  // the combining-marks range we strip — so folding rewrites it. That is not
  // linguistically correct and is deliberately not "fixed": both the phrase list
  // and the incoming toast go through the SAME fold, so the comparison is
  // unaffected. Asserting the folded spelling would pin an implementation
  // detail; asserting that a Russian ring still matches pins the behaviour.
  assert.equal(cd.foldText('Входящий вызов'), cd.foldText('входящий вызов'));
  assert.equal(cd.looksLikeRing('Входящий вызов'), true);
  assert.equal(cd.looksLikeRing('Пропущенный вызов'), false);
});

test('the ring phrase is stripped off whichever end it sits on', () => {
  assert.equal(cd.stripRingPhrase('Marco Rossi is calling you'), 'Marco Rossi');
  assert.equal(cd.stripRingPhrase('Incoming call Marco Rossi'), 'Marco Rossi');
  assert.equal(cd.stripRingPhrase('Marco Rossi'), 'Marco Rossi');
});

test('a malformed item can never throw', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { title: null, body: {} }]) {
    assert.doesNotThrow(() => cd.classifyNotification(bad, {}));
    assert.doesNotThrow(() => cd.classifyDiscord(bad, {}));
  }
});
