'use strict';
// The two drawers of the Bit's room (bit-companion/room.js), opened over its stage:
//   - share: its pose, the card, the short video, the month's card and its page on the site
//     (bit-companion/card.js, clip.js, recap.js);
//   - about: its name, who it is, what it learns from the person, where it lives, how often it
//     reacts and the classic Bit elsewhere. An egg has only where it lives.
// The server keeps it all (POST /api/bit/name|prefs); every answer goes through the room's hands.
(() => {
  const TRAIT_KEYS = { gamer: 'gamer', nightOwl: 'night_owl', musicLover: 'music_lover', coder: 'coder', overclocker: 'overclocker', earlyBird: 'early_bird' };
  const PLACES = ['corner', 'topbar', 'both', 'off'];
  const REACTIONS = ['normal', 'few', 'off'];
  const NAME_MAX = 24;

  async function setPref(patch, h) {
    const out = await h.post('/api/bit/prefs', patch);
    if (out.ok) h.told(out); else h.note(h.say('mybit_save_failed'));
  }

  // Who it is, how old, then in plain sentences: one of the Founders, its rarest trait with the true odds.
  function factsOf(bit, h) {
    return [
      bit.number ? h.say('mybit_number', { n: h.num(bit.number) }) : h.say('mybit_local'),
      h.say('mybit_age', { stage: h.say(`mybit_stage_${bit.stage}`), n: h.num(bit.days || 1) }),
      window.BitCard?.aboutLine(bit, h.say, h.num, typeof lang === 'string' ? lang : 'en') || '',
    ].filter(Boolean);
  }

  function nameField(bit, h) {
    const wrap = makeEl('label', 'bitc-name');
    wrap.append(makeEl('span', 'bitc-choice-title', h.say('mybit_name')));
    const input = makeEl('input');
    input.type = 'text';
    input.maxLength = NAME_MAX;
    input.value = bit.name || '';
    input.placeholder = h.say('mybit_name_hint');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('change', async () => {
      const name = input.value.trim();
      if (name === (window.BitApp?.state()?.name || '')) return;
      const out = await h.post('/api/bit/name', { name });
      if (out.ok) { h.told(out); h.note(''); } else h.note(h.say(out.error === 'bad_name' ? 'mybit_name_bad' : 'mybit_save_failed'));
    }, { signal: h.signal });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); }, { signal: h.signal });
    wrap.append(input);
    return wrap;
  }

  function traits(bit, h) {
    const box = makeEl('section', 'bitc-part bitc-learn');
    box.append(makeEl('h3', 'bitc-part-title', h.say('mybit_traits')));
    const list = makeEl('ul', 'bitc-traits');
    for (const tr of Array.isArray(bit.traits) ? bit.traits : []) {
      const key = TRAIT_KEYS[tr.id];
      if (!key) continue;
      const row = makeEl('li', tr.earned ? 'bitc-trait is-earned' : 'bitc-trait');
      const words = makeEl('div', 'bitc-trait-words');
      words.append(makeEl('span', 'bitc-trait-name', h.say(`mybit_trait_${key}`)));
      words.append(makeEl('span', 'bitc-trait-item', tr.earned ? h.say('mybit_earned', { item: h.say(`mybit_item_${tr.item}`) }) : h.say(`mybit_item_${tr.item}`)));
      const bar = makeEl('span', 'bitc-bar');
      bar.style.setProperty('--bitc-fill', String(Math.max(0, Math.min(1, Number(tr.progress) || 0))));
      row.append(words, bar);
      list.append(row);
    }
    box.append(list);
    return box;
  }

  // A row of choices; the server says which one holds.
  function choice(title, key, options, current, wordOf, h) {
    const box = makeEl('div', 'bitc-choice');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', title);
    box.append(makeEl('span', 'bitc-choice-title', title));
    const row = makeEl('div', 'bitc-seg');
    for (const value of options) {
      const btn = makeEl('button', 'bitc-seg-btn', wordOf(value));
      btn.type = 'button';
      btn.setAttribute('aria-pressed', String(value === current));
      btn.addEventListener('click', () => setPref({ [key]: value }, h), { signal: h.signal });
      row.append(btn);
    }
    box.append(row);
    return box;
  }

  function prefs(bit, h) {
    const p = bit.prefs || {};
    const box = makeEl('section', 'bitc-part bitc-prefs');
    box.append(choice(h.say('mybit_place'), 'place', PLACES, p.place, (v) => h.say(`mybit_place_${v}`), h));
    if (!bit.hatched) return box;
    box.append(choice(h.say('mybit_reactions'), 'reactions', REACTIONS, p.reactions, (v) => h.say(`mybit_react_${v}`), h));
    const label = makeEl('label', 'bitc-switch');
    const tick = makeEl('input');
    tick.type = 'checkbox';
    tick.checked = p.classic === true;
    tick.addEventListener('change', () => setPref({ classic: tick.checked }, h), { signal: h.signal });
    label.append(tick, makeEl('span', '', h.say('mybit_classic')));
    box.append(label);
    return box;
  }

  // Its pose on the card and at the end of the video: its own from the DNA, or the next one.
  function pose(bit, h) {
    const D = window.BitDna;
    if (!D) return null;
    const line = makeEl('div', 'bitc-pose');
    line.append(makeEl('p', 'bitc-line', h.say(bit.prefs?.pose ? 'mybit_pose_chosen' : 'mybit_pose_own')));
    const turn = makeEl('button', 'bitc-seg-btn', h.say('mybit_pose_change'));
    turn.type = 'button';
    turn.addEventListener('click', () => {
      const next = D.nextPose(bit);
      h.play(next || D.poseOf({ genes: bit.genes }));
      setPref({ pose: next }, h);
    }, { signal: h.signal });
    line.append(turn);
    return line;
  }

  function share(bit, h) {
    const box = makeEl('div', 'broom-panel-body');
    const row = makeEl('div', 'bitc-share-row');
    for (const part of [window.BitCard?.section(bit, h), window.BitClip?.section(bit, h)]) if (part) row.append(part);
    box.append(...[pose(bit, h), row, window.BitRecap?.section(bit, h), window.BitCard?.site(bit, h)].filter(Boolean));
    return box;
  }

  function about(bit, h) {
    const box = makeEl('div', 'broom-panel-body');
    if (!bit.hatched) { box.append(prefs(bit, h)); return box; }
    const facts = makeEl('ul', 'bitc-facts');
    for (const line of factsOf(bit, h)) facts.append(makeEl('li', '', line));
    box.append(nameField(bit, h), facts, traits(bit, h), prefs(bit, h));
    return box;
  }

  /**
   * One drawer's title and body.
   * @param {'share'|'about'} kind
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, post: Function, told: Function, note: Function, play: Function,
   *   redraw: Function, signal: AbortSignal }} h the room's hands
   */
  function build(kind, bit, h) {
    const title = kind === 'share' ? h.say('mybit_share_title') : h.say(bit.hatched ? 'mybit_about' : 'mybit_place');
    return { title, body: kind === 'share' ? share(bit, h) : about(bit, h) };
  }

  window.BitPanels = { build, factsOf };
})();
