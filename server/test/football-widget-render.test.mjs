import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { makeDom } from './mini-dom.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, '..', 'js', 'football-widget.js'), 'utf8');

// The Calcio widget was reported as "useless": four rows, no crests, and every
// one of them saying "no matches". The data pipeline was fine — the RENDER was
// the problem, and none of it was covered. `node --check` passes on a widget
// that draws an empty list, and the server-side football.test.mjs cannot see a
// row that never gets built.
//
// What is pinned here is what the redesign has to keep true:
//
//  1. A match followed by TWO of the user's teams (a derby) is one row, not two.
//     Every followed team carries the same fixture in its own list, and a
//     followed COMPETITION carries it a third time.
//  2. The hero leads with the match in play — not with whichever favorite the
//     settings happen to list first.
//  3. Nothing scheduled must not mean an empty tile. That state is exactly what
//     the user saw, and it now draws the clubs themselves.
//  4. A crest resolves from the identity cache when the fixture has none, which
//     is the whole reason that cache exists.

const LABELS = {
  football_tab_matches: 'Partite',
  football_tab_table: 'Classifica',
  football_tab_news: 'Notizie',
  football_today: 'Oggi',
  football_tomorrow: 'Domani',
  football_results: 'Risultati',
  football_no_fixtures: 'Nessuna partita in programma',
  football_live: 'LIVE',
  football_loading: 'Caricamento…',
  football_empty: 'Niente ancora',
  football_table_partial: 'La fonte gratuita restituisce solo le prime 5 posizioni.',
};

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
// A fixed "now", handed to the widget as its own Date (below). Without it the
// day grouping is a function of the wall clock: "today at +6h" is tomorrow when
// the suite runs at 23:00, and the assertions would pass all day and fail at
// night — the worst kind of test.
const NOW = new Date('2026-08-22T12:00:00').getTime();

function iso(ms) {
  // The widget parses `ts` with `new Date(...)`, i.e. in local time — build the
  // string the same way so the test means the same thing in every timezone.
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

function ev(over) {
  return {
    id: 'e1', home: 'Napoli', away: 'Roma', homeId: '133670', awayId: '133682',
    homeBadge: 'https://r2.thesportsdb.com/h.png', awayBadge: 'https://r2.thesportsdb.com/a.png',
    homeScore: null, awayScore: null, ts: iso(NOW + HOUR), date: '', time: '',
    league: 'Italian Serie A', leagueId: '4332', leagueBadge: '', round: '1', venue: 'Maradona',
    status: 'ns', statusRaw: 'NS', season: '2026-2027', ...over,
  };
}

/** Mount one tile, run the widget in it, and hand back the DOM to assert on. */
function mount({ teams = [], favorites = [], info = {}, live = false, standings = null, news = [], found = [] } = {}) {
  const favs = favorites.slice();
  const dom = makeDom();
  const { document, mkEl } = dom;

  const page = mkEl('div');
  page.className = 'pager-page';
  document.body.appendChild(page);
  const tile = mkEl('section');
  tile.className = 'panel dashboard-widget';
  tile.setAttribute('data-dashboard-widget', 'football');
  page.appendChild(tile);
  const host = mkEl('div');
  host.className = 'football-widget-mount';
  tile.appendChild(host);

  const calls = [];
  const sandbox = {
    document,
    window: null,
    makeEl: (tag, cls, text) => {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    // The seed is the only fetch the widget makes on mount; the tabs fetch on
    // demand and are driven explicitly by the tests that need them.
    apiJson: async (path) => {
      calls.push(path);
      if (path === '/api/football') return { teams, favorites: favs, info, live, tile: { results: true, standings: true } };
      if (path.startsWith('/api/football/standings')) return standings;
      if (path === '/api/football/news') return { items: news };
      if (path.startsWith('/api/football/search')) return { results: found };
      // The real endpoint is server-authoritative: it answers with the list it
      // just persisted, which is what the widget adopts.
      if (path === '/api/football/teams') { found.forEach((f) => favs.push(f)); return { ok: true, teams: favs }; }
      return null;
    },
    // The widget reads the clock to decide today/tomorrow/results; pin it.
    Date: class extends Date {
      constructor(...args) { if (args.length) super(...args); else super(NOW); }
      static now() { return NOW; }
    },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    setTimeout: () => 1,
    clearTimeout: () => {},
    t: (k) => LABELS[k] || '',
    console: { warn: () => {}, error: () => {} },
    module: undefined,
  };
  sandbox.window = sandbox;
  sandbox.window.t = sandbox.t;
  sandbox.window.addEventListener = () => {};
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'football-widget.js' });

  return { ...dom, tile, host, calls, FootballWidget: sandbox.FootballWidget };
}

