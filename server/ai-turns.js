'use strict';
// The AI turn a chat is waiting for. A creation on Sonnet or Opus takes minutes:
// the chat asks how far it has got (GET /api/ai/turn) and says so, and the
// answer is kept for a while after it is sent, so a chat that reloaded or lost
// its connection on the way still gets it, and the widget it made still lands
// on the page.
//
// The turn is found through the request's async context, so the tool runner
// and the credits router mark progress without passing an id around.
//
// The chat's stop button marks the turn stopped (POST /api/ai/turn/stop): no
// tool runs and no model round starts after that. A round already on its way
// finishes, so a round on Xenon credits is never paid for nothing.

const { AsyncLocalStorage } = require('node:async_hooks');

const ID_RE = /^[A-Za-z0-9-]{16,64}$/;
const KEEP_MS = 15 * 60 * 1000;
// A turn that never answered (the process was busy elsewhere, a bug) is
// forgotten after this, so a chat never waits on it forever.
const RUNNING_MAX_MS = 30 * 60 * 1000;
const MAX_TURNS = 16;
const MAX_BODY_CHARS = 2 * 1024 * 1024;
// Tools that write something: the model rounds after them are finishing touches.
const MAKING_TOOLS = new Set(['create_widget', 'create_preset', 'create_animated_background', 'create_dashboard_style', 'configure_deck']);

const turns = new Map(); // id -> { startedAt, stage, tool, made, doneAt, status, body, stopped, ctrl, actions }
const context = new AsyncLocalStorage();
let _now = () => Date.now();

const validId = (id) => typeof id === 'string' && ID_RE.test(id);

function sweep() {
  const now = _now();
  for (const [id, t] of turns) {
    const age = t.doneAt ? now - t.doneAt : now - t.startedAt;
    if (age > (t.doneAt ? KEEP_MS : RUNNING_MAX_MS)) turns.delete(id);
  }
  while (turns.size > MAX_TURNS) turns.delete(turns.keys().next().value);
}

// Starts tracking the turn `id` answered by `res`, for the rest of this
// request's async work. An id the chat did not send (an older client) tracks nothing.
function begin(id, res) {
  if (!validId(id) || !res || typeof res.end !== 'function') return false;
  sweep();
  const turn = { startedAt: _now(), stage: 'thinking', tool: '', made: false, creating: false, doneAt: 0, status: 0, body: null, stopped: false, ctrl: new AbortController(), actions: [] };
  turns.set(id, turn);
  context.enterWith(turn);
  const end = res.end.bind(res);
  res.end = (chunk, ...rest) => {
    if (!turn.doneAt) {
      turn.doneAt = _now();
      turn.status = res.statusCode;
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
      turn.body = text.length <= MAX_BODY_CHARS ? text : null;
    }
    return end(chunk, ...rest);
  };
  return true;
}

const current = () => {
  const turn = context.getStore();
  return turn && !turn.doneAt ? turn : null;
};

function toolStart(name) {
  const turn = current();
  if (!turn) return;
  turn.stage = 'tool';
  turn.tool = String(name || '');
}

function toolEnd(name) {
  const turn = current();
  if (!turn) return;
  if (MAKING_TOOLS.has(name)) turn.made = true;
  turn.stage = turn.made ? 'refining' : (turn.creating ? 'creating' : 'thinking');
  turn.tool = '';
}

// The credits router handed the turn to the creation model.
function creating() {
  const turn = current();
  if (!turn) return;
  turn.creating = true;
  if (turn.stage === 'thinking') turn.stage = 'creating';
}

// The user stopped the turn `id`. True when it was still running.
function stop(id) {
  const turn = validId(id) ? turns.get(id) : null;
  if (!turn || turn.doneAt || turn.stopped) return false;
  turn.stopped = true;
  turn.ctrl.abort();
  return true;
}

// Called before a tool runs and before a paid round starts: a stopped turn
// ends there, with an error the /api/ai handler answers as { stopped: true }.
function checkpoint() {
  const turn = current();
  if (!turn || !turn.stopped) return;
  const e = new Error('The user stopped this turn.');
  e.code = 'turn_stopped';
  throw e;
}

// What the turn's tools asked the dashboard to do so far, kept so a stopped
// turn still hands back what it made (a widget waiting for its place).
function record(actions) {
  const turn = current();
  if (!turn || !Array.isArray(actions)) return;
  for (const a of actions) if (a && typeof a.action === 'string') turn.actions.push(a);
}

function madeSoFar() {
  const turn = current();
  return turn ? turn.actions.slice() : [];
}

// For work that can be cut at once (a CLI child process), not a paid round.
function signal() {
  const turn = current();
  return turn ? turn.ctrl.signal : null;
}

// {state:'running', stage, tool, secs} | {state:'done', status, body} | {state:'unknown'}
function status(id) {
  sweep();
  const turn = validId(id) ? turns.get(id) : null;
  if (!turn) return { state: 'unknown' };
  if (!turn.doneAt) return { state: 'running', stage: turn.stage, tool: turn.tool, secs: Math.round((_now() - turn.startedAt) / 1000) };
  if (turn.body == null) return { state: 'unknown' };
  return { state: 'done', status: turn.status, body: turn.body };
}

module.exports = {
  begin,
  toolStart,
  toolEnd,
  creating,
  stop,
  checkpoint,
  record,
  madeSoFar,
  signal,
  status,
  KEEP_MS,
  _setNow(fn) { _now = typeof fn === 'function' ? fn : () => Date.now(); },
  _reset() { turns.clear(); },
};
