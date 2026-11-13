import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { appStringsSource } from './i18n-source.mjs';

const require = createRequire(import.meta.url);
const C = require('../js/ai-reply-choices.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('trailing [[answer]] lines come off the text as choices', () => {
  const r = C.split('Di che colore lo vuoi?\n[[Blu]]\n[[Verde]]\n[[Come il tema]]\n');
  assert.equal(r.text, 'Di che colore lo vuoi?');
  assert.deepEqual(r.choices, ['Blu', 'Verde', 'Come il tema']);
});

test('a reply without choice lines is left as it is', () => {
  assert.deepEqual(C.split('Fatto, il widget è sulla pagina.'), { text: 'Fatto, il widget è sulla pagina.', choices: [] });
  assert.deepEqual(C.split(''), { text: '', choices: [] });
  assert.deepEqual(C.split(undefined), { text: '', choices: [] });
});

test('only the trailing block counts, not brackets in the middle', () => {
  const r = C.split('Scrivi [[nome]] nel campo.\nPoi premi salva.');
  assert.deepEqual(r.choices, []);
  const mid = C.split('[[A]]\nTesto in mezzo\n[[Sì]]\n[[No]]');
  assert.equal(mid.text, '[[A]]\nTesto in mezzo');
  assert.deepEqual(mid.choices, ['Sì', 'No']);
});

test('more than the maximum is not turned into buttons', () => {
  const many = 'Quale?\n' + ['a', 'b', 'c', 'd', 'e'].map((x) => `[[${x}]]`).join('\n');
  assert.equal(C.MAX_CHOICES, 4);
  assert.deepEqual(C.split(many), { text: many, choices: [] });
});

test('duplicates collapse and over-long lines are not choices', () => {
  assert.deepEqual(C.split('Ok?\n[[Sì]]\n[[Sì]]\n[[No]]').choices, ['Sì', 'No']);
  assert.deepEqual(C.split('Ok?\n[[' + 'x'.repeat(61) + ']]').choices, []);
});

test('voice hears the choices as a list, never the brackets', () => {
  assert.equal(C.spoken('Lo vuoi grande?\n[[Sì]]\n[[No]]'), 'Lo vuoi grande? Sì, No.');
  assert.equal(C.spoken('Premi [[Salva]] in basso.'), 'Premi Salva in basso.');
  assert.equal(C.spoken('Nessuna domanda.'), 'Nessuna domanda.');
});

