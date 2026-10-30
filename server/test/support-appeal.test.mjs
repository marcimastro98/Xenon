// The December appeal and the supporter count it carries.
//
// Once a year, in December, a short note from the person who makes Xenon with
// the number that says where the project stands. It is the one-time ask's
// yearly sibling: everything that keeps the ask from becoming a nag applies to
// it too, plus a calendar gate. These tests hold those rules in place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync as readFileSyncRaw } from 'node:fs';
// A Windows checkout (core.autocrlf) has CRLF; everything below matches on LF.
const readFileSync = (p, enc) => { const s = readFileSyncRaw(p, enc); return typeof s === 'string' ? s.replace(/\r\n/g, '\n') : s; };

const APPEAL = readFileSync(new URL('../js/support-appeal.js', import.meta.url), 'utf8');
const GOAL = readFileSync(new URL('../js/support-goal.js', import.meta.url), 'utf8');
const SETTINGS = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const HTML = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const I18N = readFileSync(new URL('../js/i18n.js', import.meta.url), 'utf8');
const ASK_CSS = readFileSync(new URL('../components/SupportAsk/SupportAsk.css', import.meta.url), 'utf8');
const GOAL_CSS = readFileSync(new URL('../components/SupportGoal/SupportGoal.css', import.meta.url), 'utf8');
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'nl', 'ru', 'ko', 'ja', 'zh'];
const KEYS = ['support_appeal_title', 'support_appeal_text', 'support_appeal_text_plain',
  'support_goal_line', 'support_goal_count', 'support_goal_met'];

function body(src, anchor, end = '\n  }') {
  const from = src.indexOf(anchor);
  assert.ok(from >= 0, 'missing: ' + anchor);
  const fn = src.slice(from);
  return fn.slice(0, fn.indexOf(end));
}

// Every value of `key`, keyed by language block.
function stringsOf(key) {
  const out = new Map();
  let current = null;
  for (const line of I18N.split('\n')) {
    const ns = line.match(/^ {2}"?([a-z]{2})"?: \{/) || line.match(/^Object\.assign\(i18n\.([a-z]{2})/);
    if (ns) current = ns[1];
    const m = line.trimStart().match(new RegExp('^"?' + key + '"?:\\s*("(?:[^"\\\\]|\\\\.)*")'));
    if (m) out.set(current, JSON.parse(m[1]));
  }
  return out;
}

test('December only, and at most once a calendar year', () => {
  assert.match(APPEAL, /const DECEMBER = 11;/);
  const due = body(APPEAL, 'function dueThisYear(c)');
  assert.match(due, /now\.getMonth\(\) === DECEMBER && c\.supportAppealYear\(\) < now\.getFullYear\(\)/);
  const gate = body(APPEAL, 'async function maybeShow()');
  assert.match(gate, /if \(!dueThisYear\(c\)\) return;/);
});

// Two requests for money a few days apart is the nag both cards exist to avoid.
test('it comes only after the one-time ask, and a month after it', () => {
  assert.match(APPEAL, /const DAYS_AFTER_ASK = 30;/);
  const gate = body(APPEAL, 'async function maybeShow()');
  assert.match(gate, /if \(!c\.supportAskDismissed\(\)\) return;/);
  assert.match(gate, /if \(askDay && a\.daysSince\(askDay\) < DAYS_AFTER_ASK\) return;/);
});

test('it keeps the ask\'s usage gate and never reaches a supporter', () => {
  assert.match(APPEAL, /const DAYS_SINCE_FIRST_RUN = 30;/);
  assert.match(APPEAL, /const DISTINCT_DAYS_USED = 10;/);
  const gate = body(APPEAL, 'async function maybeShow()');
  assert.match(gate, /if \(!use\) return;/, 'nothing is decided before the stored answer is known');
  assert.match(gate, /a\.daysSince\(use\.firstRunDay\) < DAYS_SINCE_FIRST_RUN\) return;/);
  assert.match(gate, /use\.usageDays < DISTINCT_DAYS_USED\) return;/);
  assert.match(gate, /if \(await a\.alreadySupporter\(\)\) return;/);
  assert.match(gate, /typeof c\.rememberSupportAppeal !== 'function' \|\| !a\) return;/,
    'an appeal that cannot be remembered is never shown');
});

