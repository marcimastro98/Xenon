'use strict';
// Themes, animated backgrounds and the other share codes (a page, a Deck
// profile, the top bar, an icon pack, a package of several): the tools that
// make them. A share code is data, not an installed package: Xenon checks it
// with the rules its own assistant uses, and import_preset opens the import
// window on the dashboard, where the person reviews and confirms it. Nothing is
// applied from here. A background's draw() code can sit in its own .js file,
// read on this side, so it never has to be escaped inside JSON.
const fs = require('fs');
const path = require('path');

const KINDS = ['theme', 'bg', 'bundle', 'page', 'deck', 'topbar', 'icons', 'ambient-layout'];
// Xenon's own cap on a background's code (server/js/custom-bg.js CODE_MAX).
const CODE_MAX = 60000;
const TOO_LONG = { error: { ok: false, error: 'code_too_long', hint: 'A background\'s code is at most ' + CODE_MAX + ' characters.' } };

const kindProp = { type: 'string', enum: KINDS, description: 'theme (colours, glass, fonts of the whole dashboard), bg (an animated background), bundle (a package: theme + bg + pages + more), page, deck, topbar, icons, ambient-layout (a native Ambient scene).' };
const presetProps = {
  kind: kindProp,
  name: { type: 'string', description: 'The name people see.' },
  data: { type: 'object', description: 'The preset itself, as preset_reference describes it for this kind.' },
  codeFile: { type: 'string', description: 'Absolute path of a .js file holding a background\'s code (the body that defines draw(ctx, t, w, h)). It goes into data.code for bg, data.bgCustom.code for a theme, data.bg.code for a bundle.' },
};

const TOOLS = [
  {
    name: 'preset_reference',
    description: 'Read the exact rules of a theme, animated background or other share code (Xenon 5.3): every field, its range and a minimal valid example. With no kind you get the list of kinds. Read it before writing one. Widgets have their own tools (sdk_reference, new_widget).',
    inputSchema: { type: 'object', properties: { kind: kindProp } },
  },
  {
    name: 'check_preset',
    description: 'Check a theme, animated background or other share code without opening it (Xenon 5.3): what the import would drop or change, design and performance notes, and the share code anyone can paste in Xenon.',
    inputSchema: { type: 'object', required: ['kind', 'data'], properties: presetProps },
  },
  {
    name: 'import_preset',
    description: 'Open a theme, animated background or other share code in Xenon\'s import window on the dashboard (Xenon 5.3). The person reviews and confirms it there; nothing changes before that. Then call dashboard_screenshot.',
    inputSchema: { type: 'object', required: ['kind', 'data'], properties: presetProps },
  },
  {
    name: 'dashboard_screenshot',
    description: 'A picture of the whole Xenon dashboard as it is on screen now, to see a theme or background after the person confirmed it (Xenon 5.3). Anything on top of the dashboard shows too. Not available on Linux under Wayland.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Where a background's code goes for each kind that can carry one.
const CODE_SLOT = {
  bg: (data, code) => ({ ...data, code }),
  theme: (data, code) => ({ ...data, bgCustom: { ...(isObject(data.bgCustom) ? data.bgCustom : {}), code } }),
  bundle: (data, code) => ({ ...data, bg: { ...(isObject(data.bg) ? data.bg : {}), code } }),
};

function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// → { args } with the code placed in data, or { error } the assistant reads.
async function withCode(args) {
  let data = args.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) { return { error: { ok: false, error: 'bad_json', hint: String(e.message).slice(0, 160) } }; }
  }
  if (!isObject(data)) return { error: { ok: false, error: 'bad_data', hint: 'data is a JSON object: see preset_reference.' } };
  if (!args.codeFile) return { args: { kind: args.kind, name: args.name, data } };
  const slot = CODE_SLOT[args.kind];
  if (!slot) return { error: { ok: false, error: 'no_code_here', hint: 'codeFile is for bg, theme and bundle.' } };
  const file = String(args.codeFile);
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.js') return { error: { ok: false, error: 'bad_code_file', hint: 'codeFile is the absolute path of a .js file.' } };
  let code;
  try {
    // Refused by its size on disk first: a huge file is never read whole just to be turned down.
    if ((await fs.promises.stat(file)).size > CODE_MAX * 4) return TOO_LONG;
    code = await fs.promises.readFile(file, 'utf8');
  } catch (e) { return { error: { ok: false, error: 'unreadable', hint: e?.code || 'cannot read codeFile' } }; }
  if (code.length > CODE_MAX) return TOO_LONG;
  return { args: { kind: args.kind, name: args.name, data: slot(data, code) } };
}

function makeHandlers({ answer, failed }) {
  const preset = (op) => async (a, c) => {
    const w = await withCode(a);
    return w.error ? failed(w.error) : answer(await c.call(op, w.args));
  };
  async function screenshot(_a, c) {
    const r = await c.call('dashboard_shot', {});
    if (!r?.ok || !r.image) return answer(r);
    return { content: [{ type: 'image', data: r.image.data, mimeType: r.image.mimeType }, { type: 'text', text: `dashboard, ${r.size.width}x${r.size.height}` }] };
  }
  return {
    preset_reference: (a, c) => c.call('preset_reference', { kind: a.kind }).then(answer),
    check_preset: preset('check_preset'),
    import_preset: preset('import_preset'),
    dashboard_screenshot: screenshot,
  };
}

module.exports = { TOOLS, makeHandlers, withCode, KINDS, CODE_MAX };
