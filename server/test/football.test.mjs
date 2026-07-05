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
