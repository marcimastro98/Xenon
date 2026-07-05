import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cu = require('../claude-usage.js');

// ── config normalization ──────────────────────────────────────────────────────

test('normalizeClaude fills defaults and clamps', () => {
  const d = cu.normalizeClaude(undefined);
  assert.equal(d.plan, 'custom');
  assert.equal(d.weeklyTokenBudget, 0);
  assert.equal(d.tile.reactor, true);

  const bad = cu.normalizeClaude({ plan: 'nope', weeklyTokenBudget: -5, refreshSec: 1, tile: { cost: false } });
  assert.equal(bad.plan, 'custom');           // unknown plan → default
  assert.equal(bad.weeklyTokenBudget, 0);     // negative clamps to 0
  assert.equal(bad.refreshSec, 20);           // below floor clamps up
  assert.equal(bad.tile.cost, false);
  assert.equal(bad.tile.reactor, true);
});

test('effectiveWeeklyBudget: custom budget wins, else plan preset, else 0', () => {
  assert.equal(cu.effectiveWeeklyBudget({ plan: 'custom', weeklyTokenBudget: 0 }), 0);
  assert.equal(cu.effectiveWeeklyBudget({ plan: 'max5', weeklyTokenBudget: 0 }), cu.PLAN_PRESETS.max5);
  // An explicit custom budget overrides the plan preset.
  assert.equal(cu.effectiveWeeklyBudget({ plan: 'max20', weeklyTokenBudget: 12345 }), 12345);
});

test('priceForModel maps families with an Opus-tier default', () => {
  assert.deepEqual(cu.priceForModel('claude-opus-4-8'), [5, 25]);
  assert.deepEqual(cu.priceForModel('claude-sonnet-5'), [3, 15]);
  assert.deepEqual(cu.priceForModel('claude-haiku-4-5-20251001'), [1, 5]);
  assert.deepEqual(cu.priceForModel('claude-fable-5'), [10, 50]);
  assert.deepEqual(cu.priceForModel('mystery-model'), [5, 25]);
});

// ── end-to-end aggregation against a fixture transcript tree ──────────────────

function line(obj) { return JSON.stringify(obj); }
function assistant({ ts, model, id, reqId, cwd, branch, usage }) {
  return line({
    type: 'assistant', timestamp: new Date(ts).toISOString(),
    requestId: reqId, cwd, gitBranch: branch,
    message: { id, model, usage },
  });
}

