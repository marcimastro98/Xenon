'use strict';
// The document a steps recording becomes (steps-recorder.js): one page that
// prints well, with every picture inside it (steps.html, opens anywhere, sent as
// one file), and the same steps in Markdown with the pictures beside it
// (steps.md, for a wiki or a repo). Pure: the words come in already in the
// user's language, the pictures already read.
//
// What a step says comes from the engine (apps/capture, `step` events): which
// button, which kind of control, in which app. Those names are other apps'
// text, so they are escaped everywhere. Typing is noted as "then type the text",
// never what was typed: the engine never sees the keys.

const STEP_WORDS = Object.freeze([
  'steps_doc_title', 'steps_doc_made', 'steps_one', 'steps_count', 'steps_step', 'steps_sentence',
  'steps_click_named', 'steps_click_spot', 'steps_right_named', 'steps_right_spot',
  'steps_double_named', 'steps_double_spot', 'steps_type_after', 'steps_in_app',
  'steps_ended_full', 'steps_ended_idle',
]);
// The kinds of control the engine names (apps/capture/src/steps.rs `role`).
const ROLES = Object.freeze(['button', 'checkbox', 'dropdown', 'field', 'link', 'item', 'menu', 'option', 'slider', 'tab']);
const ROLE_WORDS = Object.freeze(ROLES.map(r => 'steps_role_' + r));
const ALL_WORDS = Object.freeze([...STEP_WORDS, ...ROLE_WORDS]);

const MAX_STEPS = 100;
const NAME_MAX = 80;
const APP_MAX = 60;
const FILE_RE = /^step-\d{3}\.jpg$/;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const fill = (template, values) => String(template || '').replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));

// "chrome.exe" → "chrome": the name people know, without the file type.
function appName(exe) {
  return clean(exe, APP_MAX + 4).replace(/\.exe$/i, '').slice(0, APP_MAX);
}

// One step as the engine reported it, or null when it is not one.
function normalizeStep(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const n = Number(ev.n);
  if (!Number.isInteger(n) || n < 1 || n > MAX_STEPS) return null;
  const file = String(ev.file || '');
  if (!FILE_RE.test(file)) return null;
  const dim = v => (Number.isInteger(v) && v > 0 && v <= 16384 ? v : 0);
  return {
    n, file,
    width: dim(ev.width), height: dim(ev.height),
    right: ev.right === true,
    double: false,
    app: appName(ev.app),
    name: clean(ev.name, NAME_MAX),
    role: ROLES.includes(ev.role) ? ev.role : '',
    typedBefore: ev.typedBefore === true,
  };
}

// Typing between two clicks belongs to the step before it; after the last
// click, to the last step. Typing before the first click (the key that
// started the recording) is not a step of the procedure.
function withTyping(steps, typedAtEnd) {
  return steps.map((s, i) => {
    const next = steps[i + 1];
    return { ...s, typedAfter: next ? next.typedBefore : typedAtEnd === true };
  });
}

// "Click "Save report" (button)." in the user's language.
function stepText(step, words) {
  const w = words || {};
  const kind = step.double ? 'double' : step.right ? 'right' : 'click';
  const action = step.name
    ? fill(w[`steps_${kind}_named`], { name: step.name })
    : String(w[`steps_${kind}_spot`] || '');
  const role = step.role ? String(w['steps_role_' + step.role] || '') : '';
  // "{action}." in most languages, "{action}。" in Chinese and Japanese.
  const sentence = fill(w.steps_sentence || '{action}.', { action: role ? `${action} (${role})` : action });
  return step.typedAfter ? `${sentence} ${w.steps_type_after || ''}`.trim() : sentence;
}

function countText(n, words) {
  return n === 1 ? String(words.steps_one || '1') : fill(words.steps_count, { n });
}

