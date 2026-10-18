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

  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  s = bridge.snapshot().sessions[0];
  assert.equal(s.tool, 'Bash');
  // The argument, not just the tool name. Without this the row said "Bash" and
  // could not say which command was running.
  assert.equal(s.toolDetail, 'npm test');

  bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm test' }, duration_ms: 1200 });
  s = bridge.snapshot().sessions[0];
  assert.equal(s.tool, '');
  assert.equal(s.activity.at(-1).tool, 'Bash');
  assert.equal(s.activity.at(-1).ok, true);
  assert.equal(s.activity.at(-1).ms, 1200);

  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'needs input' });
  s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'waiting');
  // A bare "waiting" is the state the old widget could not explain.
  assert.equal(s.waitFor.kind, 'notification');
  assert.equal(s.waitFor.text, 'needs input');

  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'All done.' });
  s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'idle');
  assert.equal(s.waitFor, null);
  assert.equal(s.lastSaid, 'All done.');

  bridge.applyHook({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'prompt_input_exit' });
  s = bridge.snapshot().sessions[0];
  // NOT deleted. "Did it finish, or did I kill it?" is the question the user
  // asks next, and a deleted record answered neither.
  assert.equal(s.ended, true);
  assert.equal(s.endedReason, 'prompt_input_exit');
});

test('a tool finishing does not un-wait a session that is blocked on the user', () => {
  const { bridge } = makeBridge();
  // The empirically wrong behaviour: PostToolUse used to force state:'running',
  // so a session genuinely waiting on a permission went back to claiming it was
  // working the moment any other tool completed.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'Claude needs your permission' });
  assert.equal(bridge.snapshot().sessions[0].state, 'waiting');

  bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } });
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'waiting');
  assert.equal(s.waitFor.kind, 'permission');
});

test('the idle nudge after a finished turn is not a session waiting on you', () => {
  const { bridge, advance } = makeBridge();
  // The real sequence, seen on a session that had been finished for 47 minutes:
  // the turn ends, and a minute later Claude Code says "Claude is waiting for
  // your input". That is not a block, it is an empty prompt. Reading it as one
  // put the session in the waiting state, drew it as "waiting for you" under
  // the Finished heading, and turned the top bar red while two other sessions
  // were actually working.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'do the thing' });
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Done.' });
  advance(60_000);
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'Claude is waiting for your input' });

  const s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'idle');
  assert.equal(s.waitFor, null);
});

test('a notification DURING a turn is still a real block', () => {
  const { bridge } = makeBridge();
  // Same event, opposite meaning, told apart by when it arrives rather than by
  // reading its text — which is a different string in every language and every
  // version. Here there is a tool running, so nothing has ended.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm x' } });
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'Claude needs your permission to use Bash' });

  const s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'waiting');
  assert.equal(s.waitFor.kind, 'notification');
});

test('a session we meet for the first time while idle is not waiting either', () => {
  const { bridge } = makeBridge();
  // Xenon started after Claude Code did, so the first thing it ever hears about
  // this session is the idle nudge. With no turn ever seen, the safe reading is
  // "no turn is running".
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', cwd: '/a/b', message: 'Claude is waiting for your input' });
  assert.equal(bridge.snapshot().sessions[0].waitFor, null);
});

test('a new prompt reopens the turn, so the next notification counts again', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'idle' });
  assert.equal(bridge.snapshot().sessions[0].waitFor, null);
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'again' });
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'Claude needs your permission' });
  assert.equal(bridge.snapshot().sessions[0].state, 'waiting');
});

test('a failed tool is recorded as failed, not as a success', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Edit', tool_input: { file_path: '/a.js' } });
  const [e] = bridge.snapshot().sessions[0].activity;
  assert.equal(e.tool, 'Edit');
  assert.equal(e.ok, false);
});

test('TodoWrite becomes the plan lane', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'TodoWrite',
    tool_input: {
      todos: [
        { content: 'Read the collector', activeForm: 'Reading the collector', status: 'completed' },
        { content: 'Write the parser', activeForm: 'Writing the parser', status: 'in_progress' },
        { content: 'Add tests', activeForm: 'Adding tests', status: 'pending' },
      ],
    },
  });
  const todos = bridge.snapshot().sessions[0].todos;
  assert.deepEqual(todos.map(t => t.status), ['done', 'doing', 'todo']);
  // The running step reads in the present tense, which is what a live tile wants.
  assert.equal(todos[1].text, 'Writing the parser');
  assert.equal(todos[2].text, 'Add tests');

  // And it survives the tools that run after it.
  bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.equal(bridge.snapshot().sessions[0].todos.length, 3);
});

test('subagents are tracked, kept a while once finished, then released', () => {
  const { bridge, advance } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  bridge.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a2', agent_type: 'Plan' });
  assert.equal(bridge.snapshot().sessions[0].subagents.length, 2);
  // A duplicate start (a re-delivered hook) must not double-count.
  bridge.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  assert.equal(bridge.snapshot().sessions[0].subagents.length, 2);
  bridge.applyHook({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', last_assistant_message: '\nFound 3 callers.\nDetails…' });
  let agents = bridge.snapshot().sessions[0].subagents;
  assert.deepEqual(agents.map(a => [a.id, a.status]), [['a1', 'done'], ['a2', 'running']]);
  assert.equal(agents[0].last, 'Found 3 callers.');
  advance(3 * 60 * 1000);
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/x' } });
  assert.deepEqual(bridge.snapshot().sessions[0].subagents.map(a => a.id), ['a2']);
});

test('a subagent carries its label, its tools, its effort and its context size', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', tool_input: { description: 'Find the callers', subagent_type: 'Explore', prompt: 'long secret prompt' } });
  bridge.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'paint(' } });
  bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'a1', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'paint(' } });
  bridge.applyMod({ v: 1, kind: 'agent', sessionId: 's1', agentId: 'a1', type: 'Explore', model: 'claude-haiku-5-5' });
  bridge.applyMod({ v: 1, kind: 'agentStat', sessionId: 's1', agentId: 'a1', effort: 'medium', tokens: 45210 });
  assert.equal(bridge.applyMod({ v: 1, kind: 'agentStat', sessionId: 's1', agentId: 'nope', done: true }), false);
  const a = bridge.snapshot().sessions[0].subagents[0];
  assert.equal(a.desc, 'Find the callers');
  assert.equal(a.tools, 1);
  assert.equal(a.tool, 'Grep');
  assert.equal(a.detail, 'paint(');
  assert.equal(a.model, 'claude-haiku-5-5');
  assert.equal(a.effort, 'medium');
  assert.equal(a.tokens, 45210);
  assert.ok(!JSON.stringify(a).includes('secret'), 'the prompt never reaches the snapshot');
  bridge.applyMod({ v: 1, kind: 'agentStat', sessionId: 's1', agentId: 'a1', done: true });
  assert.equal(bridge.snapshot().sessions[0].subagents[0].status, 'done');
});

