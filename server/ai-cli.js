'use strict';
// ── Xenon AI — subscription providers (Claude Code, Codex) ──────────────────
// Lets Xenon AI answer through the user's own Claude or ChatGPT subscription
// instead of an API key, by running the OFFICIAL command-line apps the user
// installed and signed in to themselves: `claude` (Claude Code) and `codex`
// (OpenAI Codex).
//
// Why the programs and not the accounts. Anthropic does not let a third-party
// app offer Claude.ai sign-in, read a Claude.ai token, or route requests
// through a Free/Pro/Max plan on a user's behalf; what it does allow is a user
// signing in to the unmodified Claude Code binary with their own subscription
// (code.claude.com/docs/en/legal-and-compliance, "Authentication and credential
// use"). OpenAI is more permissive, but the same shape is the clean one for
// both. So this module:
//
//  - NEVER touches a credential. It does not read, copy or forward a token;
//    sign-in happens in the program, through its maker's own flow.
//  - NEVER modifies or wraps the program in a way it does not support: it is
//    run as published, with documented flags.
//  - NEVER a shell. argv arrays only, the prompt goes in on stdin, so nothing
//    the user types can become syntax (same invariant as claude-run.js).
//  - NEVER the program's own tools. Claude Code runs with `--tools ""`, Codex
//    with its shell tools switched off, both in an empty scratch folder. What
//    they get instead is XENON's tools, the same ones every other provider
//    has, over MCP: ai-mcp-bridge.js, started by the program for one turn and
//    forwarding each call back here with a token that dies with the turn.
//  - NEVER an API key by accident. The key variables are removed from the
//    child's environment: someone who picked "use my subscription" must not be
//    billed per token because ANTHROPIC_API_KEY happened to be set.
//
// Only what the user starts goes through here (a chat turn, a search, a button).
// Automatic background calls stay off these providers: a subscription's limits
// assume ordinary, individual use, and they are the same limits the user
// codes against.
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const { spawn } = require('child_process');
const crypto = require('crypto');
const claudeRun = require('./claude-run');

const PROVIDERS = Object.freeze(['claudecode', 'codex']);
const TIMEOUT_MS = 180000;          // a long reasoning answer, not a hung child
const TOOL_TIMEOUT_MS = 300000;     // a turn that may call several dashboard tools
const STATUS_TIMEOUT_MS = 30000;  // a first start on Windows can take a while
const STATUS_TTL_MS = 30000;
const MODELS_TTL_MS = 60 * 60 * 1000;   // Settings asks for a fresh list whenever it opens
const MAX_ACTIVE = 2;               // concurrent turns; the quota is shared and finite
const MAX_PROMPT_CHARS = 60000;     // history is trimmed from the oldest turn
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

// Claude Code's own aliases (claude --help: "an alias for the latest model").
// The subscription decides which ones the account may use; the program answers
// with a clear error for one it may not, and that error reaches the chat.
const CLAUDE_MODELS = Object.freeze([
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]);

function isCliProvider(p) { return PROVIDERS.includes(p); }

// 'default' = let the program choose (its own default, or the user's). Anything
// else is a model name: letters first, so it can never be read as a flag.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
function sanitizeModel(v) {
  const s = String(v == null ? '' : v).trim();
  return s && s !== 'default' && MODEL_RE.test(s) ? s : 'default';
}

