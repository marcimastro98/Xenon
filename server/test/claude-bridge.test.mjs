import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cb = require('../claude-bridge.js');

// A bridge on a clock we control, so expiry/urgency are testable without waiting.
function makeBridge(start = 1_000_000) {
  let now = start;
  const changes = { count: 0 };
  const bridge = cb.createBridge({ now: () => now, onChange: () => { changes.count++; } });
  return { bridge, changes, advance: (ms) => { now += ms; }, at: () => now };
}

// ── statusline ingest ─────────────────────────────────────────────────────────

test('applyStatus captures the real rate-limit windows', () => {
  const { bridge } = makeBridge();
  bridge.applyStatus({
    session_id: 's1',
    cwd: 'C:/work/xenon',
    model: { id: 'claude-opus-4-8', display_name: 'Opus' },
    context_window: { used_percentage: 42 },
    cost: { total_cost_usd: 1.25 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
  });

  const snap = bridge.snapshot();
  assert.equal(snap.limits.fiveHour.pct, 23.5);
  assert.equal(snap.limits.fiveHour.resetsAt, 1738425600);
  assert.equal(snap.limits.sevenDay.pct, 41.2);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].project, 'xenon');   // basename of cwd
  assert.equal(snap.sessions[0].model, 'claude-opus-4-8');
  assert.equal(snap.sessions[0].contextPct, 42);
});

test('a session without rate_limits never blanks a known reading', () => {
  const { bridge } = makeBridge();
  bridge.applyStatus({ session_id: 's1', rate_limits: { five_hour: { used_percentage: 60, resets_at: 5 } } });
  // An API-key session (no windows at all) reports right after — the good value
  // from the subscriber session must survive.
  bridge.applyStatus({ session_id: 's2', model: { id: 'claude-sonnet-5' } });
  assert.equal(bridge.snapshot().limits.fiveHour.pct, 60);
});

test('an absent window stays null rather than reading as 0%', () => {
  const { bridge } = makeBridge();
  bridge.applyStatus({ session_id: 's1', rate_limits: { seven_day: { used_percentage: 12, resets_at: 9 } } });
  const snap = bridge.snapshot();
  assert.equal(snap.limits.fiveHour, null);
  assert.equal(snap.limits.sevenDay.pct, 12);
});

// ── hook ingest ───────────────────────────────────────────────────────────────

test('hooks drive exact session state', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/home/me/proj' });
  assert.equal(bridge.snapshot().sessions[0].state, 'idle');

  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'fix the login bug' });
  let s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'running');
  assert.equal(s.task, 'fix the login bug');

  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' });
  assert.equal(bridge.snapshot().sessions[0].tool, 'Bash');

  bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash' });
  assert.equal(bridge.snapshot().sessions[0].tool, '');

  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'needs input' });
  assert.equal(bridge.snapshot().sessions[0].state, 'waiting');

  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  assert.equal(bridge.snapshot().sessions[0].state, 'idle');

  bridge.applyHook({ hook_event_name: 'SessionEnd', session_id: 's1' });
  assert.equal(bridge.snapshot().sessions.length, 0);
});

test('stale sessions are pruned from the snapshot', () => {
  const { bridge, advance } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/a/b' });
  advance(cb.SESSION_STALE_MS + 1000);
  assert.equal(bridge.snapshot().sessions.length, 0);
});

// ── permission requests ───────────────────────────────────────────────────────

test('a tap resolves the blocked request', async () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm run build' } });
  assert.ok(req);

  const snap = bridge.snapshot();
  assert.equal(snap.approvals.length, 1);
  assert.equal(snap.approvals[0].tool, 'Bash');
  assert.equal(snap.approvals[0].detail, 'npm run build');
  assert.equal(snap.approvals[0].urgent, false);      // not destructive → escalates later

  assert.equal(bridge.decide(req.id, 'allow'), true);
  assert.equal(await req.promise, 'allow');
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('deny resolves as deny, and a second tap is refused', async () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } });
  bridge.decide(req.id, 'deny');
  assert.equal(await req.promise, 'deny');
  // Already settled: a late tap from another surface must report failure, not
  // silently resolve a request that is gone.
  assert.equal(bridge.decide(req.id, 'allow'), false);
});

test('an unanswered request times out as "timeout", never as allow', async () => {
  const { bridge } = makeBridge();
  // Real timers here: the expiry path is the one that must not auto-approve.
  const short = cb.createBridge({ onChange: () => {} });
  const req = short.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  short.stop();                                   // shutdown settles everything pending
  assert.equal(await req.promise, 'timeout');
  assert.equal(bridge.snapshot().approvals.length, 0);
});

