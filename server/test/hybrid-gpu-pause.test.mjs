import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// ── body.low-power-gpu: every consumer, or none ─────────────────────────────
// The class is set once by js/native-bridge.js when the native shell renders on
// the weaker of two GPUs, and it is the ONLY signal each decorative layer has to
// stop. It shipped broken in v4.6.0: custom-bg.js started honouring it while no
// stylesheet ever did, so Xenon's own aurora kept animating and the animated
// background the USER wrote was the one frozen — with nothing on screen saying
// why. A theme author spent a morning rewriting working code before we found it
// (#118). The failure mode is silent by construction (a missing consumer just
// keeps animating), so the consumer list is asserted rather than trusted.

test('every decorative layer honours the hybrid-GPU freeze', () => {
  const consumers = [
    // [file, what it stops]
    ['styles/backgroundfx.css', 'the aurora + neon grid'],
    ['js/custom-bg.js', "the user's animated background"],
    ['js/deck.js', 'animated Deck key decor'],
  ];
  for (const [file, what] of consumers) {
    assert.match(read(file), /low-power-gpu/, `${file} must freeze ${what} on a hybrid GPU`);
  }
});

test('the aurora and grid are actually paused, not merely mentioned', () => {
  // A bare mention in a comment would satisfy the check above. The CSS rule is
  // what does the work, and it must pause rather than hide: the layers stay
  // visible at their current frame, exactly like the other freeze states.
  const css = read('styles/backgroundfx.css');
  assert.match(
    css,
    /body\.low-power-gpu \.aurora-blob,\s*\r?\n\s*body\.low-power-gpu \.grid-plane \{ animation-play-state: paused; \}/,
    'backgroundfx.css must pause .aurora-blob and .grid-plane under body.low-power-gpu',
  );
});

// ── The user's way out ──────────────────────────────────────────────────────
// Unlike idle/game mode this freeze holds for the whole session, so it is a real
// trade rather than an invisible optimization. hubSettings.hybridGpuAnimationPause
// (default ON) lets the user take the other side of it, and a setting that both
// surfaces persist has to be normalized on both or it silently reverts.

test('hybridGpuAnimationPause is normalized on client and server alike', () => {
  const shape = /hybridGpuAnimationPause:\s*(value|source)\.hybridGpuAnimationPause !== false/;
  assert.match(read('js/settings.js'), shape, 'client must normalize hybridGpuAnimationPause');
  assert.match(read('server.js'), shape, 'server must normalize hybridGpuAnimationPause');
});

test('the setting defaults to on for both surfaces', () => {
  const dflt = /hybridGpuAnimationPause:\s*true/;
  assert.match(read('js/settings.js'), dflt, 'client default must be on');
  assert.match(read('server.js'), dflt, 'server default must be on');
});

test('turning the setting off releases the class', () => {
  // native-bridge owns the class; settings.js is the only thing that drives it.
  // If either half goes missing the switch renders but does nothing.
  assert.match(read('js/native-bridge.js'), /window\.NativeGpuPause\s*=/, 'native-bridge must expose the control');
  assert.match(
    read('js/settings.js'),
    /NativeGpuPause\.setEnabled\(hubSettings\.hybridGpuAnimationPause !== false\)/,
    'applyHubSettings must push the preference to native-bridge',
  );
});

test('the background editor explains the freeze instead of looking like a code error', () => {
  // The whole point of #118: the author must be told it is the machine, not
  // their snippet. Separate from renderBgCodeError so it is not styled as one.
  const settings = read('js/settings.js');
  assert.match(settings, /function renderBgFrozenNote\(\)/, 'the note must exist');
  assert.match(settings, /settings_bg_code_frozen_gpu/, 'the note must have copy to show');
  assert.match(read('index.html'), /id="settings-bgcode-frozen"/, 'the note needs a home in the editor');
  const i18n = read('js/i18n.js');
  assert.ok(
    (i18n.match(/settings_bg_code_frozen_gpu/g) || []).length >= 2,
    'the note must be translated in at least it + en',
  );
});