// ── locating the programs ───────────────────────────────────────────────────
let codexCache = null;
async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}
// Where Codex keeps its own copy when it was not installed as a terminal
// command: the desktop app (Windows: %LOCALAPPDATA%/OpenAI/Codex/bin/<hash>/)
// and the ChatGPT extension for VS Code / Cursor (bin/<platform>/). Each is the
// full `codex` program, signed in with the same account. Newest file wins, so
// an app or extension update is followed without restarting Xenon.
async function newestCodexCopy() {
  const win = process.platform === 'win32';
  const exe = win ? 'codex.exe' : 'codex';
  const home = os.homedir();
  const found = [];
  const scan = async (dir, depth) => {
    let items;
    try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isFile() && it.name.toLowerCase() === exe) {
        try { found.push({ full, t: (await fsp.stat(full)).mtimeMs }); } catch { /* gone */ }
      } else if (it.isDirectory() && depth > 0) await scan(full, depth - 1);
    }
  };
  if (win && process.env.LOCALAPPDATA) await scan(path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin'), 1);
  for (const editor of ['.vscode', '.vscode-insiders', '.cursor']) {
    const ext = path.join(home, editor, 'extensions');
    let names = [];
    try { names = (await fsp.readdir(ext)).filter((n) => /^openai\.chatgpt-/i.test(n)); } catch { /* no editor */ }
    for (const n of names) await scan(path.join(ext, n, 'bin'), 1);
  }
  found.sort((a, b) => b.t - a.t);
  return found.length ? found[0].full : null;
}
async function resolveCodex() {
  // A cached copy inside an app or extension folder disappears when that
  // updates, so the cache is re-checked rather than trusted.
  if (codexCache && (codexCache.pre.length || await isFile(codexCache.cmd))) return codexCache;
  codexCache = null;
  const win = process.platform === 'win32';
  for (const hit of await claudeRun.whichRaw('codex')) {
    const low = hit.toLowerCase();
    if (win ? low.endsWith('.exe') : !low.endsWith('.cmd') && !low.endsWith('.ps1')) {
      return (codexCache = { cmd: hit, pre: [] });
    }
    // npm's Windows shim needs a shell; run the package's entry under node
    // instead, like claude-run.js does for Claude Code.
    const js = path.join(path.dirname(hit), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await isFile(js)) return (codexCache = { cmd: process.execPath, pre: [js] });
  }
  const copy = await newestCodexCopy();
  return copy ? (codexCache = { cmd: copy, pre: [] }) : null;
}
function resolveExe(provider) {
  return provider === 'claudecode' ? claudeRun.resolveExecutable() : resolveCodex();
}

// The child sees the user's environment minus anything that would switch it
// from the subscription to per-token billing.
const STRIP_ENV = Object.freeze({
  claudecode: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
});
function childEnv(provider) {
  const env = Object.assign({}, process.env);
  for (const k of STRIP_ENV[provider] || []) delete env[k];
  return env;
}

// An empty folder of our own: no project files, no CLAUDE.md or AGENTS.md for
// the program to pick up, nothing of the user's for it to wander into.
async function workDir() {
  const dir = path.join(os.tmpdir(), 'xenon-ai-cli');
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// `abortOn`: a pattern in the output that means waiting longer is pointless.
// Codex, offline, retries "waiting for network" for as long as it is let.
function run(exe, args, { input = '', timeoutMs = TIMEOUT_MS, env, cwd, abortOn = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe.cmd, exe.pre.concat(args), { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e && e.message) || e), timedOut: false });
      return;
    }
    let stdout = '', stderr = '', timedOut = false, aborted = false, done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, aborted }); };
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_STDOUT) stdout += d;
      if (abortOn && !aborted && abortOn.test(String(d))) { aborted = true; try { child.kill(); } catch { /* gone */ } }
    });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_STDERR) stderr += d; });
    child.on('error', (e) => { stderr += String((e && e.message) || e); finish(-1); });
    child.on('close', (code) => finish(code));
    child.stdin.on('error', () => { /* child exited before reading: reported via close */ });
    child.stdin.end(input);
  });
}

// Flags a program version may not know yet. When it says so, the flag is
// dropped and the call tried again, rather than the whole provider failing on
// a program one release older than this code. Only flags that are about tidiness
// are optional; the ones that keep tools off are not.
const UNKNOWN_FLAG_RE = /(?:unknown option|unexpected argument)\s+'(--[a-z0-9-]+)/i;
async function runWithOptional(exe, build, optional, opts) {
  const skip = new Set();
  for (let i = 0; i <= optional.length; i++) {
    const r = await run(exe, build(skip), opts);
    const m = r.code !== 0 && UNKNOWN_FLAG_RE.exec(r.stderr);
    if (m && optional.includes(m[1]) && !skip.has(m[1])) { skip.add(m[1]); continue; }
    return r;
  }
  return run(exe, build(skip), opts);
}

