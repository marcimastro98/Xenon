'use strict';
// ── Xenon for widget authors: what the MCP tools do ─────────────────────────
// The xenon-mcp bridge (packages/mcp) turns each MCP tool call into one op
// here, posted to /api/mcp/dev/call by a paired client. Files travel as the
// /sdk/install payload ({ path, data(base64) }), read from the author's folder
// by the bridge: this server never takes a path from the wire.
//
// Everything runs through the code Xenon already trusts: validateWidgetPayload
// in front of the disk, installWidgetPayload as the one writer, the share-code
// dry run for the Store's checks, scanWidgetSource for what the sandbox will
// refuse. Nothing here grants a permission: the person still approves those on
// the dashboard the first time the widget runs. Only the person's OWN widgets
// can be read, changed or shared (originExportable), never a Store download.
//
// `deps` is the slice of server.js these ops need; tests pass fakes.

const MCP_API = 1;
const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TEXT_RE = /\.(html?|m?js|css)$/i;
const SIZES = ['small', 'medium', 'wide', 'tall', 'large'];

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const fromB64 = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; } };

function payloadOf(args) {
  return { id: String((args && args.id) || '').trim(), files: Array.isArray(args && args.files) ? args.files : [] };
}

// The sandbox diagnostics read text files only, decoded from the payload.
function sourceIssues(files, deps) {
  const text = files
    .filter((f) => f && TEXT_RE.test(String(f.path || '')))
    .map((f) => ({ path: String(f.path), text: fromB64(f.data) }));
  return deps.scanWidgetSource(text);
}

// A first widget that already does the things every widget needs: says hello,
// reads a stream, fills its tile, follows the theme (a color-scheme that matches
// the dashboard, or the frame paints a white block) and uses addEventListener
// (inline code never runs in the sandbox).
function templateFiles({ name, size }) {
  const manifest = {
    api: 1,
    name,
    version: '1.0.0',
    description: 'CPU and memory, live.',
    size,
    streams: ['system'],
    actions: [],
  };
  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <link rel="stylesheet" href="style.css">',
    '  <script src="main.js" defer></script>',
    '</head>',
    '<body>',
    '  <main id="root">',
    '    <div class="row"><span class="label">CPU</span><span id="cpu" class="value">--</span></div>',
    '    <div class="row"><span class="label">Memory</span><span id="mem" class="value">--</span></div>',
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
  const css = [
    ':root { color-scheme: dark; --text: #f0f3f1; --muted: #a6b1ad; }',
    'html, body { margin: 0; height: 100%; background: transparent; color: var(--text); font-family: system-ui, sans-serif; }',
    '#root { height: 100%; container-type: size; display: flex; align-items: center; justify-content: space-around; gap: 4cqmin; padding: 4cqmin; box-sizing: border-box; }',
    '.row { display: flex; flex-direction: column; align-items: center; }',
    '.label { font-size: 9cqmin; color: var(--muted); }',
    '.value { font-size: 24cqmin; font-variant-numeric: tabular-nums; }',
    '',
  ].join('\n');
  const js = [
    "'use strict';",
    '// Say hello, follow the theme, then paint each `system` update.',
    '// Render text with textContent.',
    "const cpu = document.getElementById('cpu');",
    "const mem = document.getElementById('mem');",
    "const pct = (v) => (typeof v === 'number' ? Math.round(v) + '%' : '--');",
    'function applyTheme(theme) {',
    '  if (!theme) return;',
    '  const root = document.documentElement;',
    "  root.style.colorScheme = theme.appearance === 'light' ? 'light' : 'dark';",
    '  const p = theme.palette || {};',
    "  if (p.text) root.style.setProperty('--text', p.text);",
    "  if (p.muted) root.style.setProperty('--muted', p.muted);",
    '}',
    "window.addEventListener('message', (e) => {",
    '  const m = e.data;',
    '  if (!m || m.xenonSdk !== 1) return;',
    "  if (m.type === 'init' || m.type === 'theme') applyTheme(m.theme);",
    "  if (m.type !== 'data' || m.stream !== 'system') return;",
    '  cpu.textContent = pct(m.data && m.data.cpu);',
    '  mem.textContent = pct(m.data && m.data.memory && m.data.memory.percent);',
    '});',
    "window.parent.postMessage({ xenonSdk: 1, type: 'hello' }, '*');",
    '',
  ].join('\n');
  return [
    { path: 'manifest.json', data: b64(JSON.stringify(manifest, null, 2) + '\n') },
    { path: 'index.html', data: b64(html) },
    { path: 'style.css', data: b64(css) },
    { path: 'main.js', data: b64(js) },
  ];
}