// A boot where the moment is wrong does not use up the year.
test('the moment is re-checked just before it shows, and never over another card', () => {
  const later = body(APPEAL, 'setTimeout(() => {', '\n    }, SHOW_AFTER_MS);');
  assert.match(later, /if \(a\.busyRightNow\(\)\) return;/);
  assert.match(later, /if \(screenTaken\(\)\) return;/);
  assert.match(later, /if \(!dueThisYear\(c\)\) return;/, 'December 31 can turn into January 1 during the wait');
  const taken = body(APPEAL, 'function screenTaken()');
  for (const id of ['discord-invite']) {
    assert.match(taken, new RegExp(`getElementById\\('${id}'\\)`), id + ' holds it back');
  }
  assert.match(taken, /I\.busy\(\)/, 'and so does anything the interrupt arbiter calls busy');
});

test('every exit is final for the year, and "I already support Xenon" for good', () => {
  for (const anchor of ['close.addEventListener', 'monthly.addEventListener', 'once.addEventListener']) {
    const fn = body(APPEAL, anchor, '});');
    assert.match(fn, /remember\(\);/, anchor + ' remembers');
  }
  assert.match(body(APPEAL, 'function remember()'), /rememberSupportAppeal\(new Date\(\)\.getFullYear\(\)\)/);
  const already = body(APPEAL, 'already.addEventListener', '});');
  assert.match(already, /silence\(\);/);
  assert.match(already, /a\.thankSupporter\(\);/, 'and answers them the way the ask does');
  assert.match(body(APPEAL, 'function silence()'), /silenceSupportAppeal\(\)/);
});

test('its presses are counted under their own label', () => {
  assert.match(body(APPEAL, 'function supportLink(plan)'), /c\.supportUrl\('app-appeal', plan\)/);
  assert.match('app-appeal', /^[a-z0-9][a-z0-9_-]{0,23}$/, 'a label the redirect accepts');
});