// ── status and models ───────────────────────────────────────────────────────
// Claude Code answers both through the control protocol of its stream-json
// mode, the one Anthropic's own Agent SDK speaks: an `initialize` request gets
// back, among other things, the models this account can use today (with the
// exact model each one currently resolves to) and the account's plan. No user
// message is sent, so no model is called and no quota is spent; the program
// exits when its input closes. It is the same list its own /model picker
// shows, so it moves when Anthropic ships a model, with no change here.
const INIT_TIMEOUT_MS = 45000;      // a cold start on Windows is slow; this is not on the chat path
const initCache = { at: 0, value: null };
async function claudeInit({ fresh = false } = {}) {
  if (!fresh && initCache.value && Date.now() - initCache.at < MODELS_TTL_MS) return initCache.value;
  const exe = await claudeRun.resolveExecutable();
  if (!exe) return null;
  const req = JSON.stringify({ type: 'control_request', request_id: 'xenon-init', request: { subtype: 'initialize' } }) + '\n';
  const r = await runWithOptional(exe, (skip) => {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', ''];
    for (const f of ['--safe-mode', '--no-session-persistence']) if (!skip.has(f)) a.push(f);
    return a;
  }, ['--safe-mode', '--no-session-persistence'], { input: req, env: childEnv('claudecode'), cwd: await workDir(), timeoutMs: INIT_TIMEOUT_MS });
  const value = parseClaudeInit(r.stdout);
  if (value) { initCache.at = Date.now(); initCache.value = value; }
  return value;
}
function versionOf(desc) {
  const head = String(desc || '').split(' · ')[0].trim();
  return /^[A-Za-z][A-Za-z-]*(?: [A-Za-z-]+)? \d+(?:\.\d+)*$/.test(head) ? head.slice(0, 40) : '';
}
// The `initialize` control_response: models [{ value, displayName,
// description: "Opus 5.5 · Best for …", resolvedModel }], account { … }.
function parseClaudeInit(out) {
  for (const line of String(out || '').split(/\r?\n/)) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.type !== 'control_response' || !j.response || j.response.subtype !== 'success') continue;
    const r = j.response.response || {};
    const models = (Array.isArray(r.models) ? r.models : [])
      .filter((m) => m && typeof m.value === 'string' && (m.value === 'default' || MODEL_RE.test(m.value)))
      .map((m) => {
        const desc = typeof m.description === 'string' ? m.description : '';
        return {
          id: m.value,
          label: String(m.displayName || m.value).slice(0, 60),
          // "Opus 5.5" out of "Opus 5.5 · Best for everyday, complex tasks".
          // Only when it has a model name's shape: on some plans the name
          // already carries the version and the description is just an English
          // sentence ("Most capable for ambitious work"), which is not one.
          version: versionOf(desc),
          resolved: typeof m.resolvedModel === 'string' ? m.resolvedModel.slice(0, 80) : '',
        };
      })
      .slice(0, 40);
    const acct = r.account && typeof r.account === 'object' ? r.account : null;
    const plan = acct && typeof acct.subscriptionType === 'string' ? acct.subscriptionType.slice(0, 40) : '';
    return { models, plan, hasAccount: !!acct && Object.keys(acct).length > 0 };
  }
  return null;
}

// Why a status came back unknown, in the program's own words where it gave
// any: shown under the status so a problem on someone's PC can be told apart
// from another (a timeout, an older program, an error it printed).
function why(r, label) {
  if (!r) return label + ': no answer';
  if (r.timedOut) return label + ': timed out';
  const tail = (String(r.stderr || '').trim() || String(r.stdout || '').trim()).split(/\r?\n/).slice(-2).join(' ').slice(0, 200);
  return label + ': exit ' + r.code + (tail ? ' · ' + tail : '');
}