// The line under the steps when the recording did not end by a stop.
function endNote(reason, words) {
  if (reason === 'full') return String(words.steps_ended_full || '');
  if (reason === 'idle') return String(words.steps_ended_idle || '');
  return '';
}

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => HTML_ESC[c]);
// Every character Markdown could read as syntax, so a button called "**x**"
// or "[a](b)" stays text.
const escapeMd = s => String(s).replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
const LANG_RE = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;

const CSS = [
  ':root{color-scheme:light}',
  'body{margin:0;background:#fff;color:#1d1d1f;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}',
  'main{max-width:960px;margin:0 auto;padding:32px 20px 48px}',
  'h1{font-size:26px;margin:0 0 4px}',
  '.meta{color:#5f6368;margin:0 0 28px}',
  'ol{list-style:none;margin:0;padding:0}',
  'li{margin:0 0 36px;break-inside:avoid;page-break-inside:avoid}',
  'h2{font-size:18px;margin:0 0 2px;display:flex;gap:10px;align-items:baseline}',
  '.n{flex:none;min-width:28px;height:28px;border-radius:14px;background:#1d1d1f;color:#fff;font-size:14px;display:inline-grid;place-items:center}',
  '.app{color:#5f6368;font-size:14px;margin:0 0 10px 38px}',
  'img{display:block;max-width:100%;height:auto;border:1px solid #d9d9de;border-radius:6px}',
  '.end{color:#5f6368}',
  '@page{margin:14mm}',
  '@media print{main{padding:0}li{margin-bottom:18px}}',
].join('');

// steps: normalized steps with typedAfter; images: file → base64 JPEG.
function toHtml({ steps, words, when, reason, lang, images }) {
  const w = words || {};
  const pics = images || {};
  const items = steps.map((s) => {
    const app = s.app ? `<p class="app">${escapeHtml(fill(w.steps_in_app, { app: s.app }))}</p>` : '<p class="app"></p>';
    const alt = escapeHtml(fill(w.steps_step, { n: s.n }));
    const size = s.width && s.height ? ` width="${s.width}" height="${s.height}"` : '';
    const img = pics[s.file] ? `<img src="data:image/jpeg;base64,${pics[s.file]}" alt="${alt}"${size}>` : '';
    return `<li><h2><span class="n">${s.n}</span><span>${escapeHtml(stepText(s, w))}</span></h2>${app}${img}</li>`;
  }).join('\n');
  const note = endNote(reason, w);
  const title = escapeHtml(w.steps_doc_title || 'Steps');
  const meta = `${escapeHtml(fill(w.steps_doc_made, { date: when }))} · ${escapeHtml(countText(steps.length, w))}`;
  return '<!doctype html>\n'
    + `<html lang="${LANG_RE.test(String(lang)) ? lang : 'en'}"><head><meta charset="utf-8">`
    // Opened from disk in any browser: nothing to fetch, nothing to run.
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${title}</title><style>${CSS}</style></head><body><main>`
    + `<h1>${title}</h1><p class="meta">${meta}</p>\n<ol>\n${items}\n</ol>`
    + (note ? `<p class="end">${escapeHtml(note)}</p>` : '')
    + '</main></body></html>\n';
}

function toMarkdown({ steps, words, when, reason }) {
  const w = words || {};
  const lines = [`# ${escapeMd(w.steps_doc_title || 'Steps')}`, '', `${escapeMd(fill(w.steps_doc_made, { date: when }))} · ${escapeMd(countText(steps.length, w))}`, ''];
  for (const s of steps) {
    lines.push(`## ${s.n}\\. ${escapeMd(stepText(s, w))}`, '');
    if (s.app) lines.push(escapeMd(fill(w.steps_in_app, { app: s.app })), '');
    lines.push(`![${escapeMd(fill(w.steps_step, { n: s.n }))}](${s.file})`, '');
  }
  const note = endNote(reason, w);
  if (note) lines.push(escapeMd(note), '');
  return lines.join('\n');
}

module.exports = {
  ALL_WORDS, ROLES, MAX_STEPS,
  appName, normalizeStep, withTyping, stepText, countText, endNote, escapeHtml, escapeMd, toHtml, toMarkdown,
};
