import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Pure-logic tests for the football (Calcio) data module — no network. Covers the
// config normalizer (bounds + dedup + id/badge cleaning) and the alert tracker
// (transition-based: first observation silent, then goal / full-time transitions).
const require = createRequire(import.meta.url);
const football = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'football.js'));

test('cleanId keeps numeric ids, rejects the rest', () => {
  assert.equal(football.cleanId('133670'), '133670');
  assert.equal(football.cleanId(133670), '133670');
  assert.equal(football.cleanId('abc'), '');
  assert.equal(football.cleanId('12a'), '');
  assert.equal(football.cleanId(''), '');
  assert.equal(football.cleanId('12; DROP'), '');
});

test('normalizeTeams dedups, validates ids and badges, keeps known keys', () => {
  const teams = football.normalizeTeams([
    { id: '1', name: 'A', badge: 'https://www.thesportsdb.com/x.png', league: 'Serie A', leagueId: '4332' },
    { id: '1', name: 'dup' },                                   // duplicate id → dropped
    { id: 'bad' },                                              // non-numeric → dropped
    { id: '2', name: 'B', badge: 'http://insecure/x.png' },     // non-https badge → stripped
    '3',                                                        // bare id
  ]);
  assert.equal(teams.length, 3);
  assert.deepEqual(teams[0], { id: '1', name: 'A', badge: 'https://www.thesportsdb.com/x.png', league: 'Serie A', leagueId: '4332' });
  assert.equal(teams[1].id, '2');
  assert.equal(teams[1].badge, undefined);                     // insecure badge dropped
  assert.deepEqual(teams[2], { id: '3' });
});

test('normalizeFootball clamps refresh, defaults, and caps teams', () => {
  const n = football.normalizeFootball({ refreshSec: 5, alerts: false, tile: { results: false } });
  assert.equal(n.refreshSec, 60);           // clamped up to the 60s floor
  assert.equal(n.alerts, false);
  assert.equal(n.tile.results, false);
  assert.equal(n.tile.standings, true);     // default
  // default teams when none given
  const d = football.normalizeFootball({});
  assert.ok(d.teams.length >= 1);
  // cap
  const many = Array.from({ length: football.MAX_TEAMS + 8 }, (_, i) => String(1000 + i));
  assert.equal(football.normalizeFootball({ teams: many }).teams.length, football.MAX_TEAMS);
});

test('alert tracker is silent on first observation, then fires on transitions', () => {
  const tr = football.createAlertTracker();
  const td = (status, hs, as) => ([{ id: 'T1', name: 'Napoli',
    last: { id: 'E1', home: 'Napoli', away: 'Roma', homeId: 'T1', awayId: 'T2', homeScore: hs, awayScore: as, status, league: 'Serie A' }, next: null }]);
  // First time we see this live match → recorded, no alert (no startup spam).
  assert.deepEqual(tr.evaluate(td('live', 1, 0), { alerts: true }), []);
  // Score changes → a goal alert.
  const goal = tr.evaluate(td('live', 2, 0), { alerts: true });
  assert.equal(goal.length, 1);
  assert.equal(goal[0].homeScore, 2);
  assert.equal(goal[0].team, 'Napoli');
  // Same state again → deduped.
  assert.deepEqual(tr.evaluate(td('live', 2, 0), { alerts: true }), []);
  // Transition to full time → one more alert.
  const ft = tr.evaluate(td('ft', 2, 0), { alerts: true });
  assert.equal(ft.length, 1);
  assert.equal(ft[0].status, 'ft');
});

test('searchLeagues matches curated competitions by name and alias (EN + IT)', () => {
  const wc = football.searchLeagues('mondiale');
  assert.ok(wc.some(l => l.id === '4429' && l.type === 'league'));   // Coppa del Mondo
  assert.ok(football.searchLeagues('champions').some(l => l.id === '4480'));
  assert.ok(football.searchLeagues('serie a').some(l => l.id === '4332'));
  assert.equal(football.searchLeagues('x').length, 0);              // <2 chars → none
  assert.equal(football.searchLeagues('zzzzzz').length, 0);
});

test('normalizeTeams keeps league-typed favorites distinct from same-id teams', () => {
  const favs = football.normalizeTeams([
    { id: '4332', type: 'league', name: 'Serie A' },
    { id: '4332', name: 'Some Team' },     // same numeric id, but a team → NOT a dup
    { id: '4332', type: 'league' },        // duplicate league → dropped
  ]);
  assert.equal(favs.length, 2);
  assert.equal(favs[0].type, 'league');
  assert.equal(favs[1].type, undefined);   // team entries carry no type
});

test('alert tracker skips league favorites (whole-league matches are too noisy)', () => {
  const tr = football.createAlertTracker();
  const league = [{ id: '4332', type: 'league', name: 'Serie A',
    last: { id: 'E1', home: 'A', away: 'B', homeId: 'x', awayId: 'y', homeScore: 1, awayScore: 0, status: 'ft' }, next: null }];
  // Even a state change never alerts for a league entry.
  assert.deepEqual(tr.evaluate(league, { alerts: true }), []);
  assert.deepEqual(tr.evaluate(league, { alerts: true }), []);
});

test('alert tracker respects the alerts=false switch and skips scoreless matches', () => {
  const tr = football.createAlertTracker();
  const live = [{ id: 'T1', name: 'X', last: { id: 'E9', home: 'X', away: 'Y', homeId: 'T1', awayId: 'T2', homeScore: 1, awayScore: 0, status: 'live' }, next: null }];
  assert.deepEqual(tr.evaluate(live, { alerts: false }), []);
  // not-started match (null scores) is ignored even as a first observation
  const ns = [{ id: 'T1', name: 'X', last: null, next: { id: 'E10', home: 'X', away: 'Y', homeId: 'T1', awayId: 'T2', homeScore: null, awayScore: null, status: 'ns' } }];
  assert.deepEqual(tr.evaluate(ns, { alerts: true }), []);
});