/**
 * Follow a team the way a person does: open the + panel, type, press Enter.
 * Driven through the real handlers rather than a private function, so the test
 * cannot pass while the route a user takes is broken.
 */
async function addViaSearch(m, text) {
  const manage = m.host.querySelector('.fw-manage');
  if (!m.host.querySelector('.fw-add-input')) manage.click();
  const input = m.host.querySelector('.fw-add-input');
  input.value = text;
  input._handlers.input.forEach((fn) => fn());
  await Promise.all(input._handlers.keydown.map((fn) => fn({ key: 'Enter', preventDefault() {} })));
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

/** Push a payload the way the SSE listener does, then read the tile. */
function paintWith(m, payload) {
  m.FootballWidget.onSSE(payload);
  return m.host;
}

const TEAM = (over) => ({
  id: '133670', type: 'team', name: 'Napoli', badge: '', leagueId: '4332',
  league: 'Italian Serie A', season: '2026-2027', next: null, last: null,
  nextList: [], lastList: [], ...over,
});

// ── 1. the merged feed ───────────────────────────────────────────────────────

test('a match between two followed teams is ONE row, not one per team', () => {
  const derby = ev({ id: 'derby' });
  const m = mount();
  const host = paintWith(m, {
    teams: [
      TEAM({ id: '133670', name: 'Napoli', nextList: [derby] }),
      TEAM({ id: '133682', name: 'Roma', nextList: [derby] }),
      // The followed competition carries it a third time.
      { id: '4332', type: 'league', name: 'Serie A', nextList: [derby], lastList: [] },
    ],
    live: false,
  });
  const rows = host.querySelectorAll('.fw-match');
  assert.equal(rows.length, 1, 'the same fixture arrives from every followed side that plays in it');
});

test('a followed team is highlighted in the row, and the competition owner does not steal it', () => {
  const derby = ev({ id: 'derby' });
  const m = mount();
  const host = paintWith(m, {
    // League first on purpose: it is seen first and knows no side, so the team
    // entry that follows has to be able to claim the row.
    teams: [
      { id: '4332', type: 'league', name: 'Serie A', nextList: [derby], lastList: [] },
      TEAM({ id: '133670', name: 'Napoli', nextList: [derby] }),
    ],
    live: false,
  });
  const mine = host.querySelectorAll('.fw-match-side.is-mine');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].querySelector('.fw-match-team').textContent, 'Napoli');
});

test('matches are grouped by day, and a finished one is a result whatever day it fell on', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({
      lastList: [ev({ id: 'done', ts: iso(NOW - 4 * HOUR), status: 'ft', homeScore: 2, awayScore: 0 })],
      nextList: [
        ev({ id: 'later', ts: iso(NOW + 2 * DAY) }),
        ev({ id: 'today', ts: iso(NOW + 6 * HOUR) }),
        ev({ id: 'tomorrow', ts: iso(NOW + DAY + 2 * HOUR) }),
      ],
    })],
    live: false,
  });
  const labels = host.querySelectorAll('.fw-daysep').map((n) => n.textContent);
  // Upcoming ascending first, results last: what is still to come is the point
  // of the tile, and a result the user has already seen is not.
  assert.equal(labels[0], 'Oggi');
  assert.equal(labels[1], 'Domani');
  assert.equal(labels[3], 'Risultati', 'anything finished belongs under Results');
  assert.equal(labels.length, 4);

  const days = host.querySelectorAll('.fw-day');
  assert.equal(days[0].querySelectorAll('.fw-match').length, 1, 'today holds only the match still to be played');
});

