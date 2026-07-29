import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const msgs = require('../phone-messages.js');

// The listing and the bMessage below are verbatim captures from a paired
// iPhone. They are here rather than invented because both formats have a detail
// that only a real device shows you: the listing puts everything in attributes
// and truncates the body into `subject`, and the message carries a LENGTH that
// is the only defence against a body containing its own delimiter.

const LISTING = '<MAP-msg-listing version="1.0">'
  + '<msg handle="1000000000000A1" subject="NON CONDIVIDERE. Codice attivazione: 123456" '
  + 'datetime="20260528T172938" sender_name="Banca Dem" sender_addressing="Banca Dem" '
  + 'recipient_name="" recipient_addressing="" type="SMS_GSM" size="155" '
  + 'reception_status="complete" text="yes" attachment_size="0" read="yes" sent="no" />'
  + '<msg handle="1000000000000B2" subject="Con NegozioPay gestisci le spese come vuoi tu!" '
  + 'datetime="20260517T143837" sender_name="NEGOZIO" sender_addressing="NEGOZIO" '
  + 'type="SMS_GSM" read="no" sent="no" />'
  + '</MAP-msg-listing>';

const BMESSAGE = [
  'BEGIN:BMSG', 'VERSION:1.0', 'STATUS:READ', 'TYPE:SMS_GSM',
  'FOLDER:telecom/msg/inbox', 'NOTIFICATION:1',
  'BEGIN:VCARD', 'VERSION:2.1', 'FN;CHARSET=UTF-8:Banca Dem', 'N;CHARSET=UTF-8:Banca Dem',
  'TEL:12345 737', 'END:VCARD',
  'BEGIN:BENV',
  'BEGIN:VCARD', 'VERSION:2.1', 'N;CHARSET=UTF-8:', 'TEL;CHARSET=UTF-8:', 'END:VCARD',
  'BEGIN:BBODY', 'CHARSET:UTF-8', 'LANGUAGE:UNKNOWN', 'LENGTH:177',
  'BEGIN:MSG',
  'NON CONDIVIDERE. Codice attivazione: 123456 per aggiungere carta Banca Demo Spa 0000 a Apple Wallet. Nessuno chiederà mai questo codice. Valido per 5 min.',
  'END:MSG',
  'END:BBODY', 'END:BENV', 'END:BMSG', '',
].join('\r\n');

test('a real listing parses into sender, time and read state', () => {
  const list = msgs.parseListing(LISTING);
  assert.equal(list.length, 2);
  assert.equal(list[0].handle, '1000000000000A1');
  assert.equal(list[0].name, 'Banca Dem');
  assert.equal(list[0].read, true);
  assert.equal(list[0].sent, false);
  assert.equal(list[0].at, new Date(2026, 4, 28, 17, 29, 38).getTime());
  // Newest first, whatever order the phone sent them in.
  assert.ok(list[0].at > list[1].at);
  assert.equal(list[1].read, false);
});

test('a real message yields its sender and its whole text', () => {
  const m = msgs.parseMessage(BMESSAGE);
  assert.equal(m.name, 'Banca Dem');
  assert.equal(m.number, '12345 737');
  assert.equal(m.read, true);
  assert.equal(m.folder, 'telecom/msg/inbox');
  assert.match(m.body, /^NON CONDIVIDERE/);
  assert.match(m.body, /Valido per 5 min\.$/);
  assert.ok(!m.body.includes('END:MSG'), 'the delimiter is never part of the text');
});

test('the sender is the vCard OUTSIDE the envelope, not the recipient', () => {
  // The one inside BENV is who it was sent TO. Reading that one puts your own
  // details on every message in the inbox.
  const s = msgs.senderFrom(BMESSAGE);
  assert.equal(s.name, 'Banca Dem');
  assert.equal(s.number, '12345 737');
});