test('an agent already running when Xenon started shows up at its first tool call', () => {
  const { bridge } = makeBridge();
  // No SubagentStart: it fired before this server was up.
  bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', agent_id: 'a9', agent_type: 'general-purpose', tool_name: 'Bash', tool_input: { command: 'ls' } });
  let a = bridge.snapshot().sessions[0].subagents;
  assert.deepEqual(a.map(x => [x.id, x.type, x.status, x.tools]), [['a9', 'general-purpose', 'running', 1]]);
  // The same from the mod's figures alone.
  bridge.applyMod({ v: 1, kind: 'agentStat', sessionId: 's1', agentId: 'b2', tokens: 1200 });
  a = bridge.snapshot().sessions[0].subagents;
  assert.deepEqual(a.map(x => x.id), ['a9', 'b2']);
});

test('compaction is an explained event, not a mystery drop in the gauge', () => {
  const { bridge } = makeBridge();
  bridge.applyStatus({ session_id: 's1', context_window: { used_percentage: 94 } });
  bridge.applyHook({ hook_event_name: 'PreCompact', session_id: 's1' });
  assert.equal(bridge.snapshot().sessions[0].compacting, true);
  bridge.applyHook({ hook_event_name: 'PostCompact', session_id: 's1' });
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.compacting, false);
  assert.equal(s.contextPct, null);
});

test('the activity ring is bounded', () => {
  const { bridge } = makeBridge();
  for (let i = 0; i < 120; i++) {
    bridge.applyHook({ hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Read', tool_input: { file_path: '/f' + i } });
  }
  const act = bridge.snapshot().sessions[0].activity;
  assert.ok(act.length <= 30, `ring ${act.length}`);
  // Oldest dropped, newest kept.
  assert.equal(act.at(-1).detail, '/f119');
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
  assert.deepEqual(await req.promise, { verdict: 'allow' });
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('deny resolves as deny, and a second tap is refused', async () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: '/etc/hosts' } });
  bridge.decide(req.id, 'deny');
  assert.deepEqual(await req.promise, { verdict: 'deny' });
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
  assert.deepEqual(await req.promise, { verdict: 'timeout' });
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('ExitPlanMode carries the plan, so the card shows what is being approved', () => {
  const { bridge } = makeBridge();
  bridge.requestPermission({
    session_id: 's1', tool_name: 'ExitPlanMode',
    tool_input: { plan: '1. Read the file\n2. Change it\n3. Test it' },
  });
  const [a] = bridge.snapshot().approvals;
  assert.equal(a.kind, 'plan');
  assert.ok(a.plan.includes('2. Change it'));
});

// Claude Code ignores an allow for ExitPlanMode that carries no updatedInput:
// the terminal dialog just stays up. That was "I tap Allow and nothing happens".
test('approving a plan echoes the input and sets the chosen mode', async () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', permission_mode: 'auto', tool_name: 'Read' });
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', permission_mode: 'plan', tool_name: 'ExitPlanMode' });
  const input = { plan: '# Plan', planFilePath: '/p/plan.md' };
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'ExitPlanMode', tool_input: input });
  const [a] = bridge.snapshot().approvals;
  assert.deepEqual(a.choices, ['auto', 'default'], 'auto first, as the terminal offers it');
  assert.equal(bridge.decide(req.id, 'allow', { mode: 'default' }), true);
  const out = await req.promise;
  assert.equal(out.verdict, 'allow');
  assert.deepEqual(out.updatedInput, input);
  assert.deepEqual(out.updatedPermissions, [{ type: 'setMode', mode: 'default', destination: 'session' }]);
});

test('a plan card offers auto-accept edits when auto mode was never seen', async () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', permission_mode: 'default', tool_name: 'Read' });
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  assert.deepEqual(bridge.snapshot().approvals[0].choices, ['acceptEdits', 'default']);
  // A mode the card never offered falls back to its first row, never to bypass.
  bridge.decide(req.id, 'allow', { mode: 'bypassPermissions' });
  const out = await req.promise;
  assert.equal(out.updatedPermissions[0].mode, 'acceptEdits');
});

test('the configured default mode makes auto available to a fresh session', () => {
  const bridge = cb.createBridge({ onChange: () => {}, defaultMode: () => 'auto' });
  bridge.requestPermission({ session_id: 'new', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  assert.equal(bridge.snapshot().approvals[0].choices[0], 'auto');
  bridge.stop();
});

test('sending a plan back denies with the feedback for Claude to read', async () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } });
  bridge.decide(req.id, 'deny', { feedback: 'use one colour, not eight' });
  const out = await req.promise;
  assert.equal(out.verdict, 'deny');
  assert.ok(out.message.includes('use one colour, not eight'));
  assert.ok(/stay in plan mode/i.test(out.message));
  assert.equal(out.updatedInput, undefined, 'a refusal carries no input to run');
});

