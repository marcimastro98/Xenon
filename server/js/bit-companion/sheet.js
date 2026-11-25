'use strict';
// The sheet of the person's own Bit, opened from the companion or the Bit tile (bit-companion/
// companion.js, tile.js): the egg and its hatch, then the card (number, stage, rarity,
// what it learns), its wardrobe (bit-companion/wardrobe.js) and where it lives. The server
// keeps it all (server/bit/, POST /api/bit/hatch|name|prefs); every answer goes through BitApp.heard, so
// every place of this page follows, and the 'bit' event tells the other screens.
(() => {
  const TRAIT_KEYS = { gamer: 'gamer', nightOwl: 'night_owl', musicLover: 'music_lover', coder: 'coder', overclocker: 'overclocker', earlyBird: 'early_bird' };
  const PLACES = ['corner', 'topbar', 'both', 'off'];
  const REACTIONS = ['normal', 'few', 'off'];
  const NAME_MAX = 24;

  let ui = null; // { overlay, sheet, body, stage, kind, stop, opener, timer }

  const say = (key, vars = {}) => String(t(key)).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  const num = (n) => Number(n).toLocaleString(typeof lang === 'string' ? lang : 'en');
  const bitNow = () => (window.BitApp?.state()) || null;

  async function post(path, body) {
    try {
      const base = typeof SERVER === 'string' ? SERVER : '';
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
      return (await res.json().catch(() => null)) || { ok: false, error: 'offline' };
    } catch { return { ok: false, error: 'offline' }; }
  }

  function told(out) {
    if (out?.ok && out.bit && window.BitApp) window.BitApp.heard(out.bit);
  }

  function note(text) {
    const n = ui?.sheet.querySelector('.bitc-note');
    if (n) n.textContent = text || '';
  }

  // The big Bit: the egg, or the person's Bit (its own look even with the classic one chosen).
  function stage(bit) {
    const kind = bit.hatched ? 'bit' : 'egg';
    if (ui.kind === kind) return;
    ui.kind = kind;
    const host = makeEl('button', 'bitc-big');
    host.type = 'button';
    host.setAttribute('aria-label', say(bit.hatched ? 'mybit_title' : 'mybit_hatch'));
    ui.stage.replaceChildren(host);
    const hold = window.BitApp ? window.BitApp.TILE_HOLD.filter((name) => name !== 'overlay-frozen') : [];
    const player = window.BitApp?.mount(host, {
      mood: bit.hatched ? 'idle' : 'egg', fidgets: bit.hatched, look: () => window.BitWardrobe?.preview() || window.BitApp.personal(), hold,
    });
    host.addEventListener('click', () => {
      if (!bitNow()?.hatched) { hatch(); return; }
      if (player) player.poke();
    }, { signal: ui.stop.signal });
    ui.player = player;
  }

  // Who it is, how old, then in plain sentences: one of the Founders, its rarest trait with the true odds.
  function factsOf(bit) {
    return [
      bit.number ? say('mybit_number', { n: num(bit.number) }) : say('mybit_local'),
      say('mybit_age', { stage: say(`mybit_stage_${bit.stage}`), n: num(bit.days || 1) }),
      window.BitCard?.aboutLine(bit, say, num, typeof lang === 'string' ? lang : 'en') || '',
    ].filter(Boolean);
  }

  function nameField(bit) {
    const wrap = makeEl('label', 'bitc-name');
    const input = makeEl('input');
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.value = bit.name || '';
    input.placeholder = say('mybit_name_hint');
    input.setAttribute('aria-label', say('mybit_name'));
    input.autocomplete = 'off';
    input.spellcheck = false;
    const save = async () => {
      const name = input.value.trim();
      if (name === (bitNow()?.name || '')) return;
      const out = await post('/api/bit/name', { name });
      if (out.ok) { told(out); note(''); } else note(say(out.error === 'bad_name' ? 'mybit_name_bad' : 'mybit_save_failed'));
    };
    input.addEventListener('change', save, { signal: ui.stop.signal });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); }, { signal: ui.stop.signal });
    wrap.append(input);
    return wrap;
  }

  function traits(bit) {
    const box = makeEl('section', 'bitc-part');
    box.append(makeEl('h3', 'bitc-part-title', say('mybit_traits')));
    const list = makeEl('ul', 'bitc-traits');
    for (const tr of Array.isArray(bit.traits) ? bit.traits : []) {
      const key = TRAIT_KEYS[tr.id];
      if (!key) continue;
      const row = makeEl('li', tr.earned ? 'bitc-trait is-earned' : 'bitc-trait');
      const words = makeEl('div', 'bitc-trait-words');
      words.append(makeEl('span', 'bitc-trait-name', say(`mybit_trait_${key}`)));
      words.append(makeEl('span', 'bitc-trait-item', tr.earned ? say('mybit_earned', { item: say(`mybit_item_${tr.item}`) }) : say(`mybit_item_${tr.item}`)));
      const bar = makeEl('span', 'bitc-bar');
      bar.style.setProperty('--bitc-fill', String(Math.max(0, Math.min(1, Number(tr.progress) || 0))));
      row.append(words, bar);
      list.append(row);
    }
    box.append(list);
    return box;
  }

  // A row of choices; the server says which one holds.
  function choice(title, key, options, current, wordOf) {
    const box = makeEl('div', 'bitc-choice');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', title);
    box.append(makeEl('span', 'bitc-choice-title', title));
    const row = makeEl('div', 'bitc-seg');
    for (const value of options) {
      const btn = makeEl('button', 'bitc-seg-btn', wordOf(value));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(value === current));
      btn.addEventListener('click', () => setPref({ [key]: value }), { signal: ui.stop.signal });
      row.append(btn);
    }
    box.append(row);
    return box;
  }

  function prefs(bit) {
    const p = bit.prefs || {};
    const box = makeEl('section', 'bitc-part');
    box.append(choice(say('mybit_place'), 'place', PLACES, p.place, (v) => say(`mybit_place_${v}`)));
    if (bit.hatched) box.append(choice(say('mybit_reactions'), 'reactions', REACTIONS, p.reactions, (v) => say(`mybit_react_${v}`)));
    if (bit.hatched) {
      const label = makeEl('label', 'bitc-switch');
      const box2 = makeEl('input');
      box2.type = 'checkbox';
      box2.checked = p.classic === true;
      box2.addEventListener('change', () => setPref({ classic: box2.checked }), { signal: ui.stop.signal });
      label.append(box2, makeEl('span', '', say('mybit_classic')));
      box.append(label);
    }
    return box;
  }

  async function setPref(patch) {
    const out = await post('/api/bit/prefs', patch);
    if (out.ok) told(out); else note(say('mybit_save_failed'));
  }

  function fill(bit) {
    if (!ui) return;
    stage(bit);
    const head = makeEl('div', 'bitc-head');
    const title = makeEl('h2', 'bitc-title', bit.hatched ? say('mybit_title') : say('mybit_egg_label'));
    title.id = 'bitc-title';
    head.append(title);
    const parts = [head];
    if (bit.hatched) {
      head.append(nameField(bit));
      const facts = makeEl('ul', 'bitc-facts');
      for (const line of factsOf(bit)) facts.append(makeEl('li', '', line));
      parts.push(facts);
      for (const part of [
        window.BitCard?.section(bit, wardrobeHands()),
        window.BitRecap?.section(bit, wardrobeHands()),
        window.BitClip?.section(bit, wardrobeHands()),
      ]) {
        if (part) parts.push(part);
      }
      const dress = window.BitWardrobe?.section(bit, wardrobeHands());
      if (dress) parts.push(dress);
      parts.push(traits(bit));
    } else {
      head.append(makeEl('p', 'bitc-line', say('mybit_egg_line')));
      const go = makeEl('button', 'bitc-go', say('mybit_hatch'));
      go.type = 'button';
      go.addEventListener('click', hatch, { signal: ui.stop.signal });
      parts.push(go);
    }
    const n = makeEl('p', 'bitc-note');
    n.setAttribute('role', 'status');
    parts.push(n, prefs(bit));
    ui.body.replaceChildren(...parts);
  }

  // What the wardrobe may do in this sheet: ask the server, play on the big Bit, draw again.
  function wardrobeHands() {
    const play = (id) => { if (ui?.player && window.Xenon?.bit?.clip(id)) ui.player.play(id); };
    const redraw = () => { if (ui) fill(bitNow()); };
    return { say, num, post, told, note, play, redraw, refresh: () => ui?.player?.refresh(), signal: ui.stop.signal };
  }

  async function hatch() {
    if (!ui || ui.hatching) return;
    ui.hatching = true;
    const go = ui.sheet.querySelector('.bitc-go');
    if (go) go.disabled = true;
    const out = await post('/api/bit/hatch', {});
    if (!ui) return;
    ui.hatching = false;
    if (!out.ok) {
      if (go) go.disabled = false;
      note(say(out.error === 'waiting' ? 'mybit_hatch_wait' : 'mybit_hatch_failed'));
      return;
    }
    // The egg breaks first, then the card: who came out.
    ui.revealing = true;
    told(out);
    ui.kind = null;
    stage(out.bit);
    const clip = window.Xenon?.bit?.clip('hatch');
    if (ui.player && clip) ui.player.play('hatch');
    const ms = clip ? clip.frames.reduce((sum, f) => sum + f.ms, 0) : 0;
    ui.timer = setTimeout(() => { if (ui) { ui.revealing = false; fill(bitNow() || out.bit); } }, ms);
  }

  function close() {
    if (!ui) return;
    const { overlay, opener, timer, stop } = ui;
    ui = null;
    window.BitWardrobe?.reset();
    window.BitCard?.reset();
    window.BitRecap?.reset();
    window.BitClip?.reset();
    clearTimeout(timer);
    stop.abort();
    overlay.remove();
    if (window.BitApp) window.BitApp.sweep();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  }

  function open() {
    const bit = bitNow();
    if (bit?.ok !== true) return false;
    if (ui) { fill(bit); return true; }
    const overlay = makeEl('div', 'bitc-overlay');
    const sheet = makeEl('div', 'bitc-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'bitc-title');
    sheet.tabIndex = -1;
    const shut = makeEl('button', 'bitc-close', '×');
    shut.type = 'button';
    shut.setAttribute('aria-label', say('close'));
    // The close button rides on the stage, which stays at the top while the sheet scrolls.
    const stageEl = makeEl('div', 'bitc-stage');
    const slot = makeEl('div', 'bitc-slot');
    stageEl.append(shut, slot);
    const body = makeEl('div', 'bitc-body');
    sheet.append(stageEl, body);
    overlay.append(sheet);
    ui = { overlay, sheet, body, stage: slot, kind: null, stop: new AbortController(), opener: document.activeElement, timer: 0 };
    const { signal } = ui.stop;
    shut.addEventListener('click', close, { signal });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); }, { signal });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, { signal });
    addEventListener('xenon-bit', (e) => { if (ui && !ui.revealing && e.detail) fill(e.detail); }, { signal });
    document.body.append(overlay);
    fill(bit);
    sheet.focus({ preventScroll: true });
    return true;
  }

  window.BitSheet = { open, close, isOpen: () => !!ui };
})();