// Same home on disk as the ask's flag, for the same reason.
test('the year lives in hub settings, only moves forward, and never in localStorage', () => {
  assert.match(SETTINGS, /const SUPPORT_APPEAL_NEVER = 9999;/);
  const rem = body(SETTINGS, 'function rememberSupportAppeal(year)', '\n}');
  assert.match(rem, /if \(y <= supportAppealYear\(\)\) return;/, 'a year never goes back');
  assert.match(rem, /supportAppealYear: y/);
  assert.match(body(SETTINGS, 'function silenceSupportAppeal()', '\n}'), /rememberSupportAppeal\(SUPPORT_APPEAL_NEVER\)/);
  assert.match(body(SETTINGS, 'function rememberSupportAskSeen()', '\n}'), /supportAskSeenDay: toDateInputValue\(new Date\(\)\)/,
    'the ask stamps its day so the month between the two can be kept');
  assert.match(SETTINGS, /supportAskSeenDay: \/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\/\.test/, 'the client normaliser knows the day');
  assert.match(SETTINGS, /supportAppealYear: Math\.min\(9999, Math\.max\(0, Math\.floor/, 'and the year');
  assert.match(SETTINGS, /supportAskSeenDay,\n\s*supportAppealYear,\n\s*rememberSupportAppeal,\n\s*silenceSupportAppeal,/,
    'all on the startup-cards namespace');
  assert.doesNotMatch(APPEAL.replace(/\/\/.*$/gm, ''), /localStorage/);
});

test('the server stores both, and a stale client save cannot rewind them', () => {
  assert.match(SERVER, /supportAskSeenDay: '',/, 'a default on disk');
  assert.match(SERVER, /supportAppealYear: 0,/);
  assert.match(SERVER, /supportAskSeenDay: DAY_RE\.test\(String\(source\.supportAskSeenDay \|\| ''\)\)/, 'normalised');
  assert.match(SERVER, /supportAppealYear: clampNumber\(Math\.floor\(Number\(source\.supportAppealYear\) \|\| 0\), 0, 9999, 0\),/);
  const post = SERVER.slice(SERVER.indexOf("reqPath === '/settings' && req.method === 'POST'"));
  const block = post.slice(0, post.indexOf('} else if (reqPath'));
  assert.match(block, /if \(prev\.supportAskSeenDay\) incoming\.supportAskSeenDay = prev\.supportAskSeenDay;/);
  assert.match(block, /if \(Number\(prev\.supportAppealYear\) > \(Number\(incoming\.supportAppealYear\) \|\| 0\)\) \{\n\s*incoming\.supportAppealYear = prev\.supportAppealYear;/);
});

// A goal bar with a guessed figure in it is a claim nobody can check.
test('the count is never invented: no answer, no line', () => {
  const clean = body(GOAL, 'function cleanGoal(d)');
  assert.match(clean, /d\.ok !== true \|\| !Number\.isInteger\(active\) \|\| active < 0\) return null;/);
  assert.match(clean, /Number\.isInteger\(target\) && target > 0 \? target : null/);
  assert.match(body(GOAL, 'async function load()'), /catch \{ return null; \}/);
  const render = body(GOAL, 'function render(box, goal)');
  assert.match(render, /if \(!goal \|\| !line\) \{ box\.hidden = true; return; \}/);
  assert.doesNotMatch(GOAL + APPEAL, /\.innerHTML = (?!a\.(HEART|CLOSE))/, 'text only ever goes in as text');
  assert.match(GOAL, /fetch\('\/api\/community\/support-goal'/, 'asked of this server, never straight of the hub');
});

// support-goal.js run for real, against a two-element stand-in for its box.
function goalModule() {
  const strings = {
    support_goal_line: 'goal {target}, now {n}',
    support_goal_met: 'met, thanks to {n}',
    support_goal_count: 'count {n}',
  };
  const window = { t: (k) => strings[k] || k };
  vm.runInNewContext(GOAL, { window });
  return window.XenonSupportGoal;
}
function goalBox() {
  const line = { textContent: '' };
  const bar = { hidden: false, max: 1, value: 0, setAttribute() {} };
  return { hidden: true, line, bar, querySelector: (s) => (s === '.support-goal-line' ? line : s === 'progress' ? bar : null) };
}

// Past the goal a full bar reads as "done, nothing left to give to", and people
// do give less once a goal is met. So the bar steps aside and the line thanks.
test('short of the goal it shows the bar; once reached it thanks instead', () => {
  const G = goalModule();
  const short = goalBox();
  G.render(short, { active: 30, target: 45 });
  assert.equal(short.line.textContent, 'goal 45, now 30');
  assert.deepEqual([short.hidden, short.bar.hidden, short.bar.value, short.bar.max], [false, false, 30, 45]);
  for (const active of [45, 52]) {
    const met = goalBox();
    G.render(met, { active, target: 45 });
    assert.equal(met.line.textContent, 'met, thanks to ' + active);
    assert.equal(met.bar.hidden, true, active + ' of 45 shows no bar');
  }
  const count = goalBox();
  G.render(count, { active: 30, target: null });
  assert.equal(count.line.textContent, 'count 30');
  assert.equal(count.bar.hidden, true, 'no target, no bar');
  const none = goalBox();
  G.render(none, null);
  assert.equal(none.hidden, true, 'no answer, no line');
  assert.equal(G.shortOfGoal({ active: 44, target: 45 }), true);
  for (const g of [{ active: 45, target: 45 }, { active: 30, target: null }, null]) {
    assert.equal(G.shortOfGoal(g), false, JSON.stringify(g) + ' is not short');
  }
});

// "For now it doesn't pay for itself" is a claim, so it is made only while the
// count backs it: never past the goal, and never with no count to check.
test('the note says the costs are not covered only while the count says so', () => {
  const note = body(APPEAL, 'function noteText(goal)', '\n  }\n');
  assert.match(note, /if \(G && G\.shortOfGoal\(goal\)\) \{\n\s*return t\('support_appeal_text',/);
  assert.match(note, /return t\('support_appeal_text_plain',/);
  assert.match(body(APPEAL, 'function showCard(goal)'), /el\('p', 'discord-invite-text', noteText\(goal\)\)/);
  for (const [lang, s] of stringsOf('support_appeal_text_plain')) {
    assert.ok(s.length < stringsOf('support_appeal_text').get(lang).length, lang + ': the costs sentence is the part left out');
  }
});

test('the count route is local, cached, and a navigation cannot spend it', () => {
  assert.match(SERVER, /reqPath === '\/api\/community\/support-goal' && req\.method === 'GET'/);
  const csrf = SERVER.slice(SERVER.indexOf('const CSRF_MUTATION_PATHS = new Set(['));
  assert.match(csrf.slice(0, csrf.indexOf(']);')), /'\/api\/community\/support-goal'/);
});

test('it is loaded, styled in its own pink, and every string exists in all eleven languages', () => {
  assert.match(HTML, /<script src="js\/support-goal\.js"><\/script>\n<script src="js\/support-appeal\.js"><\/script>/);
  assert.match(HTML, /components\/SupportGoal\/SupportGoal\.css/);
  assert.match(HTML, /id="settings-support-goal" hidden/, 'the Settings copy starts hidden');
  assert.match(SETTINGS, /XenonSupportGoal\.fill\(\$\('settings-support-goal'\)\)/, 'and is filled when the page opens');
  assert.match(ASK_CSS, /\.support-appeal \.support-goal \{\n\s*--goal-fill: var\(--sup-pink\);/);
  assert.doesNotMatch(GOAL_CSS, /--accent/, 'the bar follows its holder, never the theme accent');
  for (const key of KEYS) {
    const missing = LANGS.filter((l) => !stringsOf(key).has(l));
    assert.deepEqual(missing, [], `${key} missing from: ${missing.join(', ')}`);
  }
});

test('the note speaks plainly, and every number has its place in every language', () => {
  let checked = 0;
  for (const key of KEYS) {
    for (const [lang, s] of stringsOf(key)) {
      checked++;
      assert.ok(!s.includes('—'), `em dash in ${lang}.${key}`);
    }
  }
  assert.equal(checked, KEYS.length * LANGS.length);
  for (const [lang, s] of stringsOf('support_goal_line')) {
    assert.match(s, /\{target\}/, lang + ' has the goal');
    assert.match(s, /\{n\}/, lang + ' has the count');
  }
  for (const key of ['support_goal_count', 'support_goal_met']) {
    for (const [lang, s] of stringsOf(key)) assert.match(s, /\{n\}/, `${lang}.${key} has the count`);
  }
  // "from 5 up": the note names the monthly floor the site and the hub use.
  for (const key of ['support_appeal_text', 'support_appeal_text_plain']) {
    for (const [lang, s] of stringsOf(key)) assert.match(s, /5/, `${lang}.${key} names the 5`);
  }
});

// "5 a month" with no currency read as "5 of what?". Every amount on both cards
// names its dollar, in the way each language writes one.
test('every amount on both cards says what currency it is in', () => {
  const WITH_CURRENCY = /^(?:\$\d+|\d+[  ]?(?:\$|ドル|달러|美元))$/;
  for (const key of ['support_ask_text', 'support_ask_once', 'support_appeal_text', 'support_appeal_text_plain']) {
    for (const [lang, s] of stringsOf(key)) {
      const amounts = s.match(/\$?\d+(?:[  ]?(?:\$|ドル|달러|美元))?/g) || [];
      assert.ok(amounts.length > 0, `${lang}.${key} names an amount`);
      for (const a of amounts) assert.match(a, WITH_CURRENCY, `${lang}.${key}: "${a}" has no currency`);
    }
  }
});