test('a match played earlier today is a result, not something still to come', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({ lastList: [ev({ id: 'ft', ts: iso(NOW - 2 * HOUR), status: 'ft', homeScore: 1, awayScore: 1 })] })],
    live: false,
  });
  const labels = host.querySelectorAll('.fw-daysep').map((n) => n.textContent);
  assert.deepEqual(labels, ['Risultati']);
});

// ── 2. the hero ──────────────────────────────────────────────────────────────

test('the hero leads with the match in play, over an earlier kickoff', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({
      nextList: [
        ev({ id: 'soon', ts: iso(NOW + 30 * 60 * 1000), home: 'Inter', away: 'Como' }),
        ev({ id: 'playing', ts: iso(NOW + 2 * HOUR), status: 'live', homeScore: 1, awayScore: 0, progress: "68'" }),
      ],
    })],
    live: true,
  });
  const hero = host.querySelector('.fw-hero');
  assert.ok(hero, 'the tile must lead with a match');
  assert.ok(hero.classList.contains('is-live'));
  assert.equal(hero.querySelector('.fw-hero-score').textContent, '1 – 0');
});

test('with nothing in play the hero is the next kickoff, and it shows the time', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({
      lastList: [ev({ id: 'old', ts: iso(NOW - 3 * DAY), status: 'ft', homeScore: 3, awayScore: 1 })],
      nextList: [ev({ id: 'next', ts: iso(NOW + 5 * HOUR) })],
    })],
    live: false,
  });
  const hero = host.querySelector('.fw-hero');
  assert.equal(hero.querySelector('.fw-hero-score'), null, 'a match not yet played has no score');
  assert.ok(hero.querySelector('.fw-hero-kick'), 'it shows the kickoff time instead');
});

test('with the season over the hero falls back to the last result rather than disappearing', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({ lastList: [ev({ id: 'old', ts: iso(NOW - 5 * DAY), status: 'ft', homeScore: 2, awayScore: 0 })] })],
    live: false,
  });
  assert.equal(host.querySelector('.fw-hero .fw-hero-score').textContent, '2 – 0');
});

// ── 3. the state the user reported ───────────────────────────────────────────

test('no fixtures anywhere draws the clubs themselves, never an empty list', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({ id: '133670', name: 'Napoli' }), TEAM({ id: '133681', name: 'Inter' })],
    info: {
      133670: { badge: 'https://r2.thesportsdb.com/n.png', colour: '#12a0d7', stadium: 'Maradona', founded: 1926 },
    },
    live: false,
  });
  assert.equal(host.querySelector('.fw-hero'), null, 'there is no match to lead with');
  const cards = host.querySelectorAll('.fw-idcard');
  assert.equal(cards.length, 2, 'every followed club is still something to look at');
  assert.equal(host.querySelector('.fw-daysep').textContent, 'Nessuna partita in programma');
  assert.equal(cards[0].querySelector('.fw-idcard-sub').textContent, 'Maradona · 1926');
});

test('the tab bar is always there, so the table and the news stay reachable with no fixtures', () => {
  const m = mount();
  const host = paintWith(m, { teams: [TEAM({})], live: false });
  const tabs = host.querySelectorAll('.fw-tab').map((n) => n.textContent);
  assert.deepEqual(tabs, ['Partite', 'Classifica', 'Notizie']);
  assert.ok(host.querySelector('.fw-manage'), 'and the way to follow another team');
});

// ── 4. crests ────────────────────────────────────────────────────────────────

test('a crest resolves from the identity cache when the fixture carries none', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({ nextList: [ev({ homeBadge: '', awayBadge: '' })] })],
    info: { 133670: { badge: 'https://r2.thesportsdb.com/napoli.png' } },
    live: false,
  });
  const crests = host.querySelector('.fw-match').querySelectorAll('.fw-crest');
  const img = crests[0].querySelector('img');
  assert.ok(img, 'the followed club has a crest even though the event had none');
  assert.equal(img.src, 'https://r2.thesportsdb.com/napoli.png');
  // The away side is unknown to the cache, so it degrades to initials rather
  // than borrowing somebody else's badge.
  assert.ok(crests[1].classList.contains('is-empty'));
  assert.equal(crests[1].textContent, 'R');
});

