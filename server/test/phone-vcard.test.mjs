import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const vcard = require('../phone-vcard.js');

// These fixtures are not invented. The first block is a verbatim capture from a
// paired iPhone through the helper's phone-serve mode, emoji, accents and empty
// cards included, because every one of those broke something while this parser
// was being written. The synthetic blocks below cover the shapes other phones
// are documented to send and that an iPhone happens not to.

const REAL_CALL_LOG = [
  'BEGIN:VCARD',
  'VERSION:2.1',
  'FN;CHARSET=UTF-8:Gabriele Ponzio',
  'N;CHARSET=UTF-8:Ponzio;Gabriele',
  'TEL;TYPE=CELL:+393203465082',
  'UID:2a',
  'X-IRMC-CALL-DATETIME;RECEIVED:20260729T121505',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:2.1',
  'FN;CHARSET=UTF-8:Amore🐔',
  'N;CHARSET=UTF-8:;Amore🐔',
  'TEL;TYPE=CELL:+393463331166',
  'EMAIL;CHARSET=UTF-8;TYPE=INTERNET:nadiuccia21@hotmail.it',
  'UID:10b5',
  'X-IRMC-CALL-DATETIME;RECEIVED:20260728T213634',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:2.1',
  'FN;CHARSET=UTF-8:Papà',
  'N;CHARSET=UTF-8:;Papà',
  'TEL;TYPE=CELL:+393402641223',
  'UID:f',
  'X-IRMC-CALL-DATETIME;DIALED:20260728T190557',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:2.1',
  'FN;CHARSET=UTF-8:',
  'N;CHARSET=UTF-8:',
  'TEL:+393287248309',
  'X-IRMC-CALL-DATETIME;MISSED:20260727T152350',
  'END:VCARD',
  '',
].join('\r\n');

test('a real call log parses into names, numbers, times and direction', () => {
  const rows = vcard.parseCallLog(REAL_CALL_LOG, 'cch');
  assert.equal(rows.length, 4);

  // Newest first, whatever order the phone sent.
  assert.equal(rows[0].name, 'Gabriele Ponzio');
  assert.equal(rows[0].number, '+393203465082');
  assert.equal(rows[0].direction, 'in');
  assert.equal(rows[0].at, new Date(2026, 6, 29, 12, 15, 5).getTime());

  assert.equal(rows[1].name, 'Amore🐔');
  assert.equal(rows[2].name, 'Papà');
  assert.equal(rows[2].direction, 'out');

  // A number with no contact behind it is a real row, not a parse failure.
  assert.equal(rows[3].name, '');
  assert.equal(rows[3].number, '+393287248309');
  assert.equal(rows[3].direction, 'missed');
});

test('direction is read from the timestamp parameter, not from the book', () => {
  // The parameter has to win: a combined pull (cch) contains all three kinds,
  // so trusting the book there would label every call incoming.
  const rows = vcard.parseCallLog(REAL_CALL_LOG, 'cch');
  assert.deepEqual(rows.map(r => r.direction), ['in', 'in', 'out', 'missed']);
});

test('the book names the direction only when the phone tagged nothing', () => {
  const bare = [
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Senza tag', 'TEL:+393331112222',
    'X-IRMC-CALL-DATETIME:20260101T101010', 'END:VCARD', '',
  ].join('\r\n');
  assert.equal(vcard.parseCallLog(bare, 'och')[0].direction, 'out');
  assert.equal(vcard.parseCallLog(bare, 'mch')[0].direction, 'missed');
  assert.equal(vcard.parseCallLog(bare, 'cch')[0].direction, '');
});

test('a timestamp is local unless it says otherwise', () => {
  // Reading a local stamp as UTC shifts the whole list by the timezone offset,
  // which reads as a broken clock rather than a broken parser.
  assert.equal(vcard.parseStamp('20260729T121505'), new Date(2026, 6, 29, 12, 15, 5).getTime());
  assert.equal(vcard.parseStamp('20260729T121505Z'), Date.UTC(2026, 6, 29, 12, 15, 5));
  assert.equal(vcard.parseStamp('non una data'), 0);
  assert.equal(vcard.parseStamp(''), 0);
});

