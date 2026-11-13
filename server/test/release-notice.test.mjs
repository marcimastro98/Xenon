// What a person is told after an update (js/release-notice.js), what reaches the
// page from whatsnew.json (release-notes.js), and the release rule that keeps
// the two honest: a shipped version always has something to say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { appStringsSource } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const notice = require('../js/release-notice.js');
const notes = require('../release-notes.js');
const remote = require('../remote-access.js');
const WHATSNEW = require('../whatsnew.json');
const PACKAGE = require('../../package.json');
const SERVER = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const I18N = appStringsSource();
const LANGS = ['it', 'en', 'es', 'fr', 'de', 'pt', 'ru', 'nl', 'ko', 'ja', 'zh'];

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const major = { id: '5.0.0', version: '5.0.2', highlights: [{ title: 'Bit' }], releases: [] };
const release = (version, fixes = 1, news = 0) => ({
  version,
  fixes: Array.from({ length: fixes }, (_, i) => ({ area: 'Deck', text: `${version} fix ${i}` })),
  news: Array.from({ length: news }, (_, i) => ({ title: `${version} new ${i}` })),
});

test('a major stays until its id is the one closed', () => {
  assert.equal(notice.pick({ wn: major, whatsNewSeen: '' }).major, true);
  assert.equal(notice.pick({ wn: major, whatsNewSeen: '4.11.0' }).major, true);
  assert.equal(notice.pick({ wn: major, whatsNewSeen: '5.0.0' }).major, false);
});

test('a major with nothing to show never opens', () => {
  assert.equal(notice.pick({ wn: { ...major, highlights: [] }, whatsNewSeen: '' }).major, false);
  assert.equal(notice.pick({ wn: null, whatsNewSeen: '' }).major, false);
});

test('fixes show until the version is read, then never again', () => {
  const wn = { ...major, releases: [release('5.0.2')] };
  assert.equal(notice.pick({ wn, notesSeen: '' }).notes.version, '5.0.2');
  assert.equal(notice.pick({ wn, notesSeen: '5.0.1' }).notes.version, '5.0.2');
  assert.equal(notice.pick({ wn, notesSeen: '5.0.2' }).notes, null);
});

test('skipped versions merge into one list under the newest', () => {
  const wn = { ...major, releases: [release('5.0.1', 2), release('5.0.2', 1, 1), release('5.0.0', 9)] };
  const open = notice.pick({ wn, notesSeen: '5.0.0' }).notes;
  assert.equal(open.version, '5.0.2');
  assert.deepEqual(open.fixes.map((f) => f.text), ['5.0.2 fix 0', '5.0.1 fix 0', '5.0.1 fix 1']);
  assert.equal(open.news.length, 1);
});

test('a version newer than the one running says nothing yet', () => {
  const wn = { ...major, releases: [release('5.0.3')] };
  assert.equal(notice.pick({ wn, notesSeen: '' }).notes, null);
});

test('versions compare as numbers, not as text', () => {
  assert.equal(notice.compare('5.0.10', '5.0.9'), 1);
  assert.equal(notice.compare('v5.1.0', '5.1.0'), 0);
  assert.equal(notice.compare('4.11.13', '5.0.0'), -1);
});

test('a failure counts once, and only when it finished with a time', () => {
  assert.equal(notice.failurePending({ ok: false, at: 123 }, ''), true);
  assert.equal(notice.failurePending({ ok: false, at: 123 }, '123'), false);
  assert.equal(notice.failurePending({ ok: false, at: 124 }, '123'), true);
  assert.equal(notice.failurePending({ ok: true, at: 124 }, ''), false);
  assert.equal(notice.failurePending({ ok: false }, ''), false);
  assert.equal(notice.failurePending(null, ''), false);
});

test('text falls back to English, then to anything there is', () => {
  assert.equal(notice.localText({ it: 'Ciao', en: 'Hi' }, 'IT'), 'Ciao');
  assert.equal(notice.localText({ it: 'Ciao', en: 'Hi' }, 'ko'), 'Hi');
  assert.equal(notice.localText({ it: 'Ciao' }, 'ko'), 'Ciao');
  assert.equal(notice.localText('Plain', 'it'), 'Plain');
  assert.equal(notice.localText(null, 'it'), '');
});

