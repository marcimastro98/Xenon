// Writes a dictionary's strings into the home page markup: the text of every
// [data-i18n] / [data-i18n-html] element and the alt / aria-label of every
// [data-i18n-alt] / [data-i18n-aria] one. Used by build-i18n.mjs for the
// language copies and by home-i18n.mjs to keep the English defaults in
// docs/index.html equal to I18N.en, so crawlers and no-JS readers get the
// same words the runtime would show.

export const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

export function readTables(src) {
  const tables = {};
  const re = / {2}I18N\.([a-z]{2}) = \{([\s\S]*?)\n {2}\};/g;
  let m;
  while ((m = re.exec(src))) tables[m[1]] = JSON.parse('{' + m[2].replace(/,\s*$/, '') + '\n}');
  return tables;
}

// Index of the matching close tag for an element whose open tag ends at `from`.
// Counts nested opens of the same tag so <span><span>…</span></span> resolves.
function findClose(src, tag, from) {
  const re = new RegExp('<(/?)' + tag + '\\b[^>]*>', 'g');
  re.lastIndex = from;
  let depth = 1;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === '/') { depth -= 1; if (depth === 0) return m.index; }
    else if (!m[0].endsWith('/>')) depth += 1;
  }
  return -1;
}

function bakeText(src, dict, fallback) {
  const re = /<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)\sdata-i18n(-html)?="([^"]+)"([^>]*)>/g;
  let out = '';
  let last = 0;
  let baked = 0;
  let m;
  while ((m = re.exec(src))) {
    const [full, tag, , isHtml, key] = m;
    const openEnd = m.index + full.length;
    const close = findClose(src, tag, openEnd);
    if (close < 0) throw new Error(`no closing </${tag}> for data-i18n "${key}"`);
    const val = dict[key] != null ? dict[key] : fallback[key];
    out += src.slice(last, openEnd);
    if (val != null) { out += isHtml ? val : escText(val); baked += 1; }
    else out += src.slice(openEnd, close);
    last = close;
    re.lastIndex = close;
  }
  return { out: out + src.slice(last), baked };
}

const ATTRS = [['alt', 'alt'], ['aria', 'aria-label']];

function bakeAttrs(src, dict, fallback) {
  let baked = 0;
  let out = src;
  for (const [suffix, attr] of ATTRS) {
    const tagRe = new RegExp(`<[a-zA-Z][^>]*\\sdata-i18n-${suffix}="([^"]+)"[^>]*>`, 'g');
    out = out.replace(tagRe, (tag, key) => {
      const val = dict[key] != null ? dict[key] : fallback[key];
      if (val == null) return tag;
      const attrRe = new RegExp(`(\\s${attr}=")[^"]*(")`);
      if (!attrRe.test(tag)) return tag;
      baked += 1;
      return tag.replace(attrRe, (_, a, b) => a + escAttr(val) + b);
    });
  }
  return { out, baked };
}

export function bake(src, dict, fallback = {}) {
  const t = bakeText(src, dict, fallback);
  const a = bakeAttrs(t.out, dict, fallback);
  return { out: a.out, baked: t.baked + a.baked };
}

// The English page is docs/index.html itself: rewrite its defaults from I18N.en,
// touching only the markup before the first dictionary.
export function syncEnglish(src) {
  const en = readTables(src).en;
  if (!en) throw new Error('no I18N.en table found');
  const cut = src.search(/ {2}I18N\.[a-z]{2} = \{/);
  const head = src.slice(0, src.lastIndexOf('<script', cut));
  const { out } = bake(head, en, {});
  return out + src.slice(head.length);
}
