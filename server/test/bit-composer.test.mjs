// Bit's composer has one main button (js/bit-composer.js + AIPanel.css): it
// dictates while there is nothing to send, sends once there is, stops a reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasDraft } = require('../js/bit-composer.js');
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('a draft is text that is not only spaces, or an attachment waiting', () => {
  assert.equal(hasDraft('', 0), false);
  assert.equal(hasDraft('   \n', 0), false);
  assert.equal(hasDraft(null, undefined), false);
  assert.equal(hasDraft('ciao', 0), true);
  assert.equal(hasDraft('', 1), true, 'a photo alone can be sent');
});

test('the CSS shows one button at a time: dictate, send, or stop', () => {
  const css = read('../components/AIPanel/AIPanel.css');
  assert.match(css, /\.ai-input-row:has\(\.ai-dictate-btn\):not\(\.has-draft\) \.ai-send-btn[^{]*\{[^}]*display: ?none/);
  assert.match(css, /\.ai-input-row\.has-draft \.ai-dictate-btn[^{]*\{[^}]*display: ?none/);
  assert.match(css, /body\.ai-turn-running \.ai-input-row \.ai-dictate-btn[^{]*\{[^}]*display: ?none/);
  // While a reply runs the field is empty: the stop has to beat the no-draft rule.
  assert.match(css, /body\.ai-turn-running \.ai-input-row:has\(\.ai-dictate-btn\):not\(\.has-draft\) \.ai-send-btn \{\s*display: grid/);
});

test('every place that fills or clears the field keeps the button in step', () => {
  const ai = read('../js/ai.js');
  assert.ok((ai.match(/BitComposer\.sync\(\)/g) || []).length >= 3, 'send, attachments and dictation');
  assert.match(read('../js/media.js'), /input\.value = '';[\s\S]{0,120}BitComposer\.sync\(\)/, 'a chat copy too');
  const html = read('../index.html');
  assert.doesNotMatch(html, /class="[^"]*ai-talk-btn/, 'the voice session stays on the top bar');
  assert.match(html, /class="[^"]*ai-dictate-btn[^"]*"[^>]*onclick="aiDictateToggle\(\)"|onclick="aiDictateToggle\(\)"[^>]*class="[^"]*ai-dictate-btn/);
});