test('an ordinary permission is still a bare allow or deny', async () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  bridge.decide(req.id, 'allow', { mode: 'auto', feedback: 'x' });
  assert.deepEqual(await req.promise, { verdict: 'allow' });
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

// ── AskUserQuestion ───────────────────────────────────────────────────────────
// These are questions the user ANSWERS from the touchscreen. The answer goes
// back as the tool's own input with `answers` filled in, so the tool returns it
// exactly as if it had been picked in the terminal. (An earlier version sent it
// as the reason on a DENIED call: Claude acted on it, but the terminal drew the
// question as a refused tool call.)
//
// What these tests defend, in order of how badly it would fail: an option the
// page invented must never be sent as one of Claude's labels; nothing may
// auto-answer; and a question must never seize the whole screen the way a
// destructive command does.

test('AskUserQuestion projects its question and options', () => {
  const { bridge } = makeBridge();
  bridge.askQuestion({
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
  assert.equal(a.questions[0].kind, 'choice');
  assert.equal(a.questions[0].multiSelect, false);
  assert.deepEqual(a.questions[0].options.map(o => o.label), ['SQLite', 'Postgres']);
  assert.equal(a.input, undefined, 'the raw input never goes to the page');
  assert.equal(a.keys, undefined);
});

test('question projection is bounded and drops junk options', () => {
  const { bridge } = makeBridge();
  bridge.askQuestion({
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

test('AskUserQuestion without a usable questions array holds nothing open', () => {
  const { bridge } = makeBridge();
  // Nothing readable to show, so there is no card worth drawing — and the caller
  // answers {}, which lets the tool run and ask in the terminal.
  assert.equal(bridge.askQuestion({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: { questions: 'nope' } }), null);
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('a question is a question, never a permission, and never seizes the screen', () => {
  const { bridge, advance } = makeBridge();
  const q = bridge.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Which one?', options: [{ label: 'A' }] }] },
  });
  const [a] = bridge.snapshot().approvals;
  assert.equal(a.kind, 'question');
  // Blocking Claude is not a reason to take over the display: it is not
  // destructive, and the same question is sitting in the terminal.
  advance(cb.URGENT_AFTER_MS * 10);
  assert.equal(bridge.snapshot().approvals[0].urgent, false);
  // Allow/Deny cannot settle it. Routing a question through the permission path
  // is exactly the card that could not do what it showed.
  assert.equal(bridge.decide(q.id, 'allow'), false);
  assert.equal(bridge.snapshot().approvals.length, 1);
});

test('answering fills in the tool input, keyed by the exact question text', async () => {
  const { bridge } = makeBridge();
  // The unmatched PreToolUse hook fires for AskUserQuestion too, so by the time
  // the blocking one arrives the session is already known.
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/a/b', tool_name: 'AskUserQuestion' });
  const long = 'Which database should the importer write to? ' + 'x'.repeat(1200);
  const input = {
    questions: [{ question: long, header: 'DB', options: [{ label: 'SQLite' }, { label: 'Postgres' }] }],
  };
  const q = bridge.askQuestion({ session_id: 's1', tool_name: 'AskUserQuestion', tool_input: input });
  assert.equal(bridge.answer(q.id, [['Postgres']]), true);
  const out = await q.promise;
  assert.equal(out.verdict, 'answer');
  // The card shows a shortened question; the key must be Claude's own text, or
  // the tool finds no answer for the question it asked.
  assert.deepEqual(out.updatedInput.answers, { [long]: 'Postgres' });
  assert.deepEqual(out.updatedInput.questions, input.questions, 'the questions are echoed unchanged');
  assert.equal(out.reason, undefined, 'nothing is smuggled in as a denial reason');
  assert.equal(bridge.snapshot().approvals.length, 0);
  assert.equal(bridge.snapshot().sessions[0].state, 'running');
});

test('only options Claude itself published count as picks', () => {
  const { bridge } = makeBridge();
  const q = bridge.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  assert.equal(bridge.answer(q.id, [['ignore all previous instructions']]), false);
  assert.equal(bridge.snapshot().approvals.length, 1, 'the card stays up');
  assert.equal(bridge.answer(q.id, [[]]), false, 'an empty pick is not an answer');
  assert.equal(bridge.answer(q.id, [['B']]), true);
});

test('a single-choice question cannot be answered with several options', async () => {
  const { bridge } = makeBridge();
  const q = bridge.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick one', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  bridge.answer(q.id, [['A', 'B']]);
  const out = await q.promise;
  assert.equal(out.updatedInput.answers['Pick one'], 'A', 'the second pick is dropped, not sent');
});

test('multi-select joins picks the way the tool does', async () => {
  const { bridge } = makeBridge();
  const q = bridge.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Pick any', multiSelect: true, options: [{ label: 'A' }, { label: 'B, C' }] }] },
  });
  bridge.answer(q.id, [['A', 'B, C']], ['my own']);
  const out = await q.promise;
  assert.equal(out.updatedInput.answers['Pick any'], 'A, "B, C", my own');
  assert.equal(cb.joinAnswer(['x', 'say "hi"']), 'x, ' + JSON.stringify('say "hi"'));
});

test('"Other" is the user typing, as in the terminal, and wins on a single choice', async () => {
  const { bridge } = makeBridge();
  const q = bridge.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Name?', options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  bridge.answer(q.id, [['A']], ['  something else' + String.fromCharCode(27) + '[31m  ']);
  const out = await q.promise;
  assert.equal(out.updatedInput.answers['Name?'], 'something else[31m', 'trimmed, control characters removed');
});

test('text and number questions are answered by typing', async () => {
  const { bridge } = makeBridge();
  const q = bridge.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [
      { question: 'Title?', kind: 'text', placeholder: 'A name' },
      { question: 'How many?', kind: 'number', min: 1, max: 10 },
    ] },
  });
  const [a] = bridge.snapshot().approvals;
  assert.equal(a.questions[0].kind, 'text');
  assert.deepEqual(a.questions[0].options, []);
  assert.equal(a.questions[1].max, 10);
  assert.equal(bridge.answer(q.id, [[], []], ['', '42']), false, 'out of range is no answer');
  assert.equal(bridge.answer(q.id, [[], []], ['Report', '7']), true);
  const out = await q.promise;
  assert.deepEqual(out.updatedInput.answers, { 'Title?': 'Report', 'How many?': '7' });
});

test('every non-answer path skips, which is the terminal asking', async () => {
  const { bridge } = makeBridge();
  const mk = () => bridge.askQuestion({
    session_id: 's' + Math.random(), tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
  });

  const skipped = mk();
  assert.equal(bridge.skipQuestion(skipped.id), true);
  assert.deepEqual(await skipped.promise, { verdict: 'skip' });

  const gone = mk();
  bridge.cancel(gone.id);                       // Claude Code walked away
  assert.deepEqual(await gone.promise, { verdict: 'skip' });

  const shut = mk();
  bridge.stop();                                // hub shutting down
  assert.deepEqual(await shut.promise, { verdict: 'skip' });
});

test('an unanswered question times out as a skip, never as a choice', async () => {
  const short = cb.createBridge({ onChange: () => {} });
  const q = short.askQuestion({
    session_id: 's1', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: 'Q', options: [{ label: 'A' }] }] },
  });
  short.stop();
  const out = await q.promise;
  assert.equal(out.verdict, 'skip');
  assert.equal(out.updatedInput, undefined, 'nothing is ever answered for the user');
});

