// What a pressed key sends and shows that needs nothing of the Deck around it: the action of a
// fader and of a light reaction, the red flash of a failure, the note that says what a key did,
// letting go of a pointer wherever it is, and the job a key has in OBS.
'use strict';

(() => {
  // A key whose effect cannot be seen says what it did (js/deck-done-text.js).
  function tellDone(action, data) {
    const note = window.XenonToast && window.DeckDoneText ? window.DeckDoneText.note(action, data, tt) : null;
    if (note) window.XenonToast.show(note);
  }

  function tt(key, fallback) {
    return (typeof window.t === 'function' && window.t(key)) || fallback;
  }

  // Briefly flash a key red to surface a failed action (path not found, OBS
  // offline, …) — actions must not fail silently.
  function flashError(node) {
    if (!node) return;
    node.classList.remove('has-error');
    void node.offsetWidth;          // restart the animation if it's still mid-flash
    node.classList.add('has-error');
    setTimeout(() => node.classList.remove('has-error'), 600);
  }

  // Build the lighting action for a key's reaction: set colour/effect when `on`,
  // else restore the lights to normal. Returns null when the key has no reaction.
  function lightingAction(light, on) {
    if (!light || !light.color) return null;
    return on
      ? { type: 'lighting', mode: 'set', color: light.color, style: light.style || 'solid' }
      : { type: 'lighting', mode: 'restore' };
  }

  // Map a slider key's target + a 0–100 value to the registry action it drives.
  function sliderAction(slider, value) {
    const v = String(value);
    switch (slider.target) {
      case 'volume':        return { type: 'volume', mode: 'set', value: v };
      case 'appVolume':     return { type: 'appVolume', app: slider.app, mode: 'set', value: v };
      case 'spotifyVolume': return { type: 'spotifyVolume', mode: 'set', value: v };
      case 'obsInput':      return { type: 'obsInputVolume', source: slider.source, value: v };
      case 'haLight':       return { type: 'haLight', entity: slider.entity, mode: 'brightness', value: v };
      case 'discordInput':  return { type: 'discordInputVol', mode: 'set', value: v };
      case 'discordOutput': return { type: 'discordOutputVol', mode: 'set', value: v };
      default: return null;
    }
  }

  // Call onRelease once when this pointer lets go, wherever it is by then: a key
  // re-rendered away under the finger never sees its own pointerup, and a held
  // key must still let go.
  function onPointerRelease(e, onRelease) {
    const id = e.pointerId;
    const done = (ev) => {
      if (ev.pointerId !== id) return;
      document.removeEventListener('pointerup', done, true);
      document.removeEventListener('pointercancel', done, true);
      onRelease();
    };
    document.addEventListener('pointerup', done, true);
    document.addEventListener('pointercancel', done, true);
  }

  // The OBS "role" a key plays, from its trigger actions: 'scene' (set scene OR
  // cycle next), 'record', 'stream', or null. Used to pick which key hosts the
  // live scene thumbnail. obsSceneNext has no state binding, so this marker is
  // the only way to recognise a cycle scene key.
  function obsRoleOf(key) {
    if (!key || key.kind !== 'action' || !key.triggers || !window.DeckActions) return null;
    const types = [];
    window.DeckModel.KEY_TRIGGERS.forEach((tr) => {
      const steps = window.DeckActions.triggerSteps(key.triggers[tr]);
      if (steps[0] && steps[0].action) types.push(steps[0].action.type);
    });
    if (types.some((t) => t === 'obsScene' || t === 'obsSceneNext')) return 'scene';
    if (types.includes('obsRecord')) return 'record';
    if (types.includes('obsStream')) return 'stream';
    return null;
  }

  window.DeckKeyActions = {
    tellDone, tt, flashError, lightingAction, sliderAction, onPointerRelease, obsRoleOf,
  };
})();