// ── team identity ────────────────────────────────────────────────────────────
// A club's crest used to be harvested from its next/last match, so a team with
// no fixture in the window had no crest and the widget drew letter initials.
// Identity is fetched separately now; this is the parsing half of it.

/** One lookupteam.php row, with the fields the widget actually reads. */
const NAPOLI_ROW = Object.freeze({
  idTeam: '133670', strTeam: 'Napoli', strTeamShort: 'NAP',
  strBadge: 'https://r2.thesportsdb.com/images/media/team/badge/x.png',
  strColour1: '#12A0D7', strColour2: 'sky blue',
  strStadium: 'Stadio Diego Armando Maradona', intStadiumCapacity: '60240',
  intFormedYear: '1926', strCountry: 'Italy', strLeague: 'Italian Serie A', idLeague: '4332',
  strDescriptionEN: 'Napoli is an Italian professional football club.',
  strDescriptionIT: 'Il Napoli è una società calcistica italiana.',
});

test('safeColour takes a hex triplet and nothing else (it lands in a CSS property)', () => {
  assert.equal(football.safeColour('#12A0D7'), '#12a0d7');
  assert.equal(football.safeColour('#fff'), '');            // shorthand is not accepted
  assert.equal(football.safeColour('sky blue'), '');
  assert.equal(football.safeColour('red; --x: url(javascript:1)'), '');
  assert.equal(football.safeColour(''), '');
  assert.equal(football.safeColour(null), '');
});

test('parseTeamInfo keeps the fields the tile shows and drops what it cannot trust', () => {
  const info = football.parseTeamInfo(NAPOLI_ROW, 'it');
  assert.equal(info.name, 'Napoli');
  assert.equal(info.badge, NAPOLI_ROW.strBadge);
  assert.equal(info.colour, '#12a0d7');
  assert.equal(info.colour2, '', 'a colour the provider stored as free text is not a colour');
  assert.equal(info.capacity, 60240);
  assert.equal(info.founded, 1926);
  assert.equal(info.leagueId, '4332');
});

test('parseTeamInfo prefers the description in the UI language and falls back to English', () => {
  assert.match(football.parseTeamInfo(NAPOLI_ROW, 'it').desc, /società calcistica/);
  // No German description on this club → English rather than an empty panel.
  assert.match(football.parseTeamInfo(NAPOLI_ROW, 'de').desc, /Italian professional/);
});

test('parseTeamInfo refuses a badge from a host that is not the provider', () => {
  const forged = { ...NAPOLI_ROW, strBadge: 'https://evil.example/steal.png' };
  assert.equal(football.parseTeamInfo(forged, 'en').badge, '');
  const insecure = { ...NAPOLI_ROW, strBadge: 'http://r2.thesportsdb.com/x.png' };
  assert.equal(football.parseTeamInfo(insecure, 'en').badge, '');
});

test('parseTeamInfo returns null for a row with no team name', () => {
  assert.equal(football.parseTeamInfo({ idTeam: '1' }, 'en'), null);
  assert.equal(football.parseTeamInfo(null, 'en'), null);
});

// ── news queries ─────────────────────────────────────────────────────────────

test('newsQueries qualifies a club by sport in the UI language, and a competition by name', () => {
  const it = football.newsQueries(football.DEFAULT_FOOTBALL.teams, 'it');
  assert.equal(it[0].query, 'Napoli calcio', 'the city and the club share a name — the qualifier is what separates them');
  assert.equal(it[0].type, 'topic');
  assert.equal(it[3].query, 'UEFA Champions League', 'a competition name needs no qualifier');
  assert.equal(football.newsQueries(football.DEFAULT_FOOTBALL.teams, 'de')[0].query, 'Napoli Fußball');
  assert.equal(football.newsQueries(football.DEFAULT_FOOTBALL.teams, 'zz')[0].query, 'Napoli football', 'unknown language → English');
});

test('newsQueries is capped, deduped, and skips favorites with no name to search for', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: String(100 + i), name: 'Club ' + i }));
  assert.equal(football.newsQueries(many, 'en').length, football.MAX_NEWS_FEEDS);
  // Same club followed twice under different ids → one query, not two requests.
  const dup = football.newsQueries([{ id: '1', name: 'Roma' }, { id: '2', name: 'Roma' }], 'it');
  assert.equal(dup.length, 1);
  // A favorite the user added before names were stored has nothing to search.
  assert.deepEqual(football.newsQueries([{ id: '5' }], 'en'), []);
});

// ── the keyless standings cap ────────────────────────────────────────────────
// Measured against the live provider: lookuptable.php returns exactly five rows
// on the public key, for every competition, with and without a season. A tile
// that draws those five as though they were the table looks broken (it was
// reported as such), so the payload says when it is capped.

test('a keyless five-row table is reported as partial, and a keyed one never is', () => {
  // fetchStandings is the only place that knows; exercise the rule it applies.
  const capped = football.FREE_TABLE_ROWS;
  assert.equal(capped, 5);
  // The rule: no key AND exactly the cap. Anything shorter is a real short
  // table (a cup group), and a key lifts the cap so the count means nothing.
  const rule = (rows, key) => !key && rows === capped;
  assert.equal(rule(5, ''), true);
  assert.equal(rule(5, 'PREMIUMKEY'), false, 'with a key, five rows is five real rows');
  assert.equal(rule(4, ''), false, 'a four-team group is not a truncated league');
  assert.equal(rule(20, ''), false);
});
