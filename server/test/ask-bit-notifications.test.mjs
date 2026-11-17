// "Ask Bit" on the game recap and the heat alerts (server/briefing.js). The rules
// these tests hold:
//  - the dashboard and the alerts window of "widgets only" say the same words
//    (js/briefing-toast.js), in the user's hardware unit;
//  - the card carries "Ask Bit" only when someone can answer, and the question
//    is never sent by itself;
//  - with no dashboard the question goes to the search window through the server
//    (spotlight-ask/), kept once and briefly, closed to phones and web pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../js/briefing-toast.js');
const ask = require('../spotlight-ask/routes.js');
const { remotePathAllowed } = require('../remote-access.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const WORDS = {
  brief_recap_title: 'Session recap', brief_recap_fps: 'avg {avg} FPS (max {max})',
  brief_recap_gpu: 'GPU peak {v}°{u}', brief_recap_cpu: 'CPU peak {v}°{u}',
  brief_thermal_gpu: 'GPU has been at {v}°{u} for {m} minutes', brief_thermal_cpu: 'CPU has been at {v}°{u} for {m} minutes',
  brief_anomaly_title: 'Unusual temperature', brief_anomaly_gpu: 'GPU {v}°{u}, usually ~{b}°{u}', brief_anomaly_cpu: 'CPU {v}°{u}, usually ~{b}°{u}',
  bit_ask_recap: 'How did my {game} session go?', bit_ask_recap_last: 'How did my last game go?',
  bit_ask_hot_gpu: 'Why is my GPU this hot?', bit_ask_hot_cpu: 'Why is my CPU this hot?', xmenu_bit: 'Ask Bit',
};
const ctx = (hwF = false) => ({ t: (k) => WORDS[k] || k, hwF });

test('a game recap reads the session and asks about that game', () => {
  const m = B.describe({ type: 'recap', game: 'cyberpunk2077.exe', minutes: 134, avgFps: 87, maxFps: 141, gpuTempMax: 74 }, ctx());
  assert.deepEqual(m, {
    title: 'Session recap',
    text: 'Cyberpunk2077 · 2h 14min · avg 87 FPS (max 141) · GPU peak 74°C',
    question: 'How did my Cyberpunk2077 session go?',
  });
  const unnamed = B.describe({ type: 'recap', minutes: 12 }, ctx());
  assert.equal(unnamed.text, 'Session recap · 12 min');
  assert.equal(unnamed.question, 'How did my last game go?');
});

test('heat alerts follow the hardware unit and ask why', () => {
  const hot = B.describe({ type: 'thermal', metric: 'cpu', value: 92, minutes: 15 }, ctx(true));
  assert.equal(hot.text, 'CPU has been at 198°F for 15 minutes');
  assert.equal(hot.question, 'Why is my CPU this hot?');
  const odd = B.describe({ type: 'anomaly', metric: 'gpu', value: 80, baseline: 65 }, ctx());
  assert.equal(odd.title, 'Unusual temperature');
  assert.equal(odd.text, 'GPU 80°C, usually ~65°C', 'both temperatures and both units');
  assert.equal(B.describe({ type: 'other' }, ctx()), null);
  assert.equal(B.describe(null, ctx()), null);
});

test('the card has "Ask Bit" only with someone to answer, and asking sends nothing', () => {
  const m = B.describe({ type: 'thermal', metric: 'gpu', value: 90, minutes: 20 }, ctx());
  assert.deepEqual(B.toast(m, ctx(), null), { type: 'info', kicker: 'Xenon', title: m.text, message: '' });
  const asked = [];
  const card = B.toast(m, ctx(), (q) => asked.push(q));
  assert.equal(card.actions.length, 1);
  assert.equal(card.actions[0].label, 'Ask Bit');
  assert.ok(card.duration > 5000, 'room to reach the key');
  card.actions[0].onClick();
  assert.deepEqual(asked, ['Why is my GPU this hot?']);
  const noWords = B.toast(m, { t: (k) => k }, () => {});
  assert.equal(noWords.actions, undefined, 'no label, no key');
});

test('no hard °C and no em-dash in what the card prints', () => {
  for (const line of read('../js/briefing-toast.js').split('\n')) {
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    assert.ok(!/°C|—/.test(line), line.trim());
  }
});