async function opStatus(_args, deps) {
  return {
    ok: true,
    xenon: deps.appVersion,
    mcpApi: MCP_API,
    sdkApi: deps.sdkApiVersion,
    widgetsOn: deps.sdkEnabled(),
    dashboardOpen: deps.dashboardOpen(),
    sizes: SIZES,
  };
}

async function opReference(args, deps) {
  return deps.getSdkReference(String((args && args.section) || ''));
}

async function opTemplate(args) {
  const id = String((args && args.id) || '').trim();
  if (!WIDGET_ID_RE.test(id)) return { ok: false, error: 'bad_id', hint: 'An id is 2 to 41 characters: a-z, 0-9 and dashes, starting with a letter or digit.' };
  const name = String((args && args.name) || id).trim().slice(0, 60) || id;
  const size = SIZES.includes(args && args.size) ? args.size : 'medium';
  return { ok: true, id, files: templateFiles({ name, size }) };
}

// The checks an install would run, without installing: the package boundary,
// the sandbox read and the Store's share-code rules.
async function opCheck(args, deps) {
  const payload = payloadOf(args);
  const v = deps.validateWidgetPayload(payload);
  if (!v.ok) return { ok: false, error: v.reason, hint: 'Fix this first: the package cannot install. See sdk_reference section "manifest".' };
  const checked = deps.critiqueWidget(v.id, payload.files);
  return {
    ok: true,
    id: v.id,
    name: v.manifest.name,
    permissions: permissionsOf(v.manifest),
    sandbox: sourceIssues(payload.files, deps),
    critique: checked ? checked.critique : null,
  };
}

function permissionsOf(m) {
  return { streams: m.streams || [], actions: m.actions || [], hosts: m.hosts || [] };
}

async function opInstall(args, deps) {
  if (!deps.sdkEnabled()) return { ok: false, error: 'widgets_off', hint: 'Ask the person to switch on Community widgets in Xenon Settings first.' };
  const payload = payloadOf(args);
  if (!WIDGET_ID_RE.test(payload.id)) return { ok: false, error: 'bad_id' };
  // An id already installed is an update, and only of the person's own work.
  if (await deps.isInstalled(payload.id) && !deps.isOwn(payload.id)) {
    return { ok: false, error: 'not_yours', hint: 'That id is a widget from the Store or a share code. Pick a different id.' };
  }
  const r = await deps.install(payload);
  if (!r.ok) return { ok: false, error: r.error };
  const placed = await deps.place(r.id);
  const checked = deps.critiqueWidget(r.id, payload.files);
  return {
    ok: true,
    id: r.id,
    name: r.name,
    onDashboard: placed,
    permissions: { streams: r.streams || [], actions: r.actions || [], hosts: r.hosts || [] },
    note: placed
      ? 'Installed and on the dashboard, which now shows its page (a new page when the one in view was full). A widget already on a tile only refreshes. New permissions wait for the person to approve them on the dashboard.'
      : 'Installed. No dashboard is open to show it: ask the person to open Xenon, then call widget_issues.',
    sandbox: sourceIssues(payload.files, deps),
    critique: checked ? checked.critique : null,
  };
}

