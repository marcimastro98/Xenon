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
const claudeRun = require('./claude-run');

const {
  PROVIDERS, TIMEOUT_MS, TOOL_TIMEOUT_MS, STATUS_TIMEOUT_MS, STATUS_TTL_MS, MODELS_TTL_MS,
  MAX_ACTIVE, CLAUDE_MODELS, isCliProvider, sanitizeModel,
} = require('./ai/cli-limits.js');


// ── locating the programs ───────────────────────────────────────────────────
let codexCache = null;
const { asLaunch, isFile, newestCodexCopy } = require('./ai/cli-find-codex.js');
async function resolveCodex() {
  // A cached copy inside an app or extension folder disappears when that
  // updates, so the cache is re-checked rather than trusted.
  if (codexCache && (codexCache.pre.length || await isFile(codexCache.cmd))) return codexCache;
  codexCache = null;
  const win = process.platform === 'win32';
  for (const hit of await claudeRun.whichRaw('codex')) {
    const low = hit.toLowerCase();
    if (win ? low.endsWith('.exe') : !low.endsWith('.cmd') && !low.endsWith('.ps1')) {
      return (codexCache = win ? { cmd: hit, pre: [] } : await asLaunch(hit));
    }
    // npm's Windows shim needs a shell; run the package's entry under node
    // instead, like claude-run.js does for Claude Code.
    const js = path.join(path.dirname(hit), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (await isFile(js)) return (codexCache = { cmd: process.execPath, pre: [js] });
  }
  const copy = await newestCodexCopy();
  return copy ? (codexCache = win ? { cmd: copy, pre: [] } : await asLaunch(copy)) : null;
}
function resolveExe(provider) {
  return provider === 'claudecode' ? claudeRun.resolveExecutable() : resolveCodex();
}

const { childEnv, run, UNKNOWN_FLAG_RE, runWithOptional } = require('./ai/cli-run.js');

// An empty folder of our own: no project files, no CLAUDE.md or AGENTS.md for
// the program to pick up, nothing of the user's for it to wander into.
//
// Created once per run of the server with mkdtemp (a random name, mode 0700),
// never a fixed name in the shared temp folder: on a machine with several
// users another one could create /tmp/xenon-ai-cli first and plant a
// CLAUDE.md, AGENTS.md or .claude/settings.json the assistant would obey, or
// read the pictures attached to a question.
let _workDir = null;
async function workDir() {
  if (_workDir) {
    try { if ((await fsp.stat(_workDir)).isDirectory()) return _workDir; } catch { /* removed: make another */ }
  }
  _workDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xenon-ai-cli-'));
  try { await fsp.chmod(_workDir, 0o700); } catch { /* Windows: the user's own temp folder */ }
  return _workDir;
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
const {
  parseClaudeInit, why, parseClaudeAuth, parseCodexLogin, parseCodexModels,
} = require('./ai/cli-status-text.js');

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

// The plan's small model, for automatic work that should use as little of the
// plan's allowance as possible: Haiku on Claude Code, the newest model Codex
// describes as light (it lists newest first), else the program's own default.
async function lightModel(provider) {
  if (provider === 'claudecode') return 'haiku';
  if (provider !== 'codex') return 'default';
  const hit = (await models('codex').catch(() => [])).find((m) => m.light);
  return hit ? hit.id : 'default';
}

const {
  latestImages, claudeImageInput, writeCodexImages, buildPrompt,
} = require('./ai/cli-prompt.js');

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
const {
  toolSessions, openToolSession, handleMcp, geminiToolsToMcp,
} = require('./ai/cli-mcp-tools.js');
function bridgeEnv(token) { return { XENON_MCP_URL: mcpUrl, XENON_MCP_TOKEN: token }; }

const { CliError, parseClaude, parseCodex } = require('./ai/cli-answers.js');

// Hooks off and CLAUDE.md ignored, whichever way it runs. Without tools the
// program's safe mode does all of it; with tools it cannot be used, because
// safe mode also drops the MCP servers passed on the command line (measured on
// 2.1.282), so the same is asked for piece by piece: `disableAllHooks` keeps
// the user's own hooks quiet (Xenon installs some of its own for the Claude
// tile, and one of them waits for a touchscreen approval), `claudeMdExcludes`
// keeps their CLAUDE.md out of Xenon's chat, and skills and every other MCP
// server stay out too.
const CLAUDE_QUIET = JSON.stringify({ disableAllHooks: true, claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md'] });
function claudeArgs(systemText, model, skip, token, withImages = false) {
  // Images only ride on the stream-json input, which wants stream-json out.
  const a = withImages
    ? ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--tools', '']
    : ['-p', '--output-format', 'json', '--tools', ''];
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

// Codex's tool switches are config keys, not flags: an unknown one is a warning
// there (a `--disable` of an unknown feature is a hard error), so an older or
// newer Codex that renamed one still runs, just with that switch ignored.
const CODEX_OFF = Object.freeze(['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'computer_use', 'image_generation', 'hooks']);
function codexArgs(systemText, model, dir, skip, token, imageFiles = [], effort = '') {
  // --image takes a list, so it goes first and a flag ends it before the prompt.
  const a = ['exec'];
  for (const f of imageFiles) a.push('--image', f);
  a.push('--json', '--skip-git-repo-check', '--sandbox', 'read-only', '-C', dir);
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
  if (effort === 'low') a.push('-c', 'model_reasoning_effort="low"');
  a.push('-');   // the prompt comes on stdin
  return a;
}

let active = 0;
// `tools` (Gemini-style declarations) + `executeTool` give the model Xenon's
// tools for this turn; without them it is a plain answer, as for a summary.
// `effort: 'low'` keeps Codex's reasoning short, for small automatic jobs.
async function chat({ provider, model, systemText, history, tools, executeTool, signal = null, effort = '' }) {
  if (!isCliProvider(provider)) throw new CliError('cli_bad_provider');
  const images = latestImages(history);
  const prompt = buildPrompt(history, new Set(images.map((i) => i.part)));
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
  let imageFiles = [];
  try {
    const m = sanitizeModel(model);
    const sys = String(systemText || '');
    const dir = await workDir();
    if (provider === 'codex' && images.length) imageFiles = await writeCodexImages(dir, images);
    const withImages = provider === 'claudecode' && images.length > 0;
    const opts = { input: withImages ? claudeImageInput(prompt, images) : prompt, env: childEnv(provider), cwd: dir, timeoutMs: token ? TOOL_TIMEOUT_MS : TIMEOUT_MS, abortOn: provider === 'codex' ? /waiting for network/i : null, signal };
    const r = provider === 'claudecode'
      ? await runWithOptional(exe, (skip) => claudeArgs(sys, m, skip, token, withImages), ['--safe-mode', '--no-session-persistence', '--permission-prompts', '--disable-slash-commands'], opts)
      : await runWithOptional(exe, (skip) => codexArgs(sys, m, dir, skip, token, imageFiles, effort), ['--ephemeral', '--ignore-user-config', '--ignore-rules'], opts);
    if (r.cancelled) throw new CliError('cli_cancelled');
    if (r.timedOut) throw new CliError('cli_timeout');
    if (r.aborted) throw new CliError('cli_offline');
    const out = provider === 'claudecode' ? parseClaude(r) : parseCodex(r);
    const clientActions = token ? toolSessions.get(token).clientActions.slice() : [];
    return { text: out.text, model: out.model, usage: out.usage, clientActions, newContent: { role: 'model', parts: [{ text: out.text }] } };
  } finally {
    if (token) toolSessions.delete(token);
    for (const f of imageFiles) fsp.unlink(f).catch(() => { /* already gone */ });
    active--;
  }
}

// Settings, "Build widgets with Claude Code / Codex": registers the xenon-mcp
// bridge in the program's own user config, exactly what the person would type
// (`claude mcp add` / `codex mcp add`). argv only, never a shell. The name is
// not "xenon": that one is Bit's own per-turn server, and a user-level entry
// with the same name could stand in for it.
const MCP_SERVER_NAME = 'xenon-widgets';
function mcpAddArgs(provider, launch) {
  const tail = ['--'].concat(launch.map(String));
  return provider === 'claudecode'
    ? ['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME].concat(tail)
    : ['mcp', 'add', MCP_SERVER_NAME].concat(tail);
}
async function addMcpServer(provider, launch) {
  if (!isCliProvider(provider)) return { ok: false, error: 'bad_provider' };
  if (!Array.isArray(launch) || !launch.length) return { ok: false, error: 'bad_launch' };
  const exe = await resolveExe(provider);
  if (!exe) return { ok: false, error: 'not_installed' };
  const r = await run(exe, mcpAddArgs(provider, launch), { timeoutMs: STATUS_TIMEOUT_MS, env: childEnv(provider), cwd: await workDir() });
  if (r.code === 0) return { ok: true };
  if (/already exists/i.test(r.stderr + r.stdout)) return { ok: true, already: true };
  return { ok: false, error: r.timedOut ? 'timeout' : 'failed' };
}

// `onUsage(totalTokens, { input, output })`, when given, hears what the run used.
async function oneShot({ provider, model, systemText, userText, effort, onUsage }) {
  const r = await chat({ provider, model, systemText, effort, history: [{ role: 'user', parts: [{ text: String(userText || '') }] }] });
  const u = r.usage;
  if (typeof onUsage === 'function' && u && (u.input + u.output) > 0) onUsage(u.input + u.output, u);
  return r.text;
}

module.exports = {
  PROVIDERS, CLAUDE_MODELS, TIMEOUT_MS,
  isCliProvider, sanitizeModel, status, models, lightModel, chat, oneShot, CliError,
  resolveCodex, childEnv, workDir,
  configure, handleMcp, addMcpServer, MCP_SERVER_NAME,
  // exposed for unit tests
  _internal: { run, buildPrompt, latestImages, claudeImageInput, claudeArgs, codexArgs, parseClaude, parseCodex, parseClaudeAuth, parseClaudeInit, parseCodexLogin, parseCodexModels, statusCache, childEnv, runWithOptional, UNKNOWN_FLAG_RE, geminiToolsToMcp, openToolSession, toolSessions, BRIDGE, mcpAddArgs },
};