test('aggregate: dedupe, day/week buckets, live signal, projects & models', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-claude-'));
  const projects = path.join(dir, 'projects');
  const alpha = path.join(projects, 'C--alpha');
  const beta = path.join(projects, 'C--beta');
  fs.mkdirSync(alpha, { recursive: true });
  fs.mkdirSync(beta, { recursive: true });

  // Deterministic local "now": Wed 2026-07-08 12:00 (week starts Mon 2026-07-06).
  const now = new Date(2026, 6, 8, 12, 0, 0).getTime();
  const t1 = now - 60 * 1000;                        // 1 min ago → today, live
  const t2 = new Date(2026, 6, 7, 10, 0, 0).getTime(); // Tue → this week, not today
  const t3 = new Date(2026, 5, 1, 10, 0, 0).getTime(); // Jun 1 → outside 30d history

  const u1 = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 300, server_tool_use: { web_search_requests: 2, web_fetch_requests: 1 } };
  const rec1 = assistant({ ts: t1, model: 'claude-opus-4-8', id: 'm1', reqId: 'r1', cwd: 'C:/alpha', branch: 'main', usage: u1 });

  fs.writeFileSync(path.join(alpha, 's1.jsonl'), [
    line({ type: 'summary' }),                        // non-assistant → ignored
    line({ type: 'user', timestamp: new Date(t1 - 5000).toISOString(), message: { role: 'user', content: 'fix the login bug' } }),
    line({ type: 'user', timestamp: new Date(t1 - 4000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', content: 'ignored' }] } }),
    rec1,
    rec1,                                             // duplicate requestId+id → deduped
    'not json',                                       // malformed → ignored
    assistant({ ts: t2, model: 'claude-sonnet-5', id: 'm2', reqId: 'r2', cwd: 'C:/alpha', branch: 'main',
      usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }),
  ].join('\n'));

  fs.writeFileSync(path.join(beta, 's2.jsonl'),
    assistant({ ts: t3, model: 'claude-haiku-4-5', id: 'm3', reqId: 'r3', cwd: 'C:/beta', branch: 'dev',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }));

  const reader = cu.createReader({ dir: projects });
  const agg = await reader.getUsage(now);

  // 3 unique requests (the duplicate line collapsed).
  assert.equal(agg.total.reqs, 3);
  assert.equal(agg.total.tokens, 650 + 15 + 2);

  // Today = rec1 only; this week = rec1 + rec2.
  assert.equal(agg.today.reqs, 1);
  assert.equal(agg.today.tokens, 650);
  assert.equal(agg.week.reqs, 2);
  assert.equal(agg.week.tokens, 650 + 15);

  // Live: newest record is 1 min old.
  assert.equal(agg.live.active, true);
  assert.equal(agg.live.project, 'alpha');
  assert.equal(agg.live.branch, 'main');
  assert.equal(agg.live.model, 'claude-opus-4-8');

  // Concurrent sessions: one is live; it carries the last human prompt (tool
  // results and non-text envelopes are ignored) and the session/web counts.
  assert.equal(agg.live.count, 1);
  assert.equal(agg.sessions.length, 1);
  assert.equal(agg.sessions[0].project, 'alpha');
  assert.equal(agg.sessions[0].task, 'fix the login bug');
  assert.equal(agg.stats.sessionsToday, 1);
  assert.equal(agg.stats.webSearches, 2);
  assert.equal(agg.stats.webSearchesWeek, 2);

  // Cache hit rate = cacheRead / (input + cacheWrite + cacheRead) over totals.
  const cr = 300, inp = 100 + 10 + 1, cc = 200;
  assert.ok(Math.abs(agg.cacheHitRate - cr / (inp + cc + cr)) < 1e-9);

  // Projects sorted by tokens (alpha > beta); models present.
  assert.equal(agg.projects[0].name, 'alpha');
  assert.ok(agg.models.some(m => m.model === 'claude-opus-4-8'));

  // Daily series is a fixed 30-day window ending today; Jun 1 is excluded.
  assert.equal(agg.daily.length, 30);
  const todayKey = cu._internal.localDayKey(now);
  const todayCell = agg.daily.find(d => d.day === todayKey);
  assert.equal(todayCell.tokens, 650);
  assert.ok(!agg.daily.some(d => d.day === cu._internal.localDayKey(t3)));

  // Equivalent cost is positive.
  assert.ok(agg.total.cost > 0);

  // Signature is stable across calls when nothing changed.
  const agg2 = await reader.getUsage(now);
  assert.equal(agg.sig, agg2.sig);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('missing projects dir yields an empty aggregate, never throws', async () => {
  const reader = cu.createReader({ dir: path.join(os.tmpdir(), 'xenon-does-not-exist-' + process.pid) });
  const agg = await reader.getUsage(Date.now());
  assert.equal(agg.total.reqs, 0);
  assert.equal(agg.total.tokens, 0);
  assert.equal(agg.live.active, false);
  assert.equal(agg.daily.length, 30);
});

test('incremental append: new records fold in via the tail-read path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xenon-claude-inc-'));
  const projects = path.join(dir, 'projects');
  const proj = path.join(projects, 'C--inc');
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, 's1.jsonl');

  const now = new Date(2026, 6, 8, 12, 0, 0).getTime();
  const t1 = now - 60 * 1000;
  fs.writeFileSync(file, assistant({ ts: t1, model: 'claude-opus-4-8', id: 'm1', reqId: 'r1', cwd: 'C:/inc', branch: 'main',
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) + '\n');
  // The between-sweeps "hot file" filter compares the caller's clock with the
  // file's mtime; the test clock is synthetic, so pin the mtime to match.
  fs.utimesSync(file, new Date(t1), new Date(t1));

  const reader = cu.createReader({ dir: projects });
  const agg1 = await reader.getUsage(now);
  assert.equal(agg1.total.reqs, 1);
  assert.equal(agg1.total.tokens, 150);

  // Append whole lines with a trailing newline (the shape Claude Code writes).
  // The second pass lands inside the full-scan throttle window, so this
  // exercises the hot-file incremental tail-read, not a full re-parse.
  fs.appendFileSync(file, assistant({ ts: t1 + 1000, model: 'claude-opus-4-8', id: 'm2', reqId: 'r2', cwd: 'C:/inc', branch: 'main',
    usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }) + '\n');
  fs.utimesSync(file, new Date(t1 + 1000), new Date(t1 + 1000));

  const agg2 = await reader.getUsage(now + 2000);
  assert.equal(agg2.total.reqs, 2);
  assert.equal(agg2.total.tokens, 165);

  fs.rmSync(dir, { recursive: true, force: true });
});
