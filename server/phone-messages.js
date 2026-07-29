'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// The phone's messages — PURE, no I/O, unit-tested.
//
// Two formats arrive, both from a device we do not control:
//
//   The LISTING is XML: one <msg .../> per message, everything in attributes.
//   It is scanned rather than parsed with a DOM, because adding an XML parser
//   to read six attributes is not a trade worth making — but the scan decodes
//   entities properly, since a message subject really does contain & and <, and
//   a half-decoded subject is a message the user misreads.
//
//   The MESSAGE itself is a bMessage: a small envelope with the sender's vCard
//   and the text between BEGIN:MSG and END:MSG. The text is USER CONTENT and
//   may legitimately contain the line END:MSG, which is exactly why the format
//   carries a LENGTH in bytes. That length is honoured when it is consistent,
//   and the delimiter is the fallback — in that order, because trusting the
//   delimiter first is how a message gets silently truncated by its own text.
//
// Nothing here throws on malformed input: one unreadable message must never
// cost the rest of the inbox.
// ─────────────────────────────────────────────────────────────────────────────

const { parseStamp } = require('./phone-vcard');

const MAX_MESSAGES = 500;
const MAX_TEXT = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 8000;

// ── XML bits ────────────────────────────────────────────────────────────────

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value) {
  return String(value == null ? '' : value).replace(
    /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g,
    (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        // Surrogates and out-of-range code points are dropped rather than
        // turned into a replacement character that looks like real content.
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
        if (code >= 0xd800 && code <= 0xdfff) return '';
        try { return String.fromCodePoint(code); } catch { return ''; }
      }
      const hit = ENTITIES[body.toLowerCase()];
      return hit === undefined ? whole : hit;
    },
  );
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2]);
  }
  return out;
}

// ── Listing ─────────────────────────────────────────────────────────────────

// A handle is what identifies a message to the phone and is the only value from
// this document that travels back to it, so it is shape-checked here rather
// than at the point of use.
function validHandle(value) {
  const h = String(value == null ? '' : value).trim();
  return /^[0-9A-Fa-f]{1,32}$/.test(h) ? h : '';
}

function parseListing(xml) {
  const src = String(xml == null ? '' : xml).slice(0, MAX_TEXT);
  const out = [];
  for (const m of src.matchAll(/<msg\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    const handle = validHandle(a.handle);
    if (!handle) continue;
    // The name is the phone's own resolution of the sender; the addressing is
    // the raw number. Either can be empty and both being empty is a real case.
    const name = String(a.sender_name || '').trim();
    const number = String(a.sender_addressing || '').trim();
    out.push({
      handle,
      name,
      number,
      // `subject` is the phone's preview of the body, truncated by the phone.
      preview: String(a.subject || '').trim(),
      at: parseStamp(a.datetime),
      read: a.read === 'yes',
      sent: a.sent === 'yes',
      type: String(a.type || '').trim(),
    });
    if (out.length >= MAX_MESSAGES) break;
  }
  out.sort((x, y) => y.at - x.at);
  return out;
}

// ── bMessage ────────────────────────────────────────────────────────────────

function fieldOf(text, name) {
  const re = new RegExp('^' + name + ':(.*)$', 'im');
  const m = re.exec(text);
  return m ? m[1].trim() : '';
}

// The sender is the vCard BEFORE the envelope: the one inside BENV is the
// recipient, and reading the wrong one puts your own name on every message.
function senderFrom(text) {
  const envAt = text.indexOf('BEGIN:BENV');
  const head = envAt > 0 ? text.slice(0, envAt) : text;
  const card = /BEGIN:VCARD([\s\S]*?)END:VCARD/i.exec(head);
  if (!card) return { name: '', number: '' };
  const body = card[1];
  const fn = /^FN[^:\r\n]*:(.*)$/im.exec(body);
  const n = /^N[^:\r\n]*:(.*)$/im.exec(body);
  const tel = /^TEL[^:\r\n]*:(.*)$/im.exec(body);
  let name = fn ? fn[1].trim() : '';
  if (!name && n) name = n[1].split(';').map(s => s.trim()).filter(Boolean).reverse().join(' ');
  return { name, number: tel ? tel[1].trim() : '' };
}

// Pull the text out. LENGTH first (it is the only thing that survives a body
// containing its own delimiter), then the last END:MSG as the fallback.
function bodyFrom(text) {
  const start = text.indexOf('BEGIN:MSG');
  if (start < 0) return '';

  const declared = Number(fieldOf(text, 'LENGTH'));
  if (Number.isFinite(declared) && declared > 0 && declared < 1024 * 1024) {
    const buf = Buffer.from(text, 'utf8');
    const startBytes = Buffer.byteLength(text.slice(0, start), 'utf8');
    const block = buf.slice(startBytes, startBytes + declared).toString('utf8');
    // Only trusted when the slice really is the whole block: a phone that
    // counts differently must not be allowed to cut a message in half.
    if (/^BEGIN:MSG\r?\n[\s\S]*END:MSG\r?\n?$/.test(block)) {
      return block.replace(/^BEGIN:MSG\r?\n/, '').replace(/\r?\nEND:MSG\r?\n?$/, '');
    }
  }

  const after = text.slice(start + 'BEGIN:MSG'.length).replace(/^\r?\n/, '');
  const bodyEnd = after.lastIndexOf('END:MSG');
  if (bodyEnd < 0) return after.slice(0, MAX_BODY_CHARS);
  return after.slice(0, bodyEnd).replace(/\r?\n$/, '').slice(0, MAX_BODY_CHARS);
}

function parseMessage(bmsg) {
  const text = String(bmsg == null ? '' : bmsg).slice(0, MAX_TEXT);
  if (!/BEGIN:BMSG/i.test(text)) return null;
  const sender = senderFrom(text);
  return {
    name: sender.name,
    number: sender.number,
    body: bodyFrom(text),
    read: /^STATUS:\s*READ/im.test(text),
    folder: fieldOf(text, 'FOLDER'),
    type: fieldOf(text, 'TYPE'),
  };
}

module.exports = {
  parseListing,
  parseMessage,
  // exported for the tests
  decodeEntities,
  validHandle,
  bodyFrom,
  senderFrom,
  MAX_MESSAGES,
};