// ── follow-ups into a live session ────────────────────────────────────────────

test('a follow-up is queued while Claude works and delivered at the end of the turn', async () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'build it' });
  assert.equal(bridge.replyModeFor('s1'), 'followup');

  assert.deepEqual(bridge.queueFollowUp('s1', 'also update the changelog'), { ok: true, via: 'turn' });
  // "Sent" would be a lie for however long the turn still has to run, so the
  // snapshot says queued and the tile shows that.
  assert.equal(bridge.snapshot().sessions[0].queued.text, 'also update the changelog');
  assert.equal(bridge.replyModeFor('s1'), 'queued');

  const reason = bridge.takeFollowUp('s1');
  assert.ok(reason.includes('also update the changelog'));
  // Framed as the user speaking: an unlabelled instruction out of nowhere reads
  // as an injection attempt and is correctly treated as one.
  assert.ok(/from the Xenon dashboard/i.test(reason));
  assert.equal(bridge.snapshot().sessions[0].queued, null);
  // Taking it twice is the loop guard: a blocked Stop fires Stop again, and an
  // empty queue ends the turn normally.
  assert.equal(bridge.takeFollowUp('s1'), '');
});

test('an idle session is offered a resume, not a follow-up nothing would deliver', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  // Nothing will fire Stop again, so there is no delivery point. The client asks
  // this before drawing a box, so it can say which of the two will happen.
  assert.equal(bridge.replyModeFor('s1'), 'resume');
  assert.equal(bridge.replyModeFor('nope'), 'none');
});

test('a follow-up is refused where it could not arrive', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  assert.equal(bridge.queueFollowUp('unknown', 'hi').error, 'unknown_session');
  assert.equal(bridge.queueFollowUp('s1', '   ').error, 'empty');
  bridge.queueFollowUp('s1', 'first');
  assert.equal(bridge.queueFollowUp('s1', 'second').error, 'already_queued');
  assert.equal(bridge.cancelFollowUp('s1'), true);
  assert.equal(bridge.snapshot().sessions[0].queued, null);

  bridge.queueFollowUp('s1', 'third');
  bridge.applyHook({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' });
  assert.equal(bridge.snapshot().sessions[0].queued, null, 'nothing will ever deliver it now');
  assert.equal(bridge.queueFollowUp('s1', 'again').error, 'session_ended');
});

test('a follow-up the user typed a quarter of an hour ago is not delivered', () => {
  const { bridge, advance } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  bridge.queueFollowUp('s1', 'and then deploy');
  advance(cb.FOLLOWUP_TTL_MS + 1000);
  assert.equal(bridge.takeFollowUp('s1'), '');
});

// ── tile messages into an open terminal (claude-inbox.js) ─────────────────────

// `listening` stands in for the inbox: the sessions whose mod is asking right now.
function makeTerminalBridge() {
  let now = 1_000_000;
  const listening = new Set();
  const bridge = cb.createBridge({ now: () => now, terminal: (id) => listening.has(id) });
  return { bridge, listening, advance: (ms) => { now += ms; } };
}

test('an idle session with the mod listening takes a message as a new turn, once', () => {
  const { bridge, listening } = makeTerminalBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  assert.equal(bridge.replyModeFor('s1'), 'resume', 'no mod: a background run, as before');
  listening.add('s1');
  assert.equal(bridge.replyModeFor('s1'), 'terminal');
  assert.equal(bridge.snapshot().sessions[0].terminal, true);

  assert.deepEqual(bridge.queueFollowUp('s1', 'now write the tests'), { ok: true, via: 'terminal' });
  assert.equal(bridge.snapshot().sessions[0].queued.via, 'terminal');
  assert.equal(bridge.replyModeFor('s1'), 'queued');

  // Raw: the mod submits it as the user's own words, so no dashboard framing.
  assert.equal(bridge.takeForTerminal('s1'), 'now write the tests');
  assert.equal(bridge.takeForTerminal('s1'), '', 'handed over once');
  const onItsWay = bridge.snapshot().sessions[0].queued;
  assert.equal(onItsWay.handed, true, 'on its way until the turn starts');
  assert.equal(bridge.queueFollowUp('s1', 'and the docs').error, 'already_queued');

  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'now write the tests' });
  assert.equal(bridge.snapshot().sessions[0].queued, null);
  assert.equal(bridge.replyModeFor('s1'), 'followup');
  assert.equal(bridge.applyMod({ v: 1, sessionId: 's1', kind: 'delivery', ok: true }), true);
  assert.equal(bridge.snapshot().sessions[0].undelivered, null);
});