test('a body containing END:MSG survives, because LENGTH is honoured', () => {
  const text = 'Copia questo blocco:\r\nEND:MSG\r\ne rimandamelo';
  const block = 'BEGIN:MSG\r\n' + text + '\r\nEND:MSG\r\n';
  const bmsg = 'BEGIN:BMSG\r\nVERSION:1.0\r\nSTATUS:UNREAD\r\nTYPE:SMS_GSM\r\n'
    + 'BEGIN:VCARD\r\nFN:Tester\r\nTEL:+393331112222\r\nEND:VCARD\r\n'
    + 'BEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:' + Buffer.byteLength(block, 'utf8') + '\r\n'
    + block + 'END:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n';
  assert.equal(msgs.parseMessage(bmsg).body, text);
});

test('a wrong LENGTH falls back to the delimiter instead of cutting the text', () => {
  const bmsg = 'BEGIN:BMSG\r\nVERSION:1.0\r\nTYPE:SMS_GSM\r\n'
    + 'BEGIN:VCARD\r\nFN:Tester\r\nEND:VCARD\r\n'
    + 'BEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:4\r\n'
    + 'BEGIN:MSG\r\nUn messaggio intero\r\nEND:MSG\r\nEND:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n';
  assert.equal(msgs.parseMessage(bmsg).body, 'Un messaggio intero');
});

test('multi-byte characters do not shift the LENGTH slice', () => {
  // LENGTH counts BYTES; slicing by characters puts the end of an accented
  // message in the wrong place, which is invisible until somebody writes in
  // Italian.
  const text = 'Perché è già così, ciao 👋';
  const block = 'BEGIN:MSG\r\n' + text + '\r\nEND:MSG\r\n';
  const bmsg = 'BEGIN:BMSG\r\nVERSION:1.0\r\nTYPE:SMS_GSM\r\n'
    + 'BEGIN:VCARD\r\nFN:Amore\r\nTEL:+393331230166\r\nEND:VCARD\r\n'
    + 'BEGIN:BENV\r\nBEGIN:BBODY\r\nCHARSET:UTF-8\r\nLENGTH:' + Buffer.byteLength(block, 'utf8') + '\r\n'
    + block + 'END:BBODY\r\nEND:BENV\r\nEND:BMSG\r\n';
  assert.equal(msgs.parseMessage(bmsg).body, text);
});

test('XML entities in a subject are decoded, not left half-read', () => {
  const xml = '<MAP-msg-listing><msg handle="AB12" subject="Tom &amp; Jerry &lt;3 &#39;ciao&#39; &#x1F600;" '
    + 'datetime="20260101T101010" sender_name="Anna &amp; Co" type="SMS_GSM" read="no" sent="no" /></MAP-msg-listing>';
  const [m] = msgs.parseListing(xml);
  assert.equal(m.preview, "Tom & Jerry <3 'ciao' 😀");
  assert.equal(m.name, 'Anna & Co');
});

test('a handle that is not a handle is dropped, never passed back to the phone', () => {
  const bad = '<msg handle="../../etc/passwd" subject="x" datetime="20260101T101010" />'
    + '<msg handle="" subject="y" datetime="20260101T101010" />'
    + '<msg handle="ZZZZ" subject="z" datetime="20260101T101010" />'
    + '<msg handle="00FF" subject="ok" datetime="20260101T101010" />';
  const list = msgs.parseListing(bad);
  assert.deepEqual(list.map(m => m.handle), ['00FF']);
});

test('junk and empty input answer empty, never throw', () => {
  assert.deepEqual(msgs.parseListing(''), []);
  assert.deepEqual(msgs.parseListing(null), []);
  assert.deepEqual(msgs.parseListing('non xml'), []);
  assert.equal(msgs.parseMessage(''), null);
  assert.equal(msgs.parseMessage('non un bmessage'), null);
  assert.equal(msgs.parseMessage('BEGIN:BMSG\r\nEND:BMSG\r\n').body, '');
});

test('the listing cap holds', () => {
  const one = '<msg handle="AB12" subject="x" datetime="20260101T101010" />';
  assert.equal(msgs.parseListing(one.repeat(msgs.MAX_MESSAGES + 40)).length, msgs.MAX_MESSAGES);
});