test('the dashboard and the alerts window both use the shared card', () => {
  const amb = read('../js/ambient.js');
  assert.match(amb, /B\.describe\(d, ctx\)/);
  assert.match(amb, /window\.XenonToast\.show\(B\.toast\(moment, ctx, ask\)\)/);
  assert.match(amb, /bit\.ask\(q\)/, 'the dashboard opens its own chat');
  const moment = amb.slice(amb.indexOf('function onBriefingMoment('), amb.indexOf('function tick()'));
  assert.ok(moment.length > 0 && !/fillTemps|showHubToast|fmtMinutes/.test(moment), 'the old wording is gone from ambient.js');
  const alerts = read('../js/screen-alerts.js');
  assert.match(alerts, /B\.toast\(moment, ctx\(\), askInSearch\)/);
  assert.match(alerts, /fetch\(SERVER \+ '\/spotlight\/ask'/);
  assert.match(alerts, /calendar_reminder: reminder,\n    briefing,/, 'listened to only in "widgets only"');
  for (const page of ['../index.html', '../screen-alerts.html']) {
    assert.match(read(page), /<script src="js\/briefing-toast\.js"><\/script>/, page);
  }
  assert.ok(read('../index.html').indexOf('js/briefing-toast.js') < read('../index.html').indexOf('js/ambient.js'));
});

test('the search window takes the question on every show and opens the chat unsent', () => {
  const chat = read('../js/spotlight-chat.js');
  assert.match(chat, /fetch\('\/spotlight\/ask\/take', \{ method: 'POST' \}\)/);
  assert.match(chat, /window\.SpotlightChat\.open\(text, false\)/);
  const page = read('../js/spotlight-page.js');
  assert.equal((page.match(/if \(chat\(\)\) chat\(\)\.takeAsked\(\);/g) || []).length, 2, 'on boot and on every show');
});

// ── The server's hand-over ───────────────────────────────────────────────

test('a question is cleaned, kept once and only briefly', () => {
  assert.equal(ask.cleanQuestion('  Why?\n\u0007 '), 'Why?');
  assert.equal(ask.cleanQuestion('x'.repeat(900)).length, 500);
  assert.equal(ask.cleanQuestion(42), '');
  ask.keep('Why is my GPU this hot?', 1000);
  assert.equal(ask.take(1000 + ask.KEEP_MS), 'Why is my GPU this hot?');
  assert.equal(ask.take(1000 + ask.KEEP_MS), '', 'given out once');
  ask.keep('late', 1000);
  assert.equal(ask.take(1001 + ask.KEEP_MS), '', 'a stale one is dropped');
});

function run(handler, body, openSpotlight = () => {}) {
  const sent = [];
  return ask.routes[handler](null, null, { json: (v) => sent.push(v), readBody: async () => body, openSpotlight })
    .then(() => sent);
}

test('asking keeps the question and opens the search window; a bad body opens nothing', async () => {
  let opened = 0;
  const open = () => { opened += 1; };
  assert.deepEqual(await run('POST /spotlight/ask', JSON.stringify({ text: 'How did my last game go?' }), open), [{ ok: true }]);
  assert.equal(opened, 1);
  assert.deepEqual(await run('POST /spotlight/ask/take', ''), [{ ok: true, text: 'How did my last game go?' }]);
  for (const bad of ['not json', '{}', JSON.stringify({ text: '   ' })]) {
    assert.deepEqual(await run('POST /spotlight/ask', bad, open), [{ ok: false, error: 'bad_request' }], bad);
  }
  assert.equal(opened, 1);
  assert.deepEqual(await run('POST /spotlight/ask', JSON.stringify({ text: 'x' }), () => { throw new Error('no'); }), [{ ok: false, error: 'open_failed' }]);
  ask.stop();
});

test('neither path is open to a paired device, and both are CSRF-guarded', () => {
  const server = read('../server.js');
  const csrf = server.slice(server.indexOf('const CSRF_MUTATION_PATHS'), server.indexOf(']);', server.indexOf('const CSRF_MUTATION_PATHS')));
  for (const p of ['/spotlight/ask', '/spotlight/ask/take']) {
    assert.equal(remotePathAllowed(p, 'POST'), false, p);
    assert.ok(csrf.includes(`'${p}'`), p);
  }
  assert.match(server, /readBody, openSpotlight: routeSpotlightHotkey \}/);
});