const statusCache = new Map();   // provider → { at, value }
async function status(provider, { fresh = false } = {}) {
  if (!isCliProvider(provider)) return { provider, installed: false, loggedIn: false };
  const hit = statusCache.get(provider);
  if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const exe = await resolveExe(provider);
  let value;
  if (!exe) {
    value = { provider, installed: false, loggedIn: false };
  } else {
    const opts = { env: childEnv(provider), timeoutMs: STATUS_TIMEOUT_MS, cwd: await workDir() };
    // In parallel: a cold start is the slow part, and it is paid once.
    const [ver, auth, init] = await Promise.all([
      run(exe, ['--version'], opts),
      run(exe, provider === 'claudecode' ? ['auth', 'status'] : ['login', 'status'], opts),
      provider === 'claudecode' ? claudeInit({ fresh }) : Promise.resolve(null),
    ]);
    const version = (String(ver.stdout).match(/\d+\.\d+\.\d+/) || [''])[0];
    const login = provider === 'claudecode' ? parseClaudeAuth(auth.stdout) : parseCodexLogin(auth);
    value = { provider, installed: true, version, loggedIn: login.loggedIn, method: login.method, plan: (init && init.plan) || '' };
    // An older Claude Code without `auth status`: an account in the
    // initialize answer is proof enough that it is signed in.
    if (value.loggedIn === null && init && init.hasAccount) value.loggedIn = true;
    if (value.loggedIn === null) value.detail = [!version ? why(ver, '--version') : '', why(auth, provider === 'claudecode' ? 'auth status' : 'login status')].filter(Boolean).join(' | ');
  }
  statusCache.set(provider, { at: Date.now(), value });
  return value;
}
// `claude auth status` prints JSON: { loggedIn, authMethod, ... }. Anything
// around it (an update notice, a warning) is tolerated: the object is taken
// from the first "{" to the last "}".
function parseClaudeAuth(out) {
  const text = String(out || '');
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  try {
    if (a < 0 || b <= a) throw new Error('no json');
    const j = JSON.parse(text.slice(a, b + 1));
    if (typeof j.loggedIn !== 'boolean') throw new Error('no loggedIn');
    return { loggedIn: j.loggedIn, method: typeof j.authMethod === 'string' ? j.authMethod.slice(0, 40) : '' };
  } catch { return { loggedIn: null, method: '' }; }
}
// `codex login status` prints a sentence and exits 0 either way, so the words
// are the answer: "Logged in using ChatGPT", "... an API key", "Not logged in".
function parseCodexLogin(r) {
  const text = String((r && r.stdout) || '') + '\n' + String((r && r.stderr) || '');
  if (/not logged in/i.test(text)) return { loggedIn: false, method: '' };
  if (/logged in using chatgpt/i.test(text)) return { loggedIn: true, method: 'chatgpt' };
  if (/logged in using an api key/i.test(text)) return { loggedIn: true, method: 'apikey' };
  if (/logged in/i.test(text)) return { loggedIn: true, method: '' };
  return { loggedIn: null, method: '' };
}

// The models the program offers this account today. Claude Code: its own
// list, from `initialize` above. Codex: its own catalog, `codex debug models`
// (the ones it marks `visibility: "list"` are the ones its picker shows).
// Only if the program cannot be asked does Claude Code fall back to its
// family aliases, which it resolves to the newest model of each family.
let codexModels = { at: 0, list: null };
async function models(provider, { fresh = false } = {}) {
  if (provider === 'claudecode') {
    const init = await claudeInit({ fresh }).catch(() => null);
    return init && init.models.length ? init.models : CLAUDE_MODELS.map((m) => Object.assign({ version: '', resolved: '' }, m));
  }
  if (provider !== 'codex') return [];
  if (!fresh && codexModels.list && Date.now() - codexModels.at < MODELS_TTL_MS) return codexModels.list;
  const exe = await resolveCodex();
  if (!exe) return [];
  const r = await run(exe, ['debug', 'models'], { env: childEnv('codex'), timeoutMs: 30000, cwd: await workDir() });
  const list = parseCodexModels(r.stdout);
  if (list.length) codexModels = { at: Date.now(), list };
  return list;
}
function parseCodexModels(out) {
  let j;
  try { j = JSON.parse(String(out || '')); } catch { return []; }
  const arr = j && Array.isArray(j.models) ? j.models : [];
  return arr
    .filter((m) => m && typeof m.slug === 'string' && MODEL_RE.test(m.slug) && m.visibility === 'list')
    .map((m) => ({ id: m.slug, label: String(m.display_name || m.slug).slice(0, 60) }))
    .slice(0, 40);
}

