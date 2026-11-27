// What the Game Companion card says and shows around a look: Bit's mood for each thing the
// card is doing, a game's name made readable, what a look costs on Sparks, the words for each
// reason Bit could not answer, and the page behind held still while the card is up.
'use strict';

(() => {
  // Bit on the card. The card is the thing in front while it is open (the user
  // is at the dashboard, not playing), so like the voice view it moves under
  // game mode and stops only for the low-GPU choices; hidden, it stops by itself.
  const CARD_HOLD = ['low-power-gpu', 'perf-mode'];
  // What the card is doing -> Bit's mood, and what it does as the answer lands.
  const BIT_STATE = {
    waiting: { mood: 'idle' },
    looking: { mood: 'think' },
    answered: { mood: 'idle', play: 'nod' },
    failed: { mood: 'worry' },
  };

  function prettyName(p) {
    const base = String(p || '').replace(/\.exe$/i, '');
    return base ? base.charAt(0).toUpperCase() + base.slice(1) : '';
  }

  // Nothing paints under the frosted page while the card is up.
  function freezeBehind(on) {
    if (typeof window.ambientFreeze === 'function') window.ambientFreeze('game-companion', on);
  }

  // What a look costs on Sparks, beside the key and before pressing: the
  // hub's charge for the last look, or the price table until one is made. On
  // any other AI there is nothing to pay here, so the line stays hidden.
  function paintCost(sparks) {
    const el = document.getElementById('gc-cost');
    const words = document.getElementById('gc-cost-text');
    if (!el || !words) return;
    const on = Number.isFinite(sparks) && sparks > 0 && !!(window.XenonCredits && XenonCredits.active());
    el.hidden = !on;
    if (!on) return;
    words.textContent = sparks < 1
      ? t('gc_cost_under')
      : t('gc_cost').replace('{n}', XenonCredits.format(sparks));
  }

  // Why Bit could not answer, in words the user can act on. Out of Sparks
  // comes with the way to recharge, where the Sparks shop exists.
  const PROBLEM_TEXT = { no_ai: 'gc_need_key', no_vision: 'gc_no_vision', no_credits: 'gc_no_sparks' };

  window.GameCompanionSays = {
    CARD_HOLD, BIT_STATE, prettyName, freezeBehind, paintCost, PROBLEM_TEXT,
  };
})();