test('the chat renders choices as buttons, delegated, and any new message retires them', () => {
  const ai = read('../js/ai.js');
  assert.match(ai, /AiReplyChoices\.split\(text\)/);
  assert.match(ai, /btn\.className = 'ai-choice'/);
  assert.match(ai, /btn\.textContent = c;/, 'choices are untrusted text: textContent, never innerHTML');
  assert.match(ai, /document\.addEventListener\('click', _aiHandleChoiceClick\)/, 'delegated so chat mirrors work');
  const send = ai.slice(ai.indexOf('async function aiSendMessage('), ai.indexOf('async function aiSendMessage(') + 900);
  assert.match(send, /_aiClearChoices\(\);/);
  assert.match(ai, /_aiSpeak\(spokenReply,/);
  assert.match(ai, /const said = window\.AiReplyChoices \? AiReplyChoices\.spoken\(text\) : text;/);
});

test('the page loads the helper before ai.js and styles touch-sized choices', () => {
  const html = read('../index.html');
  const helper = html.indexOf('<script src="js/ai-reply-choices.js"></script>');
  assert.ok(helper > 0 && helper < html.indexOf('<script src="js/ai.js"></script>'));
  const css = read('../components/AIPanel/AIPanel.css');
  assert.match(css, /\.ai-choice \{[^}]*min-height: 44px;/);
});

test('the text prompt asks for [[answer]] lines only on a real question', () => {
  const server = read('../server.js');
  const line = server.slice(server.indexOf('const SYS_TEXT ='), server.indexOf('const SYS_LANG ='));
  assert.match(line, /\[\[answer\]\]/);
  assert.match(line, /2 to 4 short answers/);
  assert.match(line, /ask only when the answer changes what you do/);
  // Next steps only after an action, two at most, never the generic kind.
  assert.match(line, /actually DID something/);
  assert.match(line, /at most 2 concrete next steps/);
  assert.match(line, /never after a plain answer/);
  const voice = server.slice(server.indexOf('const SYS_VOICE ='), server.indexOf('const SYS_AUDIO ='));
  assert.doesNotMatch(voice, /\[\[/, 'voice never gets the bracket format');
});

test('a real alternative carries what it means, and the label alone is the answer', () => {
  const r = C.split('Quale tema intendi?\n[[Quello attuale | Parto da questo]]\n[[Uno dello Store|Dimmi il nome]]\n[[Uno nuovo]]');
  assert.equal(r.text, 'Quale tema intendi?');
  assert.deepEqual(r.choices, ['Quello attuale', 'Uno dello Store', 'Uno nuovo']);
  assert.deepEqual(r.notes, ['Parto da questo', 'Dimmi il nome', '']);
});

test('plain answers stay plain: no notes, so no question card on a yes or no', () => {
  assert.equal('notes' in C.split('Lo elimino?\n[[Sì]]\n[[No]]'), false);
});

test('a label over the limit is no choice, even with a note after it', () => {
  const long = 'x'.repeat(61);
  assert.deepEqual(C.split(`Quale?\n[[${long} | nota]]`).choices, []);
});

test('in voice only the labels are read, never the notes or the bar', () => {
  assert.equal(C.spoken('Quale?\n[[Analogico | Con le lancette]]\n[[Digitale | A cifre]]'), 'Quale? Analogico, Digitale.');
  assert.equal(C.spoken('Scrivi [[nome | nota]] qui.'), 'Scrivi nome qui.');
});

test('the keys of the question card', () => {
  assert.deepEqual(C.keyAction('2', 3), { pick: 1 });
  assert.deepEqual(C.keyAction('4', 3), { own: true });
  assert.equal(C.keyAction('5', 3), null);
  assert.equal(C.keyAction('0', 3), null);
  assert.deepEqual(C.keyAction('Escape', 3), { leave: true });
  assert.deepEqual(C.keyAction('ArrowDown', 3), { move: 1 });
  assert.deepEqual(C.keyAction('ArrowUp', 3), { move: -1 });
  assert.deepEqual(C.keyAction('a', 3), { type: true });
  assert.equal(C.keyAction('Enter', 3), null);
  assert.equal(C.keyAction('Tab', 3), null);
});

test('the question card loads on every surface, says its words in all 11 languages, and Bit knows the format', () => {
  assert.match(read('../index.html'), /<script src="js\/ai-ask-card\.js"><\/script>/);
  assert.match(read('../js/screen-bit.js'), /'js\/ai-ask-card\.js'/);
  const i18n = appStringsSource();
  for (const key of ['ai_ask_label', 'ai_ask_own', 'ai_ask_leave', 'ai_ask_pick']) {
    assert.equal(i18n.match(new RegExp(`\\b${key}:`, 'g'))?.length, 11, key);
  }
  assert.match(read('../server.js'), /\[\[answer \| what it means\]\]/);
});

test('several choices on one last line are buttons too', () => {
  const r = C.split('Vuoi un profilo nuovo?\n\n[[Crea profilo Replay]] [[Lo aggiungo io a mano]]');
  assert.deepEqual(r.choices, ['Crea profilo Replay', 'Lo aggiungo io a mano']);
  assert.equal(r.text, 'Vuoi un profilo nuovo?');
  // Mixed with other words the line stays text.
  const mixed = C.split('Scegli [[A]] oppure [[B]]');
  assert.deepEqual(mixed.choices, []);
  // More than the limit across one line are not buttons.
  assert.deepEqual(C.split('Quale?\n[[1]] [[2]] [[3]] [[4]] [[5]]').choices, []);
});

test('a row of choices is spoken as a list, without brackets', () => {
  assert.equal(C.spoken('Quale?\n[[Uno]] [[Due]]'), 'Quale? Uno, Due.');
});
