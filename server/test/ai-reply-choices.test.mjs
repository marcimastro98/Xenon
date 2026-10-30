import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

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