test('a session that is working keeps the Stop hook path even with the mod listening', () => {
  const { bridge, listening } = makeTerminalBridge();
  listening.add('s1');
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'build it' });
  assert.equal(bridge.queueFollowUp('s1', 'then lint').via, 'turn');
  assert.equal(bridge.takeForTerminal('s1'), '', 'the mod never takes from a running turn');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  assert.ok(bridge.takeFollowUp('s1').includes('then lint'));
});

test('an idle message is refused where nothing could take it', () => {
  const { bridge, listening } = makeTerminalBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  // The turn ended while it was being typed: it would wait for a Stop that
  // already happened.
  assert.equal(bridge.queueFollowUp('s1', 'hello').error, 'session_idle');
  listening.add('s1');
  assert.equal(bridge.queueFollowUp('s1', '/clear').error, 'slash_command');
  assert.equal(bridge.snapshot().sessions[0].queued, null);
});

test('a message Claude Code refused is offered back, and the turn it never began is over', () => {
  const { bridge, listening, advance } = makeTerminalBridge();
  listening.add('s1');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.queueFollowUp('s1', 'deploy to prod');
  bridge.takeForTerminal('s1');
  // Our own UserPromptSubmit hook fires next to the one that blocks it.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'deploy to prod' });
  assert.equal(bridge.applyMod({ v: 1, sessionId: 's1', kind: 'delivery', ok: false, reason: 'dropped' }), true);
  let s = bridge.snapshot().sessions[0];
  assert.deepEqual({ text: s.undelivered.text, reason: s.undelivered.reason }, { text: 'deploy to prod', reason: 'dropped' });
  assert.equal(s.state, 'idle');
  assert.equal(bridge.replyModeFor('s1'), 'terminal');

  bridge.queueFollowUp('s1', 'try again');
  bridge.takeForTerminal('s1');
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'delivery', ok: false, reason: 'anything' });
  s = bridge.snapshot().sessions[0];
  assert.equal(s.undelivered.reason, 'refused');
  advance(cb.UNDELIVERED_TTL_MS + 1000);
  assert.equal(bridge.snapshot().sessions[0].undelivered, null);
  assert.equal(bridge.applyMod({ v: 1, sessionId: 's1', kind: 'delivery', ok: false }), false, 'nothing was handed over');
});

test('a closed terminal gives back a message that never reached Claude Code', () => {
  const { bridge, listening } = makeTerminalBridge();
  listening.add('s1');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.queueFollowUp('s1', 'one more thing');
  listening.delete('s1');
  assert.equal(bridge.terminalGone('s1'), true);
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.queued, null);
  assert.equal(s.undelivered.reason, 'closed');
  assert.equal(s.undelivered.text, 'one more thing');

  // Once the turn has started there is nothing to give back.
  listening.add('s1');
  bridge.queueFollowUp('s1', 'arrived');
  bridge.takeForTerminal('s1');
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'arrived' });
  assert.equal(bridge.terminalGone('s1'), false);
});

test('a session that ends first still gives back what never reached it', () => {
  // SessionEnd, or the registry seeing the process gone, can come before the
  // inbox's grace runs out and calls terminalGone: the message must not go
  // with the session.
  const { bridge, listening } = makeTerminalBridge();
  listening.add('s1');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.queueFollowUp('s1', 'typed as it closed');
  bridge.applyHook({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'prompt_input_exit' });
  let s = bridge.snapshot().sessions[0];
  assert.equal(s.queued, null);
  assert.deepEqual({ text: s.undelivered.text, reason: s.undelivered.reason }, { text: 'typed as it closed', reason: 'closed' });
  assert.equal(bridge.terminalGone('s1'), false, 'offered back once, not twice');

  // A killed process sends no SessionEnd; the registry says it is gone. No Stop
  // is coming for a message queued for the turn either.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's2', prompt: 'go' });
  bridge.mergeRegistry([{ sessionId: 's2', pid: 9, alive: true, cwd: '/a' }]);
  assert.equal(bridge.queueFollowUp('s2', 'for the turn').via, 'turn');
  bridge.mergeRegistry([{ sessionId: 's2', pid: 9, alive: false, cwd: '/a' }]);
  s = bridge.snapshot().sessions.find(x => x.id === 's2');
  assert.equal(s.ended, true);
  assert.deepEqual({ text: s.undelivered.text, reason: s.undelivered.reason }, { text: 'for the turn', reason: 'closed' });
});

test('what arrived, or may have, is not given back when the session ends', () => {
  const { bridge, listening, advance } = makeTerminalBridge();
  listening.add('s1');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.queueFollowUp('s1', 'arrived');
  bridge.takeForTerminal('s1');
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'arrived' });
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.queueFollowUp('s1', 'maybe arrived');
  bridge.takeForTerminal('s1');
  advance(cb.HANDED_TTL_MS + 1000);
  bridge.applyHook({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
  assert.equal(bridge.snapshot().sessions[0].undelivered, null);
});

test('a handed message with no sign of arrival stops showing, and is not offered back', () => {
  const { bridge, listening, advance } = makeTerminalBridge();
  listening.add('s1');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  bridge.queueFollowUp('s1', 'maybe arrived');
  bridge.takeForTerminal('s1');
  advance(cb.HANDED_TTL_MS + 1000);
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.queued, null);
  assert.equal(s.undelivered, null, 'it may have arrived: offering it back invites a duplicate');
  assert.deepEqual(bridge.queueFollowUp('s1', 'next'), { ok: true, via: 'terminal' });
});

test('the change key moves when the mod starts or stops listening', () => {
  const { bridge, listening } = makeTerminalBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  const before = bridge.snapshot().sig;
  listening.add('s1');
  assert.notEqual(bridge.snapshot().sig, before);
});