test('short versions drop a zero patch only', () => {
  assert.equal(notice.shortVersion('5.1.0'), '5.1');
  assert.equal(notice.shortVersion('5.0.2'), '5.0.2');
});

test('the summary counts what is there and skips what is not', () => {
  const strings = { rn_new_one: 'one new', rn_new_n: '{n} new', rn_fixed_one: 'one fixed', rn_fixed_n: '{n} fixed' };
  const tr = (k) => strings[k];
  assert.equal(notice.summary({ news: [1], fixes: [1, 2] }, tr), 'one new 2 fixed');
  assert.equal(notice.summary({ news: [], fixes: [1] }, tr), 'one fixed');
});

test('a sheet keeps known values only', () => {
  assert.deepEqual(notes.normalizeSheet({ color: 'green', clip: 'bitChat', scene: 'bit', section: 'now', go: 'sparks', x: 1 }),
    { color: 'green', clip: 'bitChat', scene: 'bit', section: 'now', go: 'sparks' });
  assert.deepEqual(notes.normalizeSheet({ color: 'red;}', clip: '../x', scene: 'nope', section: 'admin', go: 'https://x.test' }),
    { color: '', clip: '', scene: '', section: '', go: '' });
  assert.deepEqual(notes.normalizeSheet(null), { color: '', clip: '', scene: '', section: '', go: '' });
});

test('a sheet takes a clip that ships with the app, or an address the caller allows', () => {
  const none = () => false;
  assert.deepEqual(notes.normalizeMedia({ media: '/assets/whatsnew/maker.mp4', poster: '/assets/whatsnew/maker.webp' }, none),
    { media: '/assets/whatsnew/maker.mp4', mediaType: 'video', poster: '/assets/whatsnew/maker.webp' });
  assert.deepEqual(notes.normalizeMedia({ media: '/assets/whatsnew/a-b.webp', mediaType: 'video' }, none),
    { media: '/assets/whatsnew/a-b.webp', mediaType: 'image', poster: '' }, 'the file says what it is');
  const empty = { media: '', mediaType: '', poster: '' };
  for (const media of ['/assets/whatsnew/../../settings.json', '/uploads/x.mp4', '/assets/whatsnew/x.exe', 'https://x.test/a.png', 7]) {
    assert.deepEqual(notes.normalizeMedia({ media, poster: '/assets/whatsnew/a.webp' }, none), empty, String(media));
  }
  assert.equal(notes.normalizeMedia({ media: '/assets/whatsnew/a.mp4', poster: '/assets/whatsnew/b.mp4' }, none).poster, '', 'a poster is a picture');
  assert.equal(notes.normalizeMedia({ media: '/assets/whatsnew/a.mp4', poster: 'https://x.test/b.png' }, () => true).poster, '', 'and never from the net');
  assert.deepEqual(notes.normalizeMedia({ media: 'https://ok.test/a', mediaType: 'VIDEO' }, () => true),
    { media: 'https://ok.test/a', mediaType: 'video', poster: '' });
  assert.deepEqual(notes.normalizeMedia({ media: 'https://ok.test/a', mediaType: 'nope' }, () => true),
    { media: 'https://ok.test/a', mediaType: 'image', poster: '' });
  assert.deepEqual(notes.normalizeMedia(null, none), empty);
});

test('the closing sheet needs at least one row', () => {
  assert.equal(notes.normalizeMore({ title: 'More', items: ['', 7] }, text), null);
  assert.equal(notes.normalizeMore('nope', text), null);
  assert.deepEqual(notes.normalizeMore({ title: 'More', items: ['One', ''], note: 'n' }, text),
    { title: 'More', items: ['One'], note: 'n' });
});

test('a release needs a real version and something to say', () => {
  const ok = { version: '5.0.1', fixes: [{ area: 'Deck', text: 'Fixed' }, { area: '', text: 'lost' }], news: [{ text: 'no title' }] };
  assert.deepEqual(notes.normalizeReleases([ok, { version: 'latest', fixes: ok.fixes }, { version: '5.0.2' }, null], text),
    [{ version: '5.0.1', news: [], fixes: [{ area: 'Deck', text: 'Fixed' }] }]);
  assert.deepEqual(notes.normalizeReleases('nope', text), []);
});

