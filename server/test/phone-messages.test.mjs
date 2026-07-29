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
  + '<msg handle="1105E1CFB1C989E" subject="NON CONDIVIDERE. Codice attivazione: 395721" '
  + 'datetime="20260728T192938" sender_name="Trade Rep" sender_addressing="Trade Rep" '
  + 'recipient_name="" recipient_addressing="" type="SMS_GSM" size="155" '
  + 'reception_status="complete" text="yes" attachment_size="0" read="yes" sent="no" />'
  + '<msg handle="4A888744BF32658" subject="Con Agospay gestisci le spese come vuoi tu!" '
  + 'datetime="20260717T163837" sender_name="AGOS" sender_addressing="AGOS" '
  + 'type="SMS_GSM" read="no" sent="no" />'
  + '</MAP-msg-listing>';

const BMESSAGE = [
  'BEGIN:BMSG', 'VERSION:1.0', 'STATUS:READ', 'TYPE:SMS_GSM',
  'FOLDER:telecom/msg/inbox', 'NOTIFICATION:1',
  'BEGIN:VCARD', 'VERSION:2.1', 'FN;CHARSET=UTF-8:Trade Rep', 'N;CHARSET=UTF-8:Trade Rep',
  'TEL:87233 737', 'END:VCARD',
  'BEGIN:BENV',
  'BEGIN:VCARD', 'VERSION:2.1', 'N;CHARSET=UTF-8:', 'TEL;CHARSET=UTF-8:', 'END:VCARD',
  'BEGIN:BBODY', 'CHARSET:UTF-8', 'LANGUAGE:UNKNOWN', 'LENGTH:177',
  'BEGIN:MSG',
  'NON CONDIVIDERE. Codice attivazione: 395721 per aggiungere carta Trade Republic 3961 a Apple Wallet. Nessuno chiederà mai questo codice. Valido per 5 min.',
  'END:MSG',
  'END:BBODY', 'END:BENV', 'END:BMSG', '',
].join('\r\n');

test('a real listing parses into sender, time and read state', () => {
  const list = msgs.parseListing(LISTING);
  assert.equal(list.length, 2);
  assert.equal(list[0].handle, '1105E1CFB1C989E');
  assert.equal(list[0].name, 'Trade Rep');
  assert.equal(list[0].read, true);
  assert.equal(list[0].sent, false);
  assert.equal(list[0].at, new Date(2026, 6, 28, 19, 29, 38).getTime());
  // Newest first, whatever order the phone sent them in.
  assert.ok(list[0].at > list[1].at);
  assert.equal(list[1].read, false);
});

test('a real message yields its sender and its whole text', () => {
  const m = msgs.parseMessage(BMESSAGE);
  assert.equal(m.name, 'Trade Rep');
  assert.equal(m.number, '87233 737');
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
  assert.equal(s.name, 'Trade Rep');
  assert.equal(s.number, '87233 737');
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
    + 'BEGIN:VCARD\r\nFN:Amore\r\nTEL:+393463331166\r\nEND:VCARD\r\n'
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

// ── obexd's container ──────────────────────────────────────────────────────
// On Linux, BlueZ has already parsed the listing above and hands back D-Bus
// property dictionaries. Same messages, different container, so the widget must
// receive the identical shape either way.

const OBEX_ROWS = [
  ['/org/bluez/obex/client/session0/message0', {
    Subject: { type: 's', data: 'NON CONDIVIDERE. Codice attivazione: 395721' },
    Timestamp: { type: 's', data: '20260728T192938' },
    Sender: { type: 's', data: 'Trade Rep' },
    SenderAddress: { type: 's', data: '87233737' },
    Read: { type: 'b', data: true },
    Sent: { type: 'b', data: false },
    Type: { type: 's', data: 'sms-gsm' },
  }],
  ['/org/bluez/obex/client/session0/message1', {
    Subject: { type: 's', data: 'Con Agospay gestisci le spese come vuoi tu!' },
    Timestamp: { type: 's', data: '20260717T163837' },
    Sender: { type: 's', data: 'AGOS' },
    Read: { type: 'b', data: false },
    Sent: { type: 'b', data: false },
  }],
];

test('obexd rows produce the same shape the XML listing does', () => {
  const list = msgs.parseObexMessages(OBEX_ROWS);
  const fromXml = msgs.parseListing(LISTING);
  assert.deepEqual(Object.keys(list[0]).sort(), Object.keys(fromXml[0]).sort(),
    'the widget renders one shape; the transport it came from must not show');
  assert.equal(list[0].name, 'Trade Rep');
  assert.equal(list[0].number, '87233737');
  assert.equal(list[0].read, true);
  assert.equal(list[0].at, new Date(2026, 6, 28, 19, 29, 38).getTime());
  assert.equal(list[1].read, false);
  // Newest first, like the other one.
  assert.ok(list[0].at > list[1].at);
});

test('the obexd handle is the object path, which is what identifies it there', () => {
  assert.equal(msgs.parseObexMessages(OBEX_ROWS)[0].handle, '/org/bluez/obex/client/session0/message0');
});

test('obexd rows that are not rows are skipped, never thrown on', () => {
  assert.deepEqual(msgs.parseObexMessages(null), []);
  assert.deepEqual(msgs.parseObexMessages([null, 'x', [], [42, {}], ['not-a-path', {}]]), []);
  // A row with nothing in it at all carries no message.
  assert.deepEqual(msgs.parseObexMessages([['/m0', {}]]), []);
});

test('a composed bMessage round-trips through our own reader', () => {
  // The envelope is the one thing here with no phone to check it, so the test
  // is that the format we WRITE is the format we can READ.
  const text = 'Ciao, arrivo tra 10 minuti. Perché è così?';
  const built = msgs.buildBMessage('+393463331166', text);
  const out = msgs.parseMessage(built);
  assert.equal(out.body, text);
  assert.equal(out.folder, 'telecom/msg/outbox');
  assert.equal(out.read, false, 'a message being sent is not a read one');

  // And the asymmetry that is easy to read as a bug and is not: a message we
  // COMPOSED has no sender, it has a recipient, and the recipient lives inside
  // BENV. senderFrom deliberately refuses to look there — doing otherwise is
  // what would put the user's own details on every message in their inbox.
  assert.equal(out.number, '', 'an outgoing message has no sender to read');
  assert.match(built, /BEGIN:BENV[\s\S]*TEL:\+393463331166/, 'the recipient is in the envelope');
});

test('a composed bMessage counts LENGTH in bytes, not characters', () => {
  const text = 'àèìòù 👋';
  const built = msgs.buildBMessage('+390612345678', text);
  const declared = Number(/^LENGTH:(\d+)$/m.exec(built)[1]);
  const block = 'BEGIN:MSG\r\n' + text + '\r\nEND:MSG\r\n';
  assert.equal(declared, Buffer.byteLength(block, 'utf8'));
  assert.equal(msgs.parseMessage(built).body, text);
});