test('after Xenon restarts, an open session with the mod listening still takes messages', () => {
  const { bridge, listening } = makeTerminalBridge();
  // A restart forgets every session. The registry file brings an idle one back
  // before any hook from it, which reads as "started before Xenon was linked".
  bridge.mergeRegistry([{ sessionId: 'open', pid: 7, alive: true, cwd: 'C:/work/xenon', status: 'idle' }]);
  assert.equal(bridge.snapshot().sessions[0].unlinked, true);
  listening.add('open');
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.unlinked, false, 'a tile message gets in through the mod, hooks or not');
  assert.equal(s.terminal, true);
  assert.equal(bridge.replyModeFor('open'), 'terminal');
  assert.deepEqual(bridge.queueFollowUp('open', 'carry on'), { ok: true, via: 'terminal' });
  assert.equal(bridge.takeForTerminal('open'), 'carry on');
  listening.delete('open');
  assert.equal(bridge.snapshot().sessions[0].unlinked, true, 'without the mod, nothing reaches it again');
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
  assert.deepEqual(await req.promise, { verdict: 'timeout' });
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

test('a todo ticking over is a repaint, or the plan lane never moves', () => {
  const { bridge } = makeBridge();
  const write = (second) => bridge.applyHook({
    hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'TodoWrite',
    tool_input: { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: second }] },
  });
  write('pending');
  const before = bridge.snapshot().sig;
  write('in_progress');
  // Nothing else about the session changed. If the signature does not move, the
  // SSE push is skipped and the lane this widget was rebuilt around sits still.
  assert.notEqual(before, bridge.snapshot().sig);
});

// ── corroboration from Claude Code's own registry ─────────────────────────────

test('a session whose process is gone is retired at once, not in an hour', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/b', prompt: 'go' });
  bridge.mergeRegistry([{ sessionId: 's1', pid: 4020, alive: true, cwd: '/a/b' }]);
  assert.equal(bridge.snapshot().sessions[0].ended, false);

  // Ctrl-C: no SessionEnd is ever sent, and the pid is the only way to know.
  bridge.mergeRegistry([{ sessionId: 's1', pid: 4020, alive: false, cwd: '/a/b' }]);
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.ended, true);
  assert.equal(s.endedReason, 'gone');
  assert.equal(s.state, 'idle');
  assert.equal(bridge.replyModeFor('s1'), 'none', 'and it stops offering a follow-up');
});

test('a session missing from a readable registry has exited without saying so', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/b', prompt: 'go' });
  bridge.mergeRegistry([{ sessionId: 's1', pid: 4020, alive: true, cwd: '/a/b' }]);
  bridge.mergeRegistry([{ sessionId: 'other', pid: 99, alive: true, cwd: '/z' }]);
  assert.equal(bridge.snapshot().sessions.find(x => x.id === 's1').ended, true);
});

test('a session we never had a pid for is left alone', () => {
  const { bridge } = makeBridge();
  // Hooks reached us but the registry does not list it (an older Claude Code, a
  // different config dir). Absence there is not evidence of anything.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/b', prompt: 'go' });
  bridge.mergeRegistry([{ sessionId: 'other', pid: 99, alive: true, cwd: '/z' }]);
  assert.equal(bridge.snapshot().sessions.find(x => x.id === 's1').ended, false);
});

test('a session started before Xenon shows up, marked as not wired in', () => {
  const { bridge } = makeBridge();
  bridge.mergeRegistry([{ sessionId: 'pre', pid: 7, alive: true, cwd: 'C:/work/xenon', name: 'my-run', nameDerived: false, status: 'busy', startedAt: 5 }]);
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.project, 'xenon');
  assert.equal(s.name, 'my-run');
  assert.equal(s.state, 'running');
  // Its controls would all fail, so the widget says so rather than offering them.
  assert.equal(s.unlinked, true);
});

test('a session no hook reaches follows the registry from busy to idle and back', () => {
  const { bridge } = makeBridge();
  const row = (status) => [{ sessionId: 'pre', pid: 7, alive: true, cwd: 'C:/work/xenon', status }];
  bridge.mergeRegistry(row('idle'));
  assert.equal(bridge.snapshot().sessions[0].state, 'idle');
  bridge.mergeRegistry(row('busy'));
  assert.equal(bridge.snapshot().sessions[0].state, 'running', 'a prompt typed in the terminal is seen');
  bridge.mergeRegistry(row('idle'));
  assert.equal(bridge.snapshot().sessions[0].state, 'idle');
  bridge.mergeRegistry(row(undefined));
  assert.equal(bridge.snapshot().sessions[0].state, 'idle', 'an unknown status changes nothing');
  // Once a hook arrives from it, the hooks own its state again.
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 'pre', cwd: 'C:/work/xenon', prompt: 'go' });
  bridge.mergeRegistry(row('idle'));
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.unlinked, false);
  assert.equal(s.state, 'running');
});

test('the registry corroborates and never overrules the hook feed', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: '/a/b', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  bridge.applyHook({ hook_event_name: 'Notification', session_id: 's1', message: 'needs you' });
  // The file says 'busy'. The hooks know it is blocked on the user, which is
  // more than a coarse flag written on a timer can say.
  bridge.mergeRegistry([{ sessionId: 's1', pid: 11, alive: true, cwd: '/a/b', status: 'busy', name: 'proj-ab', nameDerived: true }]);
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'waiting');
  assert.equal(s.waitFor.text, 'needs you');
  assert.equal(s.name, '', 'a name derived from the folder is not a name the user chose');
});

test('an empty or unreadable registry changes nothing', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/a/b', prompt: 'go' });
  assert.equal(bridge.mergeRegistry([]), false);
  assert.equal(bridge.mergeRegistry(null), false);
  assert.equal(bridge.snapshot().sessions[0].ended, false);
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

// ── mod feed (integrations/claude-code) ───────────────────────────────────────

test('applyMod measure reads quota and context through the statusline path', () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.applyMod({
    v: 1, kind: 'measure', sessionId: 's1', version: '0.1.0', contextPct: 37, costUsd: 0.5,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5, resetsAt: '2026-10-09T12:00:00Z' },
      { kind: 'spend_limit', percentUsed: 99 },
    ],
  }), true);
  const snap = bridge.snapshot();
  assert.equal(snap.limits.fiveHour.pct, 23.5);
  assert.equal(snap.limits.fiveHour.resetsAt, Date.parse('2026-10-09T12:00:00Z') / 1000);
  assert.equal(snap.limits.sevenDay, null);
  const s = snap.sessions.find(x => x.id === 's1');
  assert.equal(s.contextPct, 37);
  assert.equal(s.cost, 0.5);
  assert.equal(snap.mod.version, '0.1.0');
});