test('notice-seen keeps the three fields and drops everything else', () => {
  assert.deepEqual(notes.cleanSeen({ whatsNew: ' 5.0.0 ', notes: '5.0.1', failedAt: 123, rev: 9, layers: [] }),
    { whatsNewSeen: '5.0.0', releaseNotesSeen: '5.0.1', updateFailSeen: '123' });
  assert.deepEqual(notes.cleanSeen({ notes: 'latest', whatsNew: '  ', failedAt: {} }), {});
  assert.deepEqual(notes.cleanSeen(null), {});
});

test('a settings save can never undo what notice-seen wrote', () => {
  assert.match(SERVER, /incoming\.releaseNotesSeen = prev\.releaseNotesSeen \|\| '';/);
  assert.match(SERVER, /incoming\.updateFailSeen = prev\.updateFailSeen \|\| '';/);
  assert.match(SERVER, /if \(prev\.whatsNewSeen && !incoming\.whatsNewSeen\) incoming\.whatsNewSeen = prev\.whatsNewSeen;/);
});

test('notice-seen is CSRF guarded, and a phone may only POST it', () => {
  const csrf = SERVER.slice(SERVER.indexOf('const CSRF_MUTATION_PATHS = new Set(['));
  assert.ok(csrf.slice(0, csrf.indexOf(']);')).includes("'/update/notice-seen'"));
  assert.equal(remote.DEFAULT_GET_MUTATORS.has('/update/notice-seen'), true);
  assert.equal(remote.remotePathAllowed('/update/notice-seen', 'POST'), true);
  assert.equal(remote.remotePathAllowed('/update/notice-seen', 'GET'), false);
});

test('the running version always has something to say', () => {
  const entry = (WHATSNEW.releases || []).some((r) => r.version === PACKAGE.version);
  assert.ok(WHATSNEW.id === PACKAGE.version || entry,
    `package.json is ${PACKAGE.version}: set the id of server/whatsnew.json to it (major) or add a "releases" entry (patch, minor)`);
});

test('every sheet of whatsnew.json is real, in all 11 languages', () => {
  const full = (v, where) => {
    for (const lang of LANGS) assert.ok(text(v && v[lang]), `${where} misses ${lang}`);
  };
  full(WHATSNEW.title, 'title');
  full(WHATSNEW.intro, 'intro');
  WHATSNEW.highlights.forEach((h, i) => {
    full(h.title, `highlight ${i} title`);
    full(h.body, `highlight ${i} body`);
    assert.ok(notes.SHEET_COLORS.includes(h.color), `highlight ${i} color`);
  });
  WHATSNEW.more.items.forEach((item, i) => full(item, `more item ${i}`));
});

test('the sheets say what the person gets, plainly, in every language', () => {
  const words = (v) => LANGS.map((lang) => v[lang]);
  const all = [WHATSNEW.intro, ...WHATSNEW.highlights.flatMap((h) => [h.title, h.body]), ...WHATSNEW.more.items].flatMap(words);
  for (const line of all) assert.doesNotMatch(line, /\u2014/, `no long dash: ${line}`);
  // Every amount names its currency; the "5" of the pass is never left alone.
  const pass = WHATSNEW.highlights.find((h) => h.go === 'supporters');
  for (const line of words(pass.body)) assert.match(line, /5\s?USD/, line);
  for (const lang of LANGS) assert.ok(WHATSNEW.more.items.length <= 8, lang);
});

test('every moving picture of a sheet ships with the app and stays small', () => {
  const clips = WHATSNEW.highlights.filter((h) => h.media);
  assert.ok(clips.length >= 3);
  for (const h of clips) {
    const shaped = notes.normalizeMedia(h, () => false);
    assert.equal(shaped.media, h.media, 'it passes the boundary');
    assert.equal(shaped.mediaType, 'video');
    assert.ok(shaped.poster, `${h.media} needs a still for Performance Mode and for a WebView with no H.264`);
    for (const file of [h.media, h.poster]) {
      const url = new URL(`..${file}`, import.meta.url);
      assert.ok(existsSync(url), file);
      assert.ok(statSync(url).size < 1.5 * 1024 * 1024, `${file} is too heavy for the update`);
    }
  }
  assert.ok(remote.remotePathAllowed(clips[0].media, 'GET'), 'a paired phone sees it too');
});