test('a non-https crest is never written to an img src', () => {
  const m = mount();
  const host = paintWith(m, {
    teams: [TEAM({ nextList: [ev({ homeBadge: 'javascript:alert(1)', awayBadge: 'http://x/a.png' })] })],
    live: false,
  });
  assert.equal(host.querySelector('.fw-match').querySelectorAll('img').length, 0);
});

// ── the seed ─────────────────────────────────────────────────────────────────

test('mounting seeds once and paints the favorites before any fixture resolves', async () => {
  const m = mount({
    teams: [],
    favorites: [{ id: '133670', name: 'Napoli', league: 'Italian Serie A' }],
    info: { 133670: { badge: '', stadium: 'Maradona' } },
  });
  m.FootballWidget.renderWidgets();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(m.calls, ['/api/football']);
  assert.equal(m.host.querySelectorAll('.fw-idcard').length, 1,
    'a followed team shows before its fixtures arrive — that was the "no data" row');

  m.FootballWidget.renderWidgets();
  await new Promise((r) => setImmediate(r));
  assert.equal(m.calls.length, 1, 'a second render must not re-seed');
});

// ── the capped league table ──────────────────────────────────────────────────

test('a capped table says so under the rows; a full one says nothing', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    rank: i + 1, teamId: String(900 + i), team: 'Club ' + i, badge: '',
    played: 38, gd: 10 - i, points: 80 - i, form: 'WWDLW',
  }));
  // The Classifica tab fetches on open; answer it with a capped table.
  const withNote = mount({ standings: { leagueId: '4332', league: 'Italian Serie A', rows, partial: true } });
  withNote.FootballWidget.onSSE({ teams: [TEAM({})], live: false });
  withNote.host.querySelectorAll('.fw-tab')[1].click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(withNote.host.querySelectorAll('.fw-tr').length, 6, 'five rows plus the header');
  const note = withNote.host.querySelector('.fw-table-note');
  assert.ok(note, 'five rows with no explanation is what got reported as broken');
  assert.match(note.textContent, /prime 5/);

  const full = mount({ standings: { leagueId: '4332', league: 'Italian Serie A', rows, partial: false } });
  full.FootballWidget.onSSE({ teams: [TEAM({})], live: false });
  full.host.querySelectorAll('.fw-tab')[1].click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(full.host.querySelector('.fw-table-note'), null);
});

// ── the news tab reloads itself ──────────────────────────────────────────────

test('following another team while the News tab is open reloads it instead of hanging', async () => {
  const items = [{ id: 'a', title: 'Headline', url: 'https://example.com/a', source: 'Sky', published: NOW }];
  const m = mount({
    favorites: [{ id: '133670', name: 'Napoli' }], news: items,
    found: [{ id: '133676', type: 'team', name: 'Juventus', league: 'Italian Serie A', leagueId: '4332' }],
  });
  m.FootballWidget.onSSE({ teams: [TEAM({})], live: false });
  m.host.querySelectorAll('.fw-tab')[2].click();          // Notizie
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(m.host.querySelectorAll('.fw-news').length, 1);

  // Adding a team drops the cached headlines: they are about the teams being
  // followed. Nothing used to ask for them again, so the panel sat on
  // "Caricamento..." for good (reported with Juventus).
  const before = m.calls.filter((c) => c === '/api/football/news').length;
  await addViaSearch(m, 'Juventus');
  assert.equal(m.calls.filter((c) => c === '/api/football/news').length, before + 1,
    'the open tab must refetch');
  assert.equal(m.host.querySelector('.fw-mini-loading'), null, 'and stop saying it is loading');
  assert.equal(m.host.querySelectorAll('.fw-news').length, 1);
});