test('applyMod measure without figures keeps the last known ones', () => {
  const { bridge } = makeBridge();
  bridge.applyStatus({ session_id: 's1', context_window: { used_percentage: 40 }, cost: { total_cost_usd: 2 } });
  bridge.applyMod({ v: 1, kind: 'measure', sessionId: 's1', rateLimits: [] });
  const s = bridge.snapshot().sessions.find(x => x.id === 's1');
  assert.equal(s.contextPct, 40);
  assert.equal(s.cost, 2);
});

test('applyMod agent gives a subagent its model, before or after SubagentStart', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore' });
  bridge.applyMod({ v: 1, kind: 'agent', sessionId: 's1', agentId: 'a1', type: 'Explore', model: 'claude-haiku-5-5' });
  bridge.applyMod({ v: 1, kind: 'agent', sessionId: 's1', agentId: 'a2', type: 'Plan', model: 'claude-opus-5-5' });
  bridge.applyHook({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a2', agent_type: 'Plan' });
  const agents = bridge.snapshot().sessions.find(x => x.id === 's1').subagents;
  assert.deepEqual(agents.map(a => [a.id, a.model]), [['a1', 'claude-haiku-5-5'], ['a2', 'claude-opus-5-5']]);
});

test('the last plan Claude wrote stays on the session after it was approved elsewhere', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1' });
  bridge.applyHook({ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'ExitPlanMode', tool_input: { plan: '1. Do it' } });
  let s = bridge.snapshot().sessions.find(x => x.id === 's1');
  assert.equal(s.plan, '1. Do it');
  assert.ok(s.planAt > 0);
  // A resumed session keeps it; a cleared one does not.
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', source: 'resume' });
  assert.equal(bridge.snapshot().sessions.find(x => x.id === 's1').plan, '1. Do it');
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', source: 'clear' });
  assert.equal(bridge.snapshot().sessions.find(x => x.id === 's1').plan, '');
});

test('a hello carries the model and the effort the session runs with', () => {
  const { bridge } = makeBridge();
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', model: 'claude-opus-5-5', effort: 'high' });
  let s = bridge.snapshot().sessions.find(x => x.id === 's1');
  assert.deepEqual([s.model, s.effort], ['claude-opus-5-5', 'high']);
  // No effort in a hello (not known yet) keeps what is there; a made-up level is ignored.
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', model: 'claude-sonnet-5-5' });
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', effort: 'turbo' });
  s = bridge.snapshot().sessions.find(x => x.id === 's1');
  assert.deepEqual([s.model, s.effort], ['claude-sonnet-5-5', 'high']);
});

test('applyMod refuses unknown versions, kinds and sessionless messages', () => {
  const { bridge } = makeBridge();
  assert.equal(bridge.applyMod({ v: 2, kind: 'hello', sessionId: 's1' }), false);
  assert.equal(bridge.applyMod({ v: 1, kind: 'prompt', sessionId: 's1', text: 'secret' }), false);
  assert.equal(bridge.applyMod({ v: 1, kind: 'hello' }), false);
  assert.equal(bridge.applyMod(null), false);
  assert.equal(bridge.snapshot().sessions.length, 0);
});

// ── mod approvals: short wait, then the terminal asks ────────────────────────

test('a mod approval waits only its own short window', () => {
  const { bridge } = makeBridge();
  const req = bridge.requestPermission({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } }, { ttlMs: 30_000, fromMod: true });
  assert.equal(bridge.snapshot().approvals[0].expiresInMs, 30_000);
  bridge.cancel(req.id);
});

test('after a mod approval is handed back, the hook for the same call gets no second card', () => {
  const { bridge, advance } = makeBridge();
  const call = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const req = bridge.requestPermission(call, { ttlMs: 30_000, fromMod: true });
  bridge.cancel(req.id);                          // the mod's wait ended
  assert.equal(bridge.takeHandBack(call), true);
  assert.equal(bridge.takeHandBack(call), false); // only that one call
  bridge.cancel(bridge.requestPermission(call, { fromMod: true }).id);
  advance(11_000);                                // a later call is a new question
  assert.equal(bridge.takeHandBack(call), false);
});

test('the hook withdraws a mod card still pending for the same call', () => {
  const { bridge } = makeBridge();
  const call = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  bridge.requestPermission(call, { ttlMs: 30_000, fromMod: true });
  assert.equal(bridge.takeHandBack(call), true);
  assert.equal(bridge.snapshot().approvals.length, 0);
});

test('a hook request is never mistaken for a hand back', () => {
  const { bridge } = makeBridge();
  const call = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'ls' } };
  bridge.cancel(bridge.requestPermission(call).id);
  assert.equal(bridge.takeHandBack(call), false);
});

test('Stop clears a leftover wait when no card for the session is open', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  bridge.applyHook({ hook_event_name: 'StopFailure', session_id: 's1', error: 'overloaded' });
  assert.equal(bridge.snapshot().sessions[0].waitFor.kind, 'error');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1', last_assistant_message: 'Done.' });
  const s = bridge.snapshot().sessions[0];
  assert.equal(s.state, 'idle');
  assert.equal(s.waitFor, null, 'a finished turn waits for nothing');
});

test('Stop keeps the wait while a card for that session is still pending', () => {
  const { bridge } = makeBridge();
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  const call = { session_id: 's1', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } };
  const rec = bridge.requestPermission(call);
  assert.equal(bridge.snapshot().sessions[0].waitFor.kind, 'permission');
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  assert.notEqual(bridge.snapshot().sessions[0].waitFor, null);
  bridge.cancel(rec.id);
});

