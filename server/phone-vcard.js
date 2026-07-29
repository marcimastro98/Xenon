'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// vCard reader for what a paired phone hands over — PURE, no I/O, unit-tested.
//
// The helper does the Bluetooth and returns the phonebook as raw text, exactly
// as the phone wrote it. Parsing lives HERE for the same reason the platform
// collectors keep their parsers in JavaScript: it is the only part of reading a
// phone that can be tested without a phone, and this text arrives from a device
// we do not control, in a format two vendors interpret differently.
//
// Three things the format does that a naive split(':') gets wrong, all of them
// observed on a real iPhone dump rather than read in a spec:
//
//  1. A property name carries PARAMETERS, and one of them is the answer to the
//     most important question here. Call direction is not a field: it is a
//     parameter on the timestamp — `X-IRMC-CALL-DATETIME;RECEIVED:20260729T121505`
//     — so "ricevuta / effettuata / persa" comes out of ONE combined pull
//     instead of four separate ones.
//  2. Long values are FOLDED across lines (continuation starts with a space),
//     and a quoted-printable value folds a second way, with a trailing '='.
//     Both have to be rejoined before the value means anything.
//  3. Accented names arrive quoted-printable-encoded on some phones and plain
//     UTF-8 on others. `Papà` decoded wrong is not a cosmetic bug, it is a
//     contact the user cannot find by typing their own father's name.
//
// Everything here degrades to "skip this entry" rather than throwing: a single
// malformed card in a 233-contact dump must never cost the other 232.
// ─────────────────────────────────────────────────────────────────────────────

// Number identity comes from phone-numbers.js rather than being re-derived
// here. Two spellings of one number must be "the same" for the dedupe below
// and for caller lookup alike: when the two disagreed, a contact stored as
// `+393881156069` and `388 1156069` was listed with its own number twice.
const { matchKey } = require('./phone-numbers.js');

const MAX_ENTRIES = 5000;      // a phonebook, not a database import
const MAX_TEXT = 4 * 1024 * 1024;

// ── Line handling ───────────────────────────────────────────────────────────

// Rejoin folded lines. vCard folds with a leading space or tab; quoted-printable
// values fold by ending the line with '='. Doing only the first is what leaves
// half an accented surname on its own line.
function unfold(text) {
  const raw = String(text == null ? '' : text).slice(0, MAX_TEXT)
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const out = [];
  for (const line of raw) {
    if (out.length && (line.startsWith(' ') || line.startsWith('\t'))) {
      out[out.length - 1] += line.slice(1);
      continue;
    }
    if (out.length && out[out.length - 1].endsWith('=') && isQuotedPrintable(out[out.length - 1])) {
      out[out.length - 1] = out[out.length - 1].slice(0, -1) + line;
      continue;
    }
    out.push(line);
  }
  return out;
}

function isQuotedPrintable(line) {
  const colon = line.indexOf(':');
  const head = colon >= 0 ? line.slice(0, colon) : line;
  return /quoted-printable/i.test(head);
}

// Split `NAME;PARAM=VALUE;FLAG:value` into its three parts. The colon that ends
// the property name is the FIRST one, but a parameter value may be quoted and
// contain one, so quotes are tracked.
function splitLine(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ':' && !inQuotes) {
      return { head: line.slice(0, i), value: line.slice(i + 1) };
    }
  }
  return null;
}

function parseHead(head) {
  const parts = [];
  let current = '';
  let inQuotes = false;
  for (const ch of head) {
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ';' && !inQuotes) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  parts.push(current);

  const name = String(parts[0] || '').trim().toUpperCase();
  const params = [];
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    // A bare parameter (`;RECEIVED`, `;CELL`) is a vCard 2.1 shorthand and is
    // the form the call log actually uses, so it has to be kept as a flag.
    if (eq < 0) params.push({ key: '', value: p.trim().toUpperCase() });
    else params.push({ key: p.slice(0, eq).trim().toUpperCase(), value: p.slice(eq + 1).trim().toUpperCase() });
  }
  return { name, params };
}

function hasFlag(params, flag) {
  return params.some(p => p.value === flag);
}

function paramValue(params, key) {
  const hit = params.find(p => p.key === key);
  return hit ? hit.value : '';
}

// ── Value decoding ──────────────────────────────────────────────────────────

function decodeQuotedPrintable(value, charset) {
  const bytes = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    bytes.push(value.charCodeAt(i) & 0xff);
  }
  const enc = /8859|LATIN/i.test(charset || '') ? 'latin1' : 'utf8';
  try { return Buffer.from(bytes).toString(enc); } catch { return value; }
}

// vCard 3.0 escapes commas, semicolons and newlines inside a value.
function unescapeValue(value) {
  return String(value).replace(/\\([\\,;nN])/g, (_, ch) =>
    (ch === 'n' || ch === 'N') ? '\n' : ch);
}

function decodeValue(value, params) {
  let out = String(value == null ? '' : value);
  const encoding = paramValue(params, 'ENCODING') || (hasFlag(params, 'QUOTED-PRINTABLE') ? 'QUOTED-PRINTABLE' : '');
  if (/QUOTED-PRINTABLE/i.test(encoding)) out = decodeQuotedPrintable(out, paramValue(params, 'CHARSET'));
  return unescapeValue(out).trim();
}

// ── Cards ───────────────────────────────────────────────────────────────────