test('a video is served by range, or a WebView will not play it', () => {
  const route = SERVER.slice(SERVER.indexOf('const STATIC_MIME = {'), SERVER.indexOf('// ── Twitch live integration'));
  assert.match(route, /'\.mp4': 'video\/mp4'/);
  assert.match(route, /ext === '\.mp4'[\s\S]*serveFileRange\(req, res, abs, stat,/);
});

test('every button of a sheet has its words, and the drawn panels too', () => {
  const inAll = (key) => {
    const count = (I18N.match(new RegExp(`\\b${key}\\b['"]?\\s*:`, 'g')) || []).length;
    assert.equal(count, LANGS.length, `${key} is in ${count} languages`);
  };
  for (const h of WHATSNEW.highlights) {
    if (h.section) inAll(`wn_try_${h.section}`);
    if (h.go) inAll(`wn_try_${h.go}`);
    assert.ok(!h.scene || notes.SHEET_SCENES.includes(h.scene), h.scene);
  }
  const scenes = readFileSync(new URL('../js/whats-new-scenes.js', import.meta.url), 'utf8');
  const keys = new Set([...scenes.matchAll(/tr\('(wn_s_[a-z0-9_]+)'\)/g)].map((m) => m[1]));
  assert.ok(keys.size > 10);
  for (const key of keys) inAll(key);
  assert.equal((I18N.match(/\bwn_try_overlay\b/g) || []).length, 0, 'no sheet asks for it');
});

test("returning means earlier use; What's New alone is not, a new install sees it too", () => {
  const { returningUser } = notice;
  assert.equal(returningUser({ asked: false, notesSeen: '', tourSeen: 0 }), false, 'a new install');
  assert.equal(returningUser({ asked: false, notesSeen: '', tourSeen: 0, whatsNewSeen: '5.0.0' }), false, 'closed on the first boot');
  assert.equal(returningUser({ asked: true, notesSeen: '', tourSeen: 0 }), true);
  assert.equal(returningUser({ asked: false, notesSeen: '4.11.13', tourSeen: 0 }), true);
  assert.equal(returningUser({ asked: false, notesSeen: '', tourSeen: 3 }), true);
});

test('a sheet that leads somewhere closes the stage and goes, on both surfaces', () => {
  const stage = readFileSync(new URL('../js/whats-new.js', import.meta.url), 'utf8');
  assert.match(stage, /leave: \(target\) => \{\s*close\(\);/, 'the stage is gone first: it covers the Store');
  const update = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
  assert.match(update, /openStore: openStoreFor/);
  const screen = readFileSync(new URL('../js/screen-release.js', import.meta.url), 'utf8');
  assert.match(screen, /openStore: openDashboard/);
  const alerts = readFileSync(new URL('../js/screen-alerts.js', import.meta.url), 'utf8');
  assert.match(alerts, /window\.ScreenRelease\.start\(\{[\s\S]*openDashboard,/);
});

test('a video plays only on the sheet it belongs to, and not when things stand still', () => {
  const stage = readFileSync(new URL('../js/whats-new.js', import.meta.url), 'utf8');
  const clip = stage.slice(stage.indexOf('function mediaPanel('), stage.indexOf('function highlightSheet('));
  assert.match(clip, /video\.muted = true/);
  assert.match(clip, /video\.playsInline = true/);
  assert.match(clip, /stillNow\(\)/, 'a still instead of a video on a low-power GPU');
  assert.match(clip, /addEventListener\('error'/, 'a WebView with no H.264 keeps the still');
  assert.match(stage, /function playClips\(\)/);
  const aside = stage.slice(stage.indexOf('function stepAside('), stage.indexOf('function trapTab('));
  assert.match(aside, /pauseClips\(\)/);
  assert.match(aside, /playClips\(\)/);
  const end = stage.slice(stage.indexOf('function close('), stage.indexOf("document.addEventListener('keydown', onKey);"));
  assert.match(end, /pauseClips\(\)/);
});

test('every string the two surfaces ask for exists in all 11 languages', () => {
  const sources = ['update.js', 'whats-new.js', 'release-notes-card.js', 'screen-release.js']
    .map((f) => readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8')).join('\n');
  const keys = new Set([...sources.matchAll(/['"]((?:wn|rn)_[a-z0-9_]+)['"]/g)].map((m) => m[1]));
  assert.ok(keys.size > 5, 'the string keys must still be written literally');
  for (const key of keys) {
    const count = (I18N.match(new RegExp(`\\b${key}\\b['"]?\\s*:`, 'g')) || []).length;
    assert.equal(count, LANGS.length, `${key} is in ${count} languages`);
  }
});

test('Bit can open What\'s New wherever the page that draws it runs', () => {
  const ai = readFileSync(new URL('../js/ai.js', import.meta.url), 'utf8');
  const update = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
  assert.match(SERVER, /\{ name: 'open_whats_new', description: "[^"]*What's New[^"]*"/);
  assert.match(SERVER, /const CLIENT_ACTIONS = new Set\(\[[^\]]*'open_whats_new'/);
  assert.match(ai, /case 'open_whats_new':\s*if \(window\.XenonWhatsNew\) XenonWhatsNew\.reopen\(\);/);
  assert.match(update, /window\.XenonWhatsNew = \{[^}]*reopen: reopenWhatsNew/);
  const surface = require('../ai-surface.js');
  assert.equal(surface.SHEET_OK.has('open_whats_new'), true);
  // Widgets only: the alerts window has its own stage, so Bit does not ask for the dashboard.
  assert.equal(surface.clientActionRefusal('open_whats_new', 'screen', true), null);
  const screen = readFileSync(new URL('../js/screen-release.js', import.meta.url), 'utf8');
  assert.match(screen, /window.XenonWhatsNew = { reopen: made.reopen }/);
});

test('the menu drawn on the stage has the sections of the real menu', () => {
  const scenes = readFileSync(new URL('../js/whats-new-scenes.js', import.meta.url), 'utf8');
  const drawn = /const MENU_SECTIONS = \[([^\]]*)\]/.exec(scenes)[1].match(/[a-z]+/g);
  assert.deepEqual(drawn, require('../screen-menu.js').SECTIONS);
});

test('a WebKit without Web Audio still loads the page, in silence', () => {
  const source = readFileSync(new URL('../js/audio-feedback.js', import.meta.url), 'utf8');
  const window = { addEventListener() {} };
  const context = vm.createContext({ window, document: { addEventListener() {} }, localStorage: { getItem: () => null }, console });
  assert.doesNotThrow(() => vm.runInContext(source, context));
});

// A new install is told what the version it starts on brings: the major's sheets,
// then the notes since it, after the first-run question (they wait for its overlay).
test('a new install sees the major first, then the notes of the version it started on', () => {
  const wn = {
    id: '5.0.0', version: '5.1.0', highlights: [{ title: 'Big' }],
    releases: [{ version: '5.1.0', news: [{ title: 'n' }], fixes: [{ area: 'a', text: 'b' }] }],
  };
  const first = notice.pick({ wn, whatsNewSeen: '', notesSeen: '' });
  assert.equal(first.major, true);
  assert.equal(first.notes.version, '5.1.0');
  const update = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
  const majorAt = update.indexOf('queue.push((next) => openWhatsNew(wn, next))');
  const notesAt = update.indexOf('queue.push((next) => openReleaseNotes(wn, notes, next))');
  assert.ok(majorAt > 0 && notesAt > majorAt, 'the major is queued before the notes');
  assert.ok(!update.includes('suppressForFreshInstall'));
  const settings = readFileSync(new URL('../js/settings.js', import.meta.url), 'utf8');
  assert.ok(!settings.includes('suppressForFreshInstall'));
  assert.ok(SERVER.includes('json({ ...(await loadWhatsNew()), version: APP_VERSION })'), '/whatsnew hides nothing from a new install');
  const queue = readFileSync(new URL('../js/interrupt-queue.js', import.meta.url), 'utf8');
  assert.ok(queue.includes("'.sp-overlay'"), 'the first-run question holds it back');
});

test('an update that lands during a game is shown when the game ends', () => {
  const update = readFileSync(new URL('../js/update.js', import.meta.url), 'utf8');
  assert.match(update, /whenIdle\(fn, \{ priority: I\.PRIORITY\.update, maxTries: Infinity \}\)/);
});