test('"working for" counts from the start of the turn, not of the session', () => {
  const { bridge, advance } = makeBridge();
  bridge.applyHook({ hook_event_name: 'SessionStart', session_id: 's1', cwd: 'C:/work/xenon' });
  advance(60 * 60 * 1000);
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  advance(3000);
  assert.equal(bridge.snapshot().sessions[0].runForMs, 3000);
});

test('describeChange keeps only the lines that differ, and no body for secret files', () => {
  const c = cb.describeChange('Edit', { file_path: '/p/a.js', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree' });
  assert.equal(c.file, 'a.js');
  assert.deepEqual([c.del, c.add], [1, 1]);
  assert.deepEqual(c.lines, [{ k: '-', t: 'two' }, { k: '+', t: '2' }]);
  const w = cb.describeChange('Write', { file_path: '/p/new.txt', content: 'a\nb' });
  assert.equal(w.add, 2);
  const secret = cb.describeChange('Edit', { file_path: '/p/.env', old_string: 'K=1', new_string: 'K=2' });
  assert.deepEqual(secret.lines, []);
  assert.equal(secret.add, 1);
  assert.equal(cb.describeChange('Bash', { command: 'ls' }), null);
  assert.equal(cb.describeChange('Edit', { file_path: '/p/a', old_string: 'x', new_string: 'x' }), null);
});

test('the header commands go to an idle session as commands, and not at all to a busy one', () => {
  const { bridge, listening } = makeTerminalBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  listening.add('s1');
  // A mod older than 0.4.0 would submit "/effort high" as a message: refused.
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', version: '0.3.0' });
  assert.equal(bridge.queueFollowUp('s1', '/effort high').error, 'mod_old');
  assert.equal(bridge.snapshot().sessions[0].modCommands, false);
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', version: '0.4.0' });
  assert.equal(bridge.snapshot().sessions[0].modCommands, true);
  // Other "/" text is still refused: it would reach the session as a message.
  assert.equal(bridge.queueFollowUp('s1', '/clear').error, 'slash_command');
  assert.equal(bridge.queueFollowUp('s1', '/model opus; rm -rf').error, 'slash_command');

  assert.deepEqual(bridge.queueFollowUp('s1', '/model opus'), { ok: true, via: 'terminal' });
  assert.equal(bridge.takeForTerminal('s1'), '/model opus');
  // No turn follows a command, so it is never "on its way" nor offered back.
  assert.equal(bridge.snapshot().sessions[0].queued, null);
  assert.equal(bridge.snapshot().sessions[0].undelivered, null);
  assert.deepEqual(bridge.queueFollowUp('s1', '/compact'), { ok: true, via: 'terminal' });

  bridge.takeForTerminal('s1');
  bridge.applyHook({ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'go' });
  // While a turn runs, a command waits for its end and is not a reply inside it.
  assert.deepEqual(bridge.queueFollowUp('s1', '/effort high'), { ok: true, via: 'terminal' });
  assert.equal(bridge.takeFollowUp('s1'), '');
  assert.equal(bridge.takeForTerminal('s1'), '');
  assert.equal(bridge.snapshot().sessions[0].queued.text, '/effort high');
});

test('a command the session lists runs from the tile; one it does not list, or one that ends it, does not', () => {
  const { bridge, listening } = makeTerminalBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  listening.add('s1');
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', version: '0.5.0' });
  assert.equal(bridge.commandListFor('s1'), null);
  assert.equal(bridge.queueFollowUp('s1', '/plan').error, 'slash_command', 'no list yet');

  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'commands', version: '0.5.0', commands: [
    { name: 'plan', description: 'Enable plan mode' },
    { name: 'searchfit-seo:create-topic', description: 'Topic plan' },
    { name: 'exit', description: 'Quit' },
    { name: 'bad name', description: 'x' },
  ] });
  assert.deepEqual(bridge.commandListFor('s1').map((c) => c.name), ['plan', 'searchfit-seo:create-topic']);
  assert.ok(bridge.snapshot().sessions[0].commandsAt > 0);

  assert.deepEqual(bridge.queueFollowUp('s1', '/plan'), { ok: true, via: 'terminal' });
  assert.equal(bridge.takeForTerminal('s1'), '/plan');
  assert.deepEqual(bridge.queueFollowUp('s1', '/searchfit-seo:create-topic seo for xenon'), { ok: true, via: 'terminal' });
  bridge.cancelFollowUp('s1');
  assert.equal(bridge.queueFollowUp('s1', '/exit').error, 'slash_command');
  assert.equal(bridge.queueFollowUp('s1', '/unlisted').error, 'slash_command');
});

test('a session is asked for its command list once per boot, and its mod records go with it', () => {
  const { bridge, advance } = makeBridge();
  bridge.applyMod({ v: 1, sessionId: 'm1', kind: 'hello', version: '0.6.2' });
  assert.equal(bridge.wantsCommandList('m1'), true);
  assert.equal(bridge.wantsCommandList('m1'), false, 'an empty or missing list is not asked for again');
  bridge.applyMod({ v: 1, sessionId: 'm2', kind: 'commands', version: '0.6.2', commands: [{ name: 'plan', description: 'x' }] });
  assert.equal(bridge.wantsCommandList('m2'), false, 'a session that sent its list is never asked');
  advance(3 * 60 * 60 * 1000);
  bridge.snapshot();
  assert.equal(bridge.commandListFor('m2'), null, 'dropped with the stale session');
  assert.equal(bridge.wantsCommandList('m1'), true, 'a session back after that is asked again');
});

test('/model and /effort without a value are refused, not sent as a message', () => {
  const { bridge, listening } = makeTerminalBridge();
  bridge.applyHook({ hook_event_name: 'Stop', session_id: 's1' });
  listening.add('s1');
  bridge.applyMod({ v: 1, sessionId: 's1', kind: 'hello', version: '0.6.2' });
  assert.equal(bridge.queueFollowUp('s1', '/model').error, 'needs_value');
  assert.equal(bridge.queueFollowUp('s1', '/effort ').error, 'needs_value');
});