async function opIssues(args, deps) {
  const id = String((args && args.id) || '');
  if (!WIDGET_ID_RE.test(id)) return { ok: false, error: 'bad_id' };
  if (!(await deps.isInstalled(id))) return { ok: false, error: 'not_installed' };
  const seen = await deps.ask('issues', { id });
  if (!seen) return { ok: false, error: 'no_dashboard', hint: 'Xenon\'s dashboard is not open, so nothing is running to look at.' };
  return {
    ok: true,
    id,
    onScreen: seen.onScreen === true,
    approved: seen.approved === true,
    blocked: Array.isArray(seen.blocked) ? seen.blocked : [],
    errors: Array.isArray(seen.errors) ? seen.errors : [],
    perf: seen.perf || null,
  };
}

async function opShot(args, deps) {
  const id = String((args && args.id) || '');
  if (!WIDGET_ID_RE.test(id)) return { ok: false, error: 'bad_id' };
  if (!(await deps.isInstalled(id))) return { ok: false, error: 'not_installed' };
  const where = await deps.ask('where', { id });
  if (!where) return { ok: false, error: 'no_dashboard' };
  if (where.found !== true || !where.rect) return { ok: false, error: 'not_on_screen', hint: 'The widget is not on the page the dashboard shows. Install it again to place it, or ask the person to open its page.' };
  const shot = await deps.captureRect(where.rect);
  if (!shot || !shot.ok) return { ok: false, error: (shot && shot.error) || 'capture_failed' };
  return { ok: true, id, image: { mimeType: 'image/jpeg', data: shot.data }, size: { width: shot.width, height: shot.height } };
}

async function opMine(args, deps) {
  const id = String((args && args.id) || '');
  if (!id) return { ok: true, widgets: await deps.listOwn() };
  if (!deps.isOwn(id)) return { ok: false, error: 'not_yours_or_missing', hint: 'Only widgets the person made can be read. Call my_widgets with no id for the list.' };
  const payload = await deps.readPayload(id);
  return payload ? { ok: true, id, files: payload.files } : { ok: false, error: 'not_found' };
}

async function opShare(args, deps) {
  const id = String((args && args.id) || '');
  if (!deps.isOwn(id)) return { ok: false, error: 'not_yours_or_missing' };
  const payload = await deps.readPayload(id);
  if (!payload) return { ok: false, error: 'not_found' };
  const checked = deps.critiqueWidget(id, payload.files);
  if (!checked || !checked.code) return { ok: false, error: 'not_shareable' };
  return {
    ok: true,
    id,
    code: checked.code,
    critique: checked.critique,
    note: 'Anyone can paste this code in Xenon (Settings, Import). To put it in the Store, send it from xenon-app.com/submit.',
  };
}

// Where the tile is on the physical screen, from what the dashboard measured:
// its box in CSS pixels plus the window's own screen position. Windows and
// Linux capture in device pixels; macOS's screencapture -R takes points, which
// are CSS pixels. null when the box is not a sane, visible size.
function screenRect(platform, where) {
  const r = where && where.rect;
  if (!r) return null;
  const vals = [r.left, r.top, r.width, r.height, r.screenX, r.screenY].map(Number);
  if (!vals.every(Number.isFinite)) return null;
  const [left, top, width, height, sx, sy] = vals;
  if (width < 8 || height < 8 || width > 8192 || height > 8192) return null;
  const dpr = Math.min(4, Math.max(0.5, Number(where.dpr) || 1));
  const k = platform === 'darwin' ? 1 : dpr;
  return { x: Math.round((sx + left) * k), y: Math.round((sy + top) * k), width: Math.round(width * k), height: Math.round(height * k) };
}

const OPS = Object.freeze({
  status: opStatus,
  sdk_reference: opReference,
  widget_template: opTemplate,
  check_widget: opCheck,
  install_widget: opInstall,
  widget_issues: opIssues,
  widget_shot: opShot,
  my_widgets: opMine,
  share_widget: opShare,
});

async function runOp(op, args, deps) {
  const fn = Object.prototype.hasOwnProperty.call(OPS, op) ? OPS[op] : null;
  if (!fn) return { ok: false, error: 'unknown_op', hint: 'This Xenon does not know that tool. Update Xenon or xenon-mcp.' };
  return fn(args && typeof args === 'object' ? args : {}, deps);
}

module.exports = { runOp, OPS, MCP_API, templateFiles, screenRect };