// ── the conversation as one prompt ──────────────────────────────────────────
// Each turn is a fresh run of the program with nothing saved, so the thread so
// far travels in the prompt. Xenon's history is Gemini-shaped; only the words
// are carried, and an attachment is named rather than silently dropped.
function partText(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.text === 'string') return p.text;
  if (p.inlineData) return /^image\//.test(String(p.inlineData.mimeType || '')) ? '[an image was attached, which this assistant cannot see]' : '[an attachment was included, which this assistant cannot read]';
  return '';
}
function buildPrompt(history) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((m) => m && Array.isArray(m.parts))
    .map((m) => ({ role: m.role === 'model' ? 'Assistant' : 'User', text: m.parts.map(partText).filter(Boolean).join('\n').trim() }))
    .filter((t) => t.text);
  if (!turns.length) return '';
  const last = turns[turns.length - 1];
  const earlier = turns.slice(0, -1);
  if (!earlier.length) return last.text.slice(0, MAX_PROMPT_CHARS);
  const head = 'Earlier in this conversation (for context only):\n\n';
  const tail = '\n\n---\nThe user\'s new message:\n' + last.text;
  const budget = MAX_PROMPT_CHARS - head.length - tail.length;
  const lines = [];
  let used = 0;
  for (let i = earlier.length - 1; i >= 0; i--) {    // newest first, oldest dropped
    const line = earlier[i].role + ': ' + earlier[i].text;
    if (used + line.length + 2 > budget) break;
    lines.unshift(line); used += line.length + 2;
  }
  return lines.length ? head + lines.join('\n\n') + tail : last.text.slice(0, MAX_PROMPT_CHARS);
}

// ── Xenon's tools, over MCP ─────────────────────────────────────────────────
// A session lives for exactly one turn: minted before the program starts,
// dropped when it exits. The bridge proves which turn it belongs to with the
// token; there is no other way in, and a call for a tool the turn was not
// given is refused here whatever the program asks for.
const BRIDGE = path.join(__dirname, 'ai-mcp-bridge.js');
let mcpUrl = '';
function configure(opts) {
  if (opts && typeof opts.port === 'number') mcpUrl = 'http://127.0.0.1:' + opts.port + '/api/ai/cli/mcp';
}
const toolSessions = new Map();   // token → { tools, names, executeTool, clientActions }
function openToolSession(tools, executeTool) {
  const token = crypto.randomBytes(24).toString('hex');
  toolSessions.set(token, {
    tools, names: new Set(tools.map((t) => t.name)), executeTool, clientActions: [],
  });
  return token;
}
async function handleMcp(token, body) {
  const sess = typeof token === 'string' && token ? toolSessions.get(token) : null;
  if (!sess) return { status: 403, body: { error: 'unknown_session' } };
  const op = body && body.op;
  if (op === 'list') return { status: 200, body: { tools: sess.tools } };
  if (op !== 'call') return { status: 400, body: { error: 'bad_op' } };
  const name = typeof body.name === 'string' ? body.name : '';
  if (!sess.names.has(name)) return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_tool' }) }], isError: true } };
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  try {
    const r = (await sess.executeTool(name, args)) || {};
    for (const a of r.clientActions || []) sess.clientActions.push(a);
    const content = [{ type: 'text', text: JSON.stringify(r.fnResult === undefined ? { ok: true } : r.fnResult) }];
    // capture_screen hands back a JPEG; both programs show MCP images to the model.
    if (typeof r.pendingScreenImage === 'string' && r.pendingScreenImage) content.push({ type: 'image', data: r.pendingScreenImage, mimeType: 'image/jpeg' });
    return { status: 200, body: { content } };
  } catch (e) {
    return { status: 200, body: { content: [{ type: 'text', text: JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }) }], isError: true } };
  }
}
// Gemini-style declarations (what server.js builds) → MCP tools. Same schema
// rewrite the Anthropic provider does: lowercase types, recursive.
const TYPE_MAP = { OBJECT: 'object', STRING: 'string', NUMBER: 'number', INTEGER: 'integer', BOOLEAN: 'boolean', ARRAY: 'array' };
function toJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') return { type: 'object', properties: {} };
  const out = {};
  if (schema.type) out.type = TYPE_MAP[schema.type] || String(schema.type).toLowerCase();
  if (schema.description) out.description = schema.description;
  if (Array.isArray(schema.enum)) out.enum = schema.enum.slice();
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = toJsonSchema(v);
  }
  if (Array.isArray(schema.required)) out.required = schema.required.slice();
  if (schema.items) out.items = toJsonSchema(schema.items);
  if (out.type === 'object' && !out.properties) out.properties = {};
  return out;
}
function geminiToolsToMcp(fns) {
  return (Array.isArray(fns) ? fns : [])
    .filter((f) => f && typeof f.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f.name))
    .map((f) => ({ name: f.name, description: String(f.description || ''), inputSchema: toJsonSchema(f.parameters || { type: 'OBJECT', properties: {} }) }));
}
function bridgeEnv(token) { return { XENON_MCP_URL: mcpUrl, XENON_MCP_TOKEN: token }; }