// ── harness-injected prompts ──────────────────────────────────────────────────
// Claude Code delivers task notifications, system reminders and skill preambles
// through the same user-turn channel a person types into. One of those as a
// session's headline reads as if the user asked for it.

test('injected prompts are recognised, real ones are not', () => {
  for (const injected of [
    '<task-notification> <task-id>abc</task-id>',
    '<system-reminder>do the thing</system-reminder>',
    '<command-name>/compact</command-name>',
    '[Request interrupted by user]',
    'Caveat: The messages below were generated',
    'This session is being continued from a previous conversation',
    'Base directory for this skill: C:/x',
    '', '   ',
  ]) assert.equal(cb.isInjectedPrompt(injected), true, JSON.stringify(injected));

  for (const real of [
    'fix the failing test in auth.js',
    'come mai nello store e vuoto?',
    'a < b, why does this fail?',
    'perche 3 < 5 non funziona',
  ]) assert.equal(cb.isInjectedPrompt(real), false, JSON.stringify(real));
});

test('an injected prompt never becomes the session task', () => {
  const { bridge } = makeBridge();
  const submit = (prompt) => bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt });

  submit('refactor the parser');
  assert.equal(bridge.snapshot().sessions[0].task, 'refactor the parser');

  // The harness speaks next. The real task must survive it.
  submit('<task-notification> agent finished');
  assert.equal(bridge.snapshot().sessions[0].task, 'refactor the parser');

  submit('now add a test');
  assert.equal(bridge.snapshot().sessions[0].task, 'now add a test');
});

// ── AskUserQuestion projection ────────────────────────────────────────────────
// These are NOT permissions: the server answers them at once and posts a notice
// instead, so the card is a heads-up that can be read and dismissed. It resolves
// nothing, must never escalate to the fullscreen overlay, and dismissing it must
// not mark the session as unblocked — it is still waiting, in the terminal.

test('AskUserQuestion projects its question and options', () => {
  const { bridge } = makeBridge();
  bridge.postQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: {
      questions: [{
        question: 'Which database?', header: 'Storage', multiSelect: false,
        options: [
          { label: 'SQLite', description: 'One file, no server' },
          { label: 'Postgres', description: 'Needs a server' },
        ],
      }],
    },
  });
  const [a] = bridge.snapshot().approvals;
  assert.equal(a.tool, 'AskUserQuestion');
  assert.equal(a.questions.length, 1);
  assert.equal(a.questions[0].question, 'Which database?');
  assert.equal(a.questions[0].header, 'Storage');
  assert.equal(a.questions[0].multiSelect, false);
  assert.deepEqual(a.questions[0].options.map(o => o.label), ['SQLite', 'Postgres']);
});

test('question projection is bounded and drops junk options', () => {
  const { bridge } = makeBridge();
  bridge.postQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: {
      questions: Array.from({ length: 9 }, () => ({
        question: 'x'.repeat(5000),
        options: Array.from({ length: 30 }, (_, i) => (i === 0 ? { label: '' } : { label: 'o' + i })),
      })),
    },
  });
  const [a] = bridge.snapshot().approvals;
  assert.ok(a.questions.length <= 4, 'question count capped');
  assert.ok(a.questions[0].question.length < 5000, 'question text bounded');
  assert.ok(a.questions[0].options.length <= 5, 'option count capped');
  assert.ok(a.questions[0].options.every(o => o.label), 'label-less options dropped');
});

test('a non-question tool carries no questions block', () => {
  const { bridge } = makeBridge();
  bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(bridge.snapshot().approvals[0].questions, null);
});

test('AskUserQuestion without a usable questions array posts no card at all', () => {
  const { bridge } = makeBridge();
  // Nothing readable to show, and nothing is blocked on it, so there is no card
  // worth drawing — the terminal already has the prompt.
  assert.equal(bridge.postQuestion({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: 'nope' } }), null);
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('a question notice is flagged, never urgent, and blocks nothing', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/p' });
  const id = bridge.postQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }] }] },
  });
  assert.ok(id, 'notice posted');
  const [a] = bridge.snapshot().approvals;
  assert.equal(a.notice, true);
  assert.equal(a.urgent, false, 'a notice must never take over the display');
  assert.equal(bridge.pendingCount, 1);
});

test('dismissing a notice clears the card without touching session state', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ session_id: 's1', hook_event_name: 'Notification', message: 'waiting', cwd: '/p' });
  const before = bridge.snapshot().sessions[0].state;
  const id = bridge.postQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }] }] },
  });
  assert.equal(bridge.decide(id, 'allow'), true);
  assert.equal(bridge.snapshot().approvals.length, 0, 'card dismissed');
  assert.equal(bridge.snapshot().sessions[0].state, before,
    'the session is still waiting on the user in the terminal');
});

