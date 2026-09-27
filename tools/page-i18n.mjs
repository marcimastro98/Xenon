// Shared helpers for the site's static language copies (Node builtins only: CI
// runs without npm install).
//
// A translatable page marks its text with attributes and keeps English in the
// HTML itself, which stays the source of truth:
//
//   <h2 data-i18n="edge.why">Why it matters</h2>           text only
//   <p data-i18n-html="edge.p1">It <a href="/x">links</a></p>   markup kept
//   <img data-i18n-alt="edge.shot" alt="…">                  alt text
//   <a data-i18n-aria="nav.home" aria-label="…">              aria-label
//
// The translations live in tools/i18n/<page>.json:
//
//   { "en": { key: English as it stands in the page },
//     "es": { key: … }, "it": { key: … } }
//
// "en" is a snapshot, not a second source: when the page's English no longer
// matches it, the translation of that key is stale and the check says so.
// Keys starting with "meta." fill the head (title, description, social tags);
// keys starting with "ld." translate strings inside JSON-LD by exact match.

export const TAG_ATTRS = ['data-i18n-html', 'data-i18n', 'data-i18n-alt', 'data-i18n-aria'];

// Every element carrying one of the attributes, with where its content sits.
// A tiny tokenizer rather than a regex over the whole element: a <p> holding a
// <p> is invalid HTML, but a <li> holding a <ul><li> is not, and a lazy regex
// would stop at the inner closing tag.
export function findTagged(html) {
  const out = [];
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)(\s[^<>]*?)?(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    for (const attr of TAG_ATTRS) {
      const am = new RegExp('\\s' + attr + '="([^"]+)"').exec(attrs);
      if (!am) continue;
      const item = { key: am[1], attr, tag, start: m.index, openEnd: m.index + m[0].length };
      if (attr === 'data-i18n-alt' || attr === 'data-i18n-aria') {
        const which = attr === 'data-i18n-alt' ? 'alt' : 'aria-label';
        const vm = new RegExp('\\s' + which + '="([^"]*)"').exec(attrs);
        item.value = vm ? vm[1] : '';
        item.attrName = which;
      } else {
        const close = closingIndex(html, tag, item.openEnd);
        if (close < 0) throw new Error('no closing </' + tag + '> for ' + attr + '="' + item.key + '"');
        item.innerStart = item.openEnd;
        item.innerEnd = close;
        item.value = html.slice(item.openEnd, close);
      }
      out.push(item);
    }
  }
  return out;
}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);

function closingIndex(html, tag, from) {
  if (VOID.has(tag)) return -1;
  const re = new RegExp('<(/?)' + tag + '(?=[\\s>/])[^>]*>', 'gi');
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (--depth === 0) return m.index; }
    else if (!/\/>$/.test(m[0])) depth++;
  }
  return -1;
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decode = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (w, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENT[e.toLowerCase()] != null ? ENT[e.toLowerCase()] : w;
});
export const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) => escText(s).replace(/"/g, '&quot;');
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// What a key's English is in the page, in the same shape the dictionary keeps.
export function pageValue(item) {
  if (item.attr === 'data-i18n-html') return norm(item.value);
  return norm(decode(item.value));
}

// Checks one page against its dictionary. Returns a list of problems.
export function checkPage(html, dict, langs) {
  const problems = [];
  const items = findTagged(html);
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    const en = dict.en && dict.en[it.key];
    if (en == null) { problems.push('missing en snapshot: ' + it.key); continue; }
    if (norm(en) !== pageValue(it)) problems.push('stale (English changed): ' + it.key);
    for (const l of langs) {
      const v = dict[l] && dict[l][it.key];
      if (v == null || !String(v).trim()) { problems.push('missing ' + l + ': ' + it.key); continue; }
      if (it.attr === 'data-i18n-html') {
        const tags = (s) => (String(s).match(/<\/?[a-z][a-z0-9]*/gi) || []).map((x) => x.toLowerCase()).join(',');
        if (tags(v) !== tags(en)) problems.push('markup differs in ' + l + ': ' + it.key);
      }
      if (/—/.test(v)) problems.push('em-dash in ' + l + ': ' + it.key);
    }
  }
  for (const k of ['meta.title', 'meta.desc']) {
    for (const l of langs) if (!(dict[l] && dict[l][k])) problems.push('missing ' + l + ': ' + k);
  }
  return problems;
}