test('contacts keep every distinct number and drop the redundant spelling', () => {
  const dump = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN:Ale Paglia',
    'N:Paglia;Ale',
    'TEL;CELL:+393881156069',
    'TEL;HOME:388 1156069',
    'TEL;WORK:+390612345678',
    'END:VCARD', '',
  ].join('\r\n');
  const [contact] = vcard.parseContacts(dump);
  assert.equal(contact.name, 'Ale Paglia');
  // The first two are the same number written twice; the third is not.
  assert.equal(contact.numbers.length, 2);
  assert.equal(contact.numbers[0].value, '+393881156069');
  assert.equal(contact.numbers[0].kind, 'cell');
  assert.equal(contact.numbers[1].value, '+390612345678');
  assert.equal(contact.numbers[1].kind, 'work');
});

test('a name is assembled from N when the phone sent no FN', () => {
  const dump = [
    'BEGIN:VCARD', 'VERSION:3.0', 'N:Rossi;Marco;;;', 'TEL:+393331112222', 'END:VCARD', '',
  ].join('\r\n');
  assert.equal(vcard.parseContacts(dump)[0].name, 'Marco Rossi');
});

test('quoted-printable accents survive, including the soft line break', () => {
  // Android phones send this shape; getting it wrong means the user cannot find
  // their own father by typing his name. The break falls AFTER a complete
  // escape, which is where a correct encoder puts it: a trailing '=' swallows
  // the newline, so breaking inside '=A0' would destroy the character.
  const dump = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Pap=C3=A0 Salvatore Mastro=',
    'eni',
    'TEL;CELL:+393402641223',
    'END:VCARD', '',
  ].join('\r\n');
  assert.equal(vcard.parseContacts(dump)[0].name, 'Papà Salvatore Mastroeni');
});

test('a folded line is rejoined without inventing a space', () => {
  // Unfolding removes the single leading whitespace, so an encoder that wants a
  // space at the join writes two. Adding one back would put a space inside
  // names that never had one.
  const dump = [
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN:Alberto Carocci Padrone',
    '  Di Casa',
    'TEL:+393382851697',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:2.1',
    'FN:Costantino',
    ' poli',
    'TEL:+393382851698',
    'END:VCARD', '',
  ].join('\r\n');
  const contacts = vcard.parseContacts(dump);
  assert.equal(contacts[0].name, 'Alberto Carocci Padrone Di Casa');
  assert.equal(contacts[1].name, 'Costantinopoli');
});

test('vCard 3.0 escapes are undone', () => {
  const dump = [
    'BEGIN:VCARD', 'VERSION:3.0', 'FN:Studio Rossi\\, Bianchi', 'TEL:+390612345678', 'END:VCARD', '',
  ].join('\r\n');
  assert.equal(vcard.parseContacts(dump)[0].name, 'Studio Rossi, Bianchi');
});

test('one broken card never costs the others', () => {
  const dump = [
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Primo', 'TEL:+393331112222', 'END:VCARD',
    'BEGIN:VCARD', 'questa riga non ha i due punti', 'END:VCARD',
    'BEGIN:VCARD', 'VERSION:2.1', 'FN:Terzo', 'TEL:+393334445555', 'END:VCARD', '',
  ].join('\r\n');
  const contacts = vcard.parseContacts(dump);
  assert.deepEqual(contacts.map(c => c.name), ['Primo', 'Terzo']);
});

test('empty and junk input answer with an empty list, never a throw', () => {
  assert.deepEqual(vcard.parseContacts(''), []);
  assert.deepEqual(vcard.parseContacts(null), []);
  assert.deepEqual(vcard.parseCallLog('non una vcard', 'cch'), []);
  assert.deepEqual(vcard.parseContacts('BEGIN:VCARD\r\nFN:Mai chiuso\r\n'), []);
});

test('the entry cap holds', () => {
  const one = 'BEGIN:VCARD\r\nVERSION:2.1\r\nFN:X\r\nTEL:+3933311122\r\nEND:VCARD\r\n';
  const huge = one.repeat(vcard.MAX_ENTRIES + 50);
  assert.equal(vcard.parseContacts(huge).length, vcard.MAX_ENTRIES);
});

test('a parameter value containing a colon does not split the line early', () => {
  const line = 'X-THING;NOTE="a:b":il valore';
  const split = vcard.splitLine(line);
  assert.equal(split.value, 'il valore');
  assert.equal(vcard.parseHead(split.head).name, 'X-THING');
});