test('stop() settles blocked permissions and steps over notices', () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  bridge.postQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }] }] },
  });
  bridge.stop();                       // a notice has no resolve to call
  return req.promise.then(v => assert.equal(v, 'timeout'));
});

test('destructive commands are urgent immediately', () => {
  const { bridge } = makeBridge();
  bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf build/' } });
  assert.equal(bridge.snapshot().approvals[0].urgent, true);
});

test('a plain command only becomes urgent after the grace window', () => {
  const { bridge, advance } = makeBridge();
  bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(bridge.snapshot().approvals[0].urgent, false);
  advance(cb.URGENT_AFTER_MS + 1000);
  assert.equal(bridge.snapshot().approvals[0].urgent, true);
});

test('cancel drops a request Claude Code walked away from', async () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'sleep 1' } });
  assert.equal(bridge.cancel(req.id), true);
  assert.equal(await req.promise, 'timeout');
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('pending requests are bounded', () => {
  const { bridge } = makeBridge();
  const made = [];
  for (let i = 0; i < 20; i++) made.push(bridge.requestPermission({ session_id: 's' + i, tool_name: 'Read', tool_input: { file_path: '/f' + i } }));
  // Past the cap the bridge refuses rather than queueing — the caller hands the
  // prompt back to the terminal.
  assert.ok(made.some(m => m === null));
  assert.ok(bridge.snapshot().approvals.length <= 8);
});

// ── helpers ───────────────────────────────────────────────────────────────────

test('describeTool summarizes by tool shape', () => {
  assert.equal(cb.describeTool('Bash', { command: 'git status' }), 'git status');
  assert.equal(cb.describeTool('Read', { file_path: '/a/b.txt' }), '/a/b.txt');
  assert.equal(cb.describeTool('WebFetch', { url: 'https://x.dev' }), 'https://x.dev');
  assert.equal(cb.describeTool('Grep', { pattern: 'TODO' }), 'TODO');
  // Unknown tool → first usable string, never a raw JSON dump.
  assert.equal(cb.describeTool('mcp__thing__do', { target: 'lamp' }), 'lamp');
  assert.equal(cb.describeTool('Weird', {}), '');
});

test('isDestructive only fires on genuinely wide-blast commands', () => {
  assert.equal(cb.isDestructive('Bash', 'rm -rf /tmp/x'), true);
  assert.equal(cb.isDestructive('Bash', 'git reset --hard'), true);
  assert.equal(cb.isDestructive('Bash', 'npm run build'), false);
  // Same text under a tool that cannot execute it is not destructive.
  assert.equal(cb.isDestructive('Read', 'rm -rf /'), false);
});

test('rendered strings are length-clamped at the ingest boundary', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'x'.repeat(5000) });
  assert.ok(bridge.snapshot().sessions[0].task.length <= 220);
});

test('snapshot signature changes with state and pending set', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: '/a/b' });
  const a = bridge.snapshot().sig;
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Edit' });
  const b = bridge.snapshot().sig;
  assert.notEqual(a, b);
  bridge.requestPermission({ session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/a' } });
  assert.notEqual(b, bridge.snapshot().sig);
});

// ── the folder a session lives in ─────────────────────────────────────────────

test('a session learns its project from any hook, not only SessionStart', () => {
  const { bridge } = makeBridge();
  // Xenon started mid-session, so the first thing it ever sees is a tool call.
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 'late', cwd: 'C:/work/xenon-suite', tool_name: 'Bash' });
  const s = bridge.snapshot().sessions.find(x => x.id === 'late');
  assert.equal(s.project, 'xenon-suite');
});

test('cwdFor returns the full folder, and the snapshot does not carry it', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: 'C:/work/xenon' });
  assert.equal(bridge.cwdFor('s1'), 'C:/work/xenon');
  assert.equal(bridge.cwdFor('nope'), '');
  const s = bridge.snapshot().sessions.find(x => x.id === 's1');
  assert.equal(s.cwd, undefined);
});

test('statusline cwd also names the project', () => {
  const { bridge } = makeBridge();
  bridge.applyStatus({ session_id: 's2', workspace: { current_dir: 'C:/work/leonardoschool' } });
  assert.equal(bridge.cwdFor('s2'), 'C:/work/leonardoschool');
  assert.equal(bridge.snapshot().sessions.find(x => x.id === 's2').project, 'leonardoschool');
});
