// The Settings header (SettingsModal.css, XenonCredits.css). The panel is as wide
// as the window, so the header reacts to its own width, not the screen's:
//  - the Scintille chip drops its word before the title is squeezed;
//  - the Store pill is its icon alone on a phone-width header;
//  - the title is cut with an ellipsis rather than ever running under a button.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const modal = read('../components/SettingsModal/SettingsModal.css');
const credits = read('../components/XenonCredits/XenonCredits.css');

test('the header is a named container and the rules use it, not the viewport', () => {
  assert.match(modal, /\.settings-head \{[^}]*container: settings-head \/ inline-size;/s);
  assert.match(credits, /@container settings-head \(max-width: 700px\) \{\s*\.settings-head-credits > span:not\(\.xc-chip-cta\) \{ display: none; \}/);
  assert.doesNotMatch(credits, /@media \(max-width: 560px\) \{\s*\.settings-head-credits/, 'the viewport rule is gone');
});

test('a phone-width header shows the Store pill as its icon, with a 44px target', () => {
  const at = modal.indexOf('@container settings-head (max-width: 460px)');
  assert.ok(at > 0, 'rule exists');
  const rule = modal.slice(at, at + 300);
  assert.match(rule, /\.settings-store-pill \{[^}]*min-width: 44px/);
  assert.match(rule, /\.settings-store-pill > span \{ display: none; \}/);
  assert.match(read('../index.html'), /class="settings-store-pill"[^>]*data-i18n-title="settings_store_open"/, 'the button keeps its name');
});

test('the title never runs under the buttons', () => {
  assert.match(modal, /\.settings-title \{[^}]*white-space: nowrap;[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/s);
});
