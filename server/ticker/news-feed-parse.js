'use strict';
// Reads the headlines out of an RSS or Atom feed without a parser library: tags found by hand,
// entities decoded, markup stripped, sizes capped.

// Parser budgets. A feed is untrusted input parsed on the event loop: only the
// first PARSE_MAX_CHARS are read, at most PARSE_MAX_BLOCKS <item>/<entry>
// blocks are looked at, and each block is cut to PARSE_MAX_BLOCK_CHARS (a
// full-text item keeps its title, which comes first, and loses the tail).
const PARSE_MAX_CHARS = 512 * 1024;
const PARSE_MAX_BLOCKS = 200;
const PARSE_MAX_BLOCK_CHARS = 64 * 1024;
const TAG_MAX_CHARS = 8000;        // one tag's text before entity decoding

function str(value, max) { return String(value == null ? '' : value).trim().slice(0, max || 200); }

// A link/image URL rendered as href/src → http(s) only (scheme allowlist; see
// CLAUDE.md). Returns '' for anything else so the caller can drop it.
function safeUrl(value) {
  const s = String(value || '').trim().slice(0, 600);
  return /^https?:\/\//i.test(s) ? s : '';
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x0*27;/gi, "'").replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&amp;/g, '&');
}

// Strip HTML tags and collapse whitespace. Assumes its input is ALREADY
// entity-decoded (firstTag decodes; the NewsData JSON path decodes explicitly) —
// decoding here too would double-decode ("&amp;lt;" → a literal "<").
// `[^<>]*` rather than `[^>]*`: a run of '<' with no '>' would otherwise make
// every '<' rescan to the end of the string (quadratic on hostile input).
function stripTags(s) { return String(s || '').slice(0, TAG_MAX_CHARS).replace(/<[^<>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }

// After "<tag" the name must end: '>', '/', or whitespace.
function tagNameEnds(lower, at) {
  const c = lower.charCodeAt(at);
  return c === 62 || c === 47 || c === 32 || c === 9 || c === 10 || c === 13;
}

// Every "<tag ...>...</tag>" block, in order, up to `maxBlocks`.
function findBlocks(src, lower, tag, maxBlocks, maxLen) {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  const out = [];
  let pos = 0;
  while (out.length < maxBlocks) {
    const start = lower.indexOf(open, pos);
    if (start === -1) break;
    if (!tagNameEnds(lower, start + open.length)) { pos = start + open.length; continue; }
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) break;
    const stop = end + close.length;
    out.push(src.slice(start, Math.min(stop, start + maxLen)));
    pos = stop;
  }
  return out;
}

// Text of the first <tag ...>text</tag>, entity-decoded; '' if none.
function tagText(block, lower, tag) {
  const open = '<' + tag;
  const close = '</' + tag + '>';
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return '';
    if (!tagNameEnds(lower, start + open.length)) { pos = start + open.length; continue; }
    const gt = lower.indexOf('>', start + open.length);
    if (gt === -1) return '';
    const end = lower.indexOf(close, gt + 1);
    if (end === -1) return '';
    return decodeEntities(block.slice(gt + 1, Math.min(end, gt + 1 + TAG_MAX_CHARS))).trim();
  }
}

// Value of attribute `attr` on the first <tag ...> that carries it; '' if none.
function attrValue(block, lower, tag, attr) {
  const open = '<' + tag;
  const re = new RegExp('\\s' + attr + '=(["\'])(.*?)\\1', 'i');
  let pos = 0;
  for (;;) {
    const start = lower.indexOf(open, pos);
    if (start === -1) return '';
    if (!tagNameEnds(lower, start + open.length)) { pos = start + open.length; continue; }
    const gt = lower.indexOf('>', start + open.length);
    const head = block.slice(start + open.length, gt === -1 ? block.length : gt);
    const m = re.exec(head.slice(0, TAG_MAX_CHARS));
    if (m) return decodeEntities(m[2]).trim();
    if (gt === -1) return '';
    pos = gt + 1;   // anything before this '>' is inside the tag just checked
  }
}

function firstTag(block, tag) { return tagText(block, block.toLowerCase(), tag); }

function parseFeed(xml, feed) {
  const items = [];
  const src = String(xml || '').slice(0, PARSE_MAX_CHARS);
  const lower = src.toLowerCase();
  const feedTitle = firstTag(src.slice(0, 4000), 'title'); // channel/feed title
  let blocks = findBlocks(src, lower, 'item', PARSE_MAX_BLOCKS, PARSE_MAX_BLOCK_CHARS);
  if (!blocks.length) blocks = findBlocks(src, lower, 'entry', PARSE_MAX_BLOCKS, PARSE_MAX_BLOCK_CHARS);
  for (const block of blocks) {
    const lb = block.toLowerCase();
    const rawTitle = tagText(block, lb, 'title');
    if (!rawTitle) continue;
    // Atom <link href="..."/> or RSS <link>...</link>
    let link = tagText(block, lb, 'link');
    if (!link) link = attrValue(block, lb, 'link', 'href');
    const url = safeUrl(link);
    const dateStr = tagText(block, lb, 'pubdate') || tagText(block, lb, 'updated') || tagText(block, lb, 'published') || tagText(block, lb, 'dc:date');
    let published = Date.parse(dateStr);
    if (!Number.isFinite(published)) published = 0;
    const image = safeUrl(attrValue(block, lb, 'media:thumbnail', 'url') || attrValue(block, lb, 'media:content', 'url') || attrValue(block, lb, 'enclosure', 'url'));
    // Google News packs "Title - Source"; split the source off if present.
    let title = stripTags(rawTitle);
    let source = tagText(block, lb, 'source') || feed.name || feedTitle;
    if (feed.type === 'topic') {
      const dash = title.lastIndexOf(' - ');
      if (dash > 10 && dash > title.length - 60) { source = title.slice(dash + 3).trim(); title = title.slice(0, dash).trim(); }
    }
    const snippet = stripTags(tagText(block, lb, 'description') || tagText(block, lb, 'summary')).slice(0, 200);
    if (!url || !title) continue;
    items.push({
      id: url,
      title: title.slice(0, 200),
      url,
      source: str(source, 60),
      published,
      image,
      snippet,
      feedId: feed.id,
    });
    if (items.length >= 30) break;
  }
  return items;
}

module.exports = {
  PARSE_MAX_CHARS, PARSE_MAX_BLOCKS, PARSE_MAX_BLOCK_CHARS, TAG_MAX_CHARS, str, safeUrl,
  decodeEntities, stripTags, tagNameEnds, findBlocks, tagText, attrValue, firstTag, parseFeed,
};