// ── one turn ────────────────────────────────────────────────────────────────
class CliError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
const NOT_LOGGED_RE = /not logged in|please run \/login|log ?in (?:first|required)|invalid api key|unauthori[sz]ed|authentication/i;

// Hooks off and CLAUDE.md ignored, whichever way it runs. Without tools the
// program's safe mode does all of it; with tools it cannot be used, because
// safe mode also drops the MCP servers passed on the command line (measured on
// 2.1.282), so the same is asked for piece by piece: `disableAllHooks` keeps
// the user's own hooks quiet (Xenon installs some of its own for the Claude
// tile, and one of them waits for a touchscreen approval), `claudeMdExcludes`
// keeps their CLAUDE.md out of Xenon's chat, and skills and every other MCP
// server stay out too.
const CLAUDE_QUIET = JSON.stringify({ disableAllHooks: true, claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md'] });
function claudeArgs(systemText, model, skip, token) {
  const a = ['-p', '--output-format', 'json', '--tools', ''];
  if (!token && !skip.has('--safe-mode')) a.push('--safe-mode');
  if (!skip.has('--no-session-persistence')) a.push('--no-session-persistence');
  if (!skip.has('--permission-prompts')) a.push('--permission-prompts', 'none');
  if (token) {
    const mcp = { mcpServers: { xenon: { type: 'stdio', command: process.execPath, args: [BRIDGE], env: bridgeEnv(token) } } };
    a.push('--settings', CLAUDE_QUIET);
    if (!skip.has('--disable-slash-commands')) a.push('--disable-slash-commands');
    // Xenon's server and nothing else; its tools pre-approved, since a print
    // run has nobody to ask and each tool already carries its own checks.
    a.push('--strict-mcp-config', '--mcp-config', JSON.stringify(mcp), '--allowedTools', 'mcp__xenon');
  }
  if (systemText) a.push('--system-prompt', systemText);
  if (model !== 'default') a.push('--model', model);
  return a;
}
function parseClaude(r) {
  let j = null;
  const lines = String(r.stdout || '').trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0 && !j; i--) { try { j = JSON.parse(lines[i]); } catch { /* not the result line */ } }
  if (j && j.type === 'result') {
    const text = typeof j.result === 'string' ? j.result.trim() : '';
    if (j.is_error || j.subtype !== 'success') throw new CliError(NOT_LOGGED_RE.test(text) ? 'cli_not_logged_in' : 'cli_failed', text || String(j.subtype || 'error'));
    const used = j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage)[0] || '' : '';
    return { text, model: used };
  }
  const why = (String(r.stderr || '').trim() || String(r.stdout || '').trim()).slice(-400);
  throw new CliError(NOT_LOGGED_RE.test(why) ? 'cli_not_logged_in' : 'cli_failed', why || 'no answer');
}

// Codex's tool switches are config keys, not flags: an unknown one is a warning
// there (a `--disable` of an unknown feature is a hard error), so an older or
// newer Codex that renamed one still runs, just with that switch ignored.
const CODEX_OFF = Object.freeze(['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'hooks']);
function codexArgs(systemText, model, dir, skip, token) {
  const a = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir];
  for (const f of ['--ephemeral', '--ignore-user-config', '--ignore-rules']) if (!skip.has(f)) a.push(f);
  // -c values are TOML; a JSON string literal is a valid TOML basic string, so
  // the instructions arrive as one string whatever they contain.
  if (systemText) a.push('-c', 'developer_instructions=' + JSON.stringify(systemText));
  for (const f of CODEX_OFF) a.push('-c', 'features.' + f + '=false');
  if (token) {
    // Xenon's tools as Codex's one MCP server (user config is ignored above, so
    // it is the only one). `approve`: an exec run has nobody to ask, and each
    // tool already carries its own checks. Unknown keys are warnings in Codex,
    // so an older one without per-server approval still starts.
    const env = bridgeEnv(token);
    a.push('-c', 'mcp_servers.xenon.command=' + JSON.stringify(process.execPath));
    a.push('-c', 'mcp_servers.xenon.args=' + JSON.stringify([BRIDGE]));
    a.push('-c', 'mcp_servers.xenon.env={' + Object.keys(env).map((k) => k + '=' + JSON.stringify(env[k])).join(',') + '}');
    a.push('-c', 'mcp_servers.xenon.startup_timeout_sec=20');
    a.push('-c', 'mcp_servers.xenon.tool_timeout_sec=150');
    a.push('-c', 'mcp_servers.xenon.default_tools_approval_mode="approve"');
    a.push('-c', 'approval_policy="never"');
  }
  if (model !== 'default') a.push('-m', model);
  a.push('-');   // the prompt comes on stdin
  return a;
}
function parseCodex(r) {
  const texts = [];
  let failed = '', lastError = '';
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    if (e.type === 'item.completed' && e.item && e.item.type === 'agent_message' && typeof e.item.text === 'string') texts.push(e.item.text);
    else if (e.type === 'turn.failed') failed = String((e.error && e.error.message) || 'turn failed');
    else if (e.type === 'error' && typeof e.message === 'string' && !/^Reconnecting/i.test(e.message)) lastError = e.message;
  }
  const text = texts.join('\n\n').trim();
  if (text && !failed) return { text, model: '' };
  const why = (failed || lastError || String(r.stderr || '').trim()).slice(-400);
  throw new CliError(NOT_LOGGED_RE.test(why) ? 'cli_not_logged_in' : 'cli_failed', why || 'no answer');
}

