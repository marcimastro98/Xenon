;(function (root, factory) {
  'use strict';
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.Xenon = root.Xenon || {};
  root.Xenon.richText = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Store descriptions in a small Markdown subset.
   *
   * Creators write descriptions the way they write a README: paragraphs,
   * bullet lists, **bold**. Every surface that shows one (the in-app Store, the
   * website catalog, the hub's emails; Discord renders Markdown itself) reads
   * it through this file, so a description looks the same everywhere.
   *
   * THIS FILE IS THE CONTRACT. `docs/catalog/index.html` (self-contained) and
   * the hub's `src/rich-text.js` (a separate repo) carry mirrored copies, held
   * in step by server/test/rich-text-sync.test.mjs.
   *
   * The text is untrusted. Nothing here builds HTML from strings: `render`
   * creates elements and sets textContent, and the only elements it ever makes
   * are p, ul, ol, li, strong, em, code and br. Links are shown as their text,
   * never as links: a Store description is not a place to send people
   * somewhere else.
   *
   * Supported: blank-line paragraphs, line breaks, "- " / "* " / "+ " / "• "
   * bullets, "1. " numbered lists, "#" headings (shown as a bold line),
   * **bold**, __bold__, *italic*, _italic_, `code`, backslash escapes.
   */

  // The longest description the hub keeps. Mirrored by the hub's submission
  // form and catalog writer, and by both storefronts' normalizers.
  const DESCRIPTION_MAX = 800;

  // Backslash escapes become private-use placeholders while parsing, so an
  // escaped marker is never read as a marker, then turn back into the character.
  const ESC_BASE = 0xE000;
  const ESCAPABLE = '\\`*_{}[]()#+-.!•';
  const escapeOut = (s) => s.replace(/\\([\\`*_{}[\]()#+\-.!•])/g, (_, c) => String.fromCharCode(ESC_BASE + ESCAPABLE.indexOf(c)));
  const escapeBack = (s) => s.replace(/[\uE000-\uE00F]/g, (c) => ESCAPABLE[c.charCodeAt(0) - ESC_BASE] || '');

  // One pass, earliest match wins: code, bold, italic, a [text](url) link.
  // Underscore emphasis needs a non-word character before it (captured, since
  // older macOS WebKit has no lookbehind) and after it, so snake_case names
  // stay as written.
  const INLINE = /`([^`\n]+)`|\*\*(?=\S)([^\n]*?\S)\*\*|__(?=\S)([^\n]*?\S)__(?!\w)|\*(?=[^\s*])([^*\n]*?[^\s*])\*|(^|[^\w\uE000-\uE00F])_(?=\S)([^_\n]*?\S)_(?!\w)|\[([^\]\n]+)\]\([^)\s]*\)/g;

  function parseInline(src, depth) {
    const out = [];
    const text = (v) => { if (v) out.push({ t: 'text', v: escapeBack(v) }); };
    let last = 0;
    const re = new RegExp(INLINE.source, 'g');
    let m;
    while ((m = re.exec(src))) {
      text(src.slice(last, m.index));
      last = re.lastIndex;
      if (m[1] != null) out.push({ t: 'code', v: escapeBack(m[1]) });
      else if (m[2] != null || m[3] != null) out.push({ t: 'b', c: inner(m[2] != null ? m[2] : m[3], depth) });
      else if (m[4] != null) out.push({ t: 'i', c: inner(m[4], depth) });
      else if (m[6] != null) { text(m[5]); out.push({ t: 'i', c: inner(m[6], depth) }); }
      else text(m[7]);
    }
    text(src.slice(last));
    return out;
  }
  // Emphasis nests one level (bold inside italic and the reverse); deeper than
  // that it is plain text, which keeps the parse bounded on hostile input.
  const inner = (s, depth) => (depth >= 1 ? [{ t: 'text', v: escapeBack(s) }] : parseInline(s, depth + 1));

  const BULLET = /^\s{0,3}[-*+•]\s+(.*)$/;
  const NUMBER = /^\s{0,3}\d{1,3}[.)]\s+(.*)$/;
  const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

  // text -> [{ type: 'p', lines: [inline[]] } | { type: 'h', c } | { type: 'ul'|'ol', items: [inline[]] }]
  function parse(text) {
    const src = escapeOut(String(text == null ? '' : text).replace(/\r\n?/g, '\n').slice(0, DESCRIPTION_MAX * 2));
    const blocks = [];
    let cur = null;
    const close = () => { cur = null; };
    for (const raw of src.split('\n')) {
      const line = raw.replace(/\s+$/, '');
      if (!line.trim()) { close(); continue; }
      let m = HEADING.exec(line);
      if (m && m[1]) { close(); blocks.push({ type: 'h', c: parseInline(m[1], 0) }); continue; }
      m = BULLET.exec(line);
      const n = m ? null : NUMBER.exec(line);
      if (m || n) {
        const type = m ? 'ul' : 'ol';
        if (!cur || cur.type !== type) { cur = { type, items: [] }; blocks.push(cur); }
        cur.items.push((m || n)[1]);
        continue;
      }
      if (cur && (cur.type === 'ul' || cur.type === 'ol') && /^\s+/.test(raw)) {
        cur.items[cur.items.length - 1] += ' ' + line.trim();   // a wrapped list item
        continue;
      }
      if (!cur || cur.type !== 'p') { cur = { type: 'p', lines: [] }; blocks.push(cur); }
      cur.lines.push(line.trim());
    }
    return blocks.map((blk) => {
      if (blk.type === 'p') return { type: 'p', lines: blk.lines.map((l) => parseInline(l, 0)) };
      if (blk.type === 'h') return blk;
      return { type: blk.type, items: blk.items.map((i) => parseInline(i.trim(), 0)) };
    });
  }

  const inlineText = (nodes) => nodes.map((n) => (n.c ? inlineText(n.c) : n.v)).join('');

  // The description as plain text: for cards that clamp to two lines, search,
  // meta tags and emails. Blocks are separated by a newline, bullets keep "• ".
  function plain(text) {
    const out = [];
    for (const blk of parse(text)) {
      if (blk.type === 'p') out.push(blk.lines.map(inlineText).join('\n'));
      else if (blk.type === 'h') out.push(inlineText(blk.c));
      else blk.items.forEach((it, i) => out.push((blk.type === 'ol' ? (i + 1) + '. ' : '• ') + inlineText(it)));
    }
    return out.join('\n');
  }

  function appendInline(doc, parent, nodes) {
    for (const n of nodes) {
      if (n.t === 'text') parent.appendChild(doc.createTextNode(n.v));
      else if (n.t === 'code') { const c = doc.createElement('code'); c.textContent = n.v; parent.appendChild(c); }
      else { const e = doc.createElement(n.t === 'b' ? 'strong' : 'em'); appendInline(doc, e, n.c); parent.appendChild(e); }
    }
  }

  // The description as DOM, built element by element (never innerHTML).
  function render(doc, text) {
    const frag = doc.createDocumentFragment();
    for (const blk of parse(text)) {
      if (blk.type === 'p') {
        const p = doc.createElement('p');
        blk.lines.forEach((l, i) => { if (i) p.appendChild(doc.createElement('br')); appendInline(doc, p, l); });
        frag.appendChild(p);
      } else if (blk.type === 'h') {
        const p = doc.createElement('p');
        const s = doc.createElement('strong');
        appendInline(doc, s, blk.c);
        p.appendChild(s);
        frag.appendChild(p);
      } else {
        const list = doc.createElement(blk.type);
        for (const it of blk.items) { const li = doc.createElement('li'); appendInline(doc, li, it); list.appendChild(li); }
        frag.appendChild(list);
      }
    }
    return frag;
  }

  return { DESCRIPTION_MAX, parse, plain, render };
});