// Split the dump into cards of decoded properties. Anything outside a
// BEGIN/END pair is ignored rather than guessed at.
function parseCards(text) {
  const cards = [];
  let current = null;
  for (const line of unfold(text)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^BEGIN:VCARD$/i.test(trimmed)) { current = []; continue; }
    if (/^END:VCARD$/i.test(trimmed)) {
      if (current) cards.push(current);
      current = null;
      if (cards.length >= MAX_ENTRIES) break;
      continue;
    }
    if (!current) continue;
    const split = splitLine(line);
    if (!split) continue;
    const { name, params } = parseHead(split.head);
    if (!name) continue;
    current.push({ name, params, value: decodeValue(split.value, params) });
  }
  return cards;
}

function propsNamed(card, name) {
  return card.filter(p => p.name === name || p.name.endsWith('.' + name));
}

function firstValue(card, name) {
  const hit = propsNamed(card, name)[0];
  return hit ? hit.value : '';
}

// FN when the phone sent one, otherwise assembled from the structured N.
// Both can be empty and that is a real case: a number with no contact.
function displayName(card) {
  const fn = firstValue(card, 'FN');
  if (fn) return fn.replace(/\s+/g, ' ').trim();
  const n = firstValue(card, 'N');
  if (!n) return '';
  const [family = '', given = '', middle = ''] = n.split(';');
  return [given, middle, family].map(s => s.trim()).filter(Boolean).join(' ');
}

// The phone tags a number with what it is. The tag is a bare vCard 2.1 flag on
// every dump seen, so it is read as a flag before falling back to TYPE=.
const NUMBER_KINDS = ['CELL', 'HOME', 'WORK', 'MAIN', 'FAX', 'PAGER', 'IPHONE', 'OTHER'];

function numberKind(params) {
  for (const kind of NUMBER_KINDS) if (hasFlag(params, kind)) return kind.toLowerCase();
  const type = paramValue(params, 'TYPE');
  if (type) {
    for (const kind of NUMBER_KINDS) if (type.split(',').includes(kind)) return kind.toLowerCase();
  }
  return '';
}

// ── Public: contacts ────────────────────────────────────────────────────────

function parseContacts(text) {
  const out = [];
  for (const card of parseCards(text)) {
    const numbers = [];
    const seen = new Set();
    for (const tel of propsNamed(card, 'TEL')) {
      const value = tel.value.replace(/\s+/g, ' ').trim();
      if (!value) continue;
      // The same number often appears twice with different tags (+39348... and
      // 348...). Keep the first spelling and drop the duplicate rather than
      // showing the user one contact with the same number listed twice.
      const key = matchKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      numbers.push({ value, kind: numberKind(tel.params) });
    }
    const name = displayName(card);
    if (!name && !numbers.length) continue;
    const emails = propsNamed(card, 'EMAIL').map(e => e.value).filter(Boolean).slice(0, 4);
    out.push({ name, numbers, emails });
  }
  return out;
}

// ── Public: call log ────────────────────────────────────────────────────────

// The parameter on the timestamp, mapped to what the UI says. `book` is the
// phonebook object the dump came from and wins when the phone tagged nothing:
// a pull of ich.vcf is by definition incoming even if the entry is bare.
const DIRECTION_FLAGS = [
  ['MISSED', 'missed'],
  ['RECEIVED', 'in'],
  ['DIALED', 'out'],
];

const BOOK_DIRECTION = { ich: 'in', och: 'out', mch: 'missed' };

function callDirection(params, book) {
  for (const [flag, dir] of DIRECTION_FLAGS) if (hasFlag(params, flag)) return dir;
  const type = paramValue(params, 'TYPE');
  if (type) {
    for (const [flag, dir] of DIRECTION_FLAGS) if (type.split(',').includes(flag)) return dir;
  }
  return BOOK_DIRECTION[String(book || '').toLowerCase()] || '';
}

// `20260729T121505` is LOCAL time on the phone; the same string with a trailing
// Z is UTC. Reading the first as UTC shifts every call in the list by the
// timezone offset, which looks like a bug in the clock rather than in a parser.
function parseStamp(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(String(raw || '').trim());
  if (!m) return 0;
  const [, y, mo, d, h, mi, s, z] = m;
  const parts = [Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)];
  const ms = z ? Date.UTC(...parts) : new Date(...parts).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function parseCallLog(text, book) {
  const out = [];
  for (const card of parseCards(text)) {
    const stampProp = propsNamed(card, 'X-IRMC-CALL-DATETIME')[0];
    const number = (propsNamed(card, 'TEL')[0] || {}).value || '';
    const name = displayName(card);
    if (!number && !name) continue;
    out.push({
      name,
      number: number.replace(/\s+/g, ' ').trim(),
      at: stampProp ? parseStamp(stampProp.value) : 0,
      direction: stampProp ? callDirection(stampProp.params, book) : (BOOK_DIRECTION[String(book || '').toLowerCase()] || ''),
    });
  }
  // Newest first. The phone usually sends them that way already; sorting makes
  // the widget independent of whether it did.
  out.sort((a, b) => b.at - a.at);
  return out;
}

module.exports = {
  parseContacts,
  parseCallLog,
  // exported for the tests: each is a place a real dump has surprised us
  parseCards,
  unfold,
  splitLine,
  parseHead,
  decodeValue,
  displayName,
  callDirection,
  parseStamp,
  MAX_ENTRIES,
};