let active = 0;
// `tools` (Gemini-style declarations) + `executeTool` give the model Xenon's
// tools for this turn; without them it is a plain answer, as for a summary.
async function chat({ provider, model, systemText, history, tools, executeTool }) {
  if (!isCliProvider(provider)) throw new CliError('cli_bad_provider');
  const prompt = buildPrompt(history);
  if (!prompt) throw new CliError('cli_empty');
  const exe = await resolveExe(provider);
  if (!exe) throw new CliError('cli_not_installed');
  // A recent "not signed in" answers at once. Only a cached one: a cold status
  // check starts the program three times, which a chat turn must not wait for,
  // and the program itself says so anyway when it is not signed in.
  const known = statusCache.get(provider);
  if (known && Date.now() - known.at < STATUS_TTL_MS && known.value.loggedIn === false) throw new CliError('cli_not_logged_in');
  if (active >= MAX_ACTIVE) throw new CliError('cli_busy');
  active++;
  const mcpTools = (mcpUrl && typeof executeTool === 'function') ? geminiToolsToMcp(tools) : [];
  const token = mcpTools.length ? openToolSession(mcpTools, executeTool) : '';
  try {
    const m = sanitizeModel(model);
    const sys = String(systemText || '');
    const dir = await workDir();
    const opts = { input: prompt, env: childEnv(provider), cwd: dir, timeoutMs: token ? TOOL_TIMEOUT_MS : TIMEOUT_MS, abortOn: provider === 'codex' ? /waiting for network/i : null };
    const r = provider === 'claudecode'
      ? await runWithOptional(exe, (skip) => claudeArgs(sys, m, skip, token), ['--safe-mode', '--no-session-persistence', '--permission-prompts', '--disable-slash-commands'], opts)
      : await runWithOptional(exe, (skip) => codexArgs(sys, m, dir, skip, token), ['--ephemeral', '--ignore-user-config', '--ignore-rules'], opts);
    if (r.timedOut) throw new CliError('cli_timeout');
    if (r.aborted) throw new CliError('cli_offline');
    const out = provider === 'claudecode' ? parseClaude(r) : parseCodex(r);
    const clientActions = token ? toolSessions.get(token).clientActions.slice() : [];
    return { text: out.text, model: out.model, clientActions, newContent: { role: 'model', parts: [{ text: out.text }] } };
  } finally {
    if (token) toolSessions.delete(token);
    active--;
  }
}

async function oneShot({ provider, model, systemText, userText }) {
  const r = await chat({ provider, model, systemText, history: [{ role: 'user', parts: [{ text: String(userText || '') }] }] });
  return r.text;
}

module.exports = {
  PROVIDERS, CLAUDE_MODELS, TIMEOUT_MS,
  isCliProvider, sanitizeModel, status, models, chat, oneShot, CliError,
  configure, handleMcp,
  // exposed for unit tests
  _internal: { buildPrompt, claudeArgs, codexArgs, parseClaude, parseCodex, parseClaudeAuth, parseClaudeInit, parseCodexLogin, parseCodexModels, statusCache, childEnv, runWithOptional, UNKNOWN_FLAG_RE, geminiToolsToMcp, openToolSession, toolSessions, BRIDGE },
};
