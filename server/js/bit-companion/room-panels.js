'use strict';
// The two drawers of the Bit's room (bit-companion/room.js), opened over its stage:
//   - share: one choice at the top (its card, a short video, the setup's card with the Bit in it, the
//     month's card once a month has closed), then only that one, with one row to copy, share or save
//     it (card.js, clip.js, presets/share-card.js, recap.js);
//   - about: its name, who it is, what it learns from the person, where it lives, how often it
//     reacts, the classic Bit elsewhere and its page on the site. An egg has only where it lives.
// The server keeps it all (POST /api/bit/name|prefs|publish); every answer goes through the room's hands.
(() => {
  const TRAIT_KEYS = { gamer: 'gamer', nightOwl: 'night_owl', musicLover: 'music_lover', coder: 'coder', overclocker: 'overclocker', earlyBird: 'early_bird' };
  const PLACES = ['corner', 'topbar', 'both', 'off'];
  const REACTIONS = ['normal', 'few', 'off'];
  const ROAMS = ['mix', 'walk', 'stay'];
  const WARPS = ['any', 'crumble', 'beam', 'packet', 'glitch']; // bit-companion/warp.js
  const DESKS = ['main', 'off']; // bit-companion/desk.js
  const GROUNDS = ['plain', 'stage'];
  const NAME_MAX = 24;
  let shareTab = 'card'; // what the share drawer shows; the room's buttons choose it before opening

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

  // In the corner: whether it strolls now and then, and the way back after a drag (stroll.js).
  function roam(p, h) {
    const box = choice(h.say('mybit_roam'), 'roam', ROAMS, p.roam || 'mix', (v) => h.say(`mybit_roam_${v}`), h);
    if (!p.spot) return box;
    const back = makeEl('button', 'bitc-seg-btn bitc-spot-back', h.say('mybit_spot_reset'));
    back.type = 'button';
    back.addEventListener('click', () => setPref({ spot: null }, h), { signal: h.signal });
    box.append(back);
    return box;
  }

  // How it teleports: on a stroll with roam 'mix', and on its way to a place set here or elsewhere.
  const warpChoice = (p, h) => choice(h.say('mybit_warp'), 'warp', WARPS, p.warp || 'any', (v) => h.say(`mybit_warp_${v}`), h);

  // On the taskbar, only where the shell can draw it; dragged along the bar, a way back to its usual spot.
  function desk(p, h) {
    const box = choice(h.say('mybit_desk'), 'desk', DESKS, p.desk || 'main', (v) => h.say(`mybit_desk_${v}`), h);
    if (typeof p.deskX !== 'number' || p.desk === 'off') return box;
    const back = makeEl('button', 'bitc-seg-btn bitc-spot-back', h.say('mybit_desk_reset'));
    back.type = 'button';
    back.addEventListener('click', () => setPref({ deskX: null }, h), { signal: h.signal });
    box.append(back);
    return box;
  }
  const deskShown = () => window.__XENON_NATIVE__ === true && window.__XENON_NATIVE_CAPS__?.bitDesk === true;

  function prefs(bit, h) {
    const p = bit.prefs || {};
    const box = makeEl('section', 'bitc-part bitc-prefs');
    box.append(choice(h.say('mybit_place'), 'place', PLACES, p.place, (v) => h.say(`mybit_place_${v}`), h));
    if (!bit.hatched) return box;
    box.append(choice(h.say('mybit_reactions'), 'reactions', REACTIONS, p.reactions, (v) => h.say(`mybit_react_${v}`), h));
    if (p.place === 'corner' || p.place === 'both') box.append(roam(p, h), warpChoice(p, h));
    if (deskShown()) box.append(desk(p, h));
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
    const box = makeEl('div', 'bitc-choice bitc-pose');
    const turn = makeEl('button', 'bitc-seg-btn', h.say('mybit_pose_change'));
    turn.type = 'button';
    turn.addEventListener('click', () => {
      const next = D.nextPose(bit);
      h.play(next || D.poseOf({ genes: bit.genes }));
      setPref({ pose: next }, h);
    }, { signal: h.signal });
    box.append(makeEl('span', 'bitc-choice-title', h.say('mybit_pose')), turn);
    return box;
  }

  // Its page on xenon-app.com, by choice (POST /api/bit/publish): only a Bit with the hub's
  // number has one. The line says what the page shows; the link opens it once it is shown.
  function site(bit, h) {
    if (!bit.number || bit.local) return null;
    const box = makeEl('div', 'bitc-site');
    const label = makeEl('label', 'bitc-switch');
    const input = makeEl('input');
    input.type = 'checkbox';
    input.checked = bit.shown === true;
    input.addEventListener('change', async () => {
      input.disabled = true;
      const out = await h.post('/api/bit/publish', { public: input.checked });
      if (out.ok) { h.told(out); return; }
      if (out.bit) h.told({ ok: true, bit: out.bit });
      input.checked = !input.checked;
      input.disabled = false;
      h.note(h.say(out.error === 'taken_down' ? 'mybit_site_taken_down' : 'mybit_site_failed'));
    }, { signal: h.signal });
    label.append(input, makeEl('span', '', h.say('mybit_site')));
    box.append(label);
    // What the page shows is said before it is shown; once shown, the link to it.
    if (!input.checked) box.append(makeEl('p', 'bitc-line', h.say('mybit_site_line')));
    const page = window.BitCard?.paint.pageOf(bit);
    if (page) {
      const link = makeEl('a', 'bitc-site-link', h.say('mybit_site_open'));
      link.href = page;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.append(link);
    }
    return box;
  }

  // The setup's card (presets/share-card.js): a picture of the dashboard, the Bit standing beside it.
  function setup(h) {
    const box = makeEl('div', 'bitc-part bitc-setup');
    const go = makeEl('button', 'bitc-seg-btn is-main', h.say('mybit_setup_go'));
    go.type = 'button';
    go.addEventListener('click', () => window.ShareCard.open({ source: 'setup' }), { signal: h.signal });
    box.append(makeEl('p', 'bitc-line', h.say('mybit_setup_line')), go);
    return box;
  }

  // What this page can make: its card always, then the video where this browser records one, the
  // setup's card, and the recap once a month (or the year) has closed.
  function shareTabs(bit, h) {
    const tabs = [['card', 'mybit_share_card']];
    if (window.BitClip?.recorderType()) tabs.push(['clip', 'mybit_share_clip']);
    if (window.ShareCard) tabs.push(['setup', 'mybit_share_setup']);
    if (window.BitRecap?.recapsOf(bit).length) tabs.push(['recap', 'mybit_share_recap']);
    return tabs.map(([id, key]) => [id, h.say(key)]);
  }

  function sharePane(id, bit, h) {
    if (id === 'clip') return window.BitClip.section(bit, h);
    if (id === 'setup') return setup(h);
    if (id === 'recap') return window.BitRecap.section(bit, h);
    const tools = makeEl('div', 'bitc-tools');
    tools.append(...[choice(h.say('mybit_ground'), 'card', GROUNDS, bit.prefs?.card || 'plain', (v) => h.say(`mybit_ground_${v}`), h), pose(bit, h)].filter(Boolean));
    return window.BitCard?.section(bit, h, [tools]) || null;
  }

  // One choice at the top, then only what it makes: a tap swaps the part under it.
  function share(bit, h) {
    const box = makeEl('div', 'broom-panel-body');
    const tabs = shareTabs(bit, h);
    if (!tabs.some(([id]) => id === shareTab)) shareTab = 'card';
    const pane = makeEl('div', 'bitc-share-pane');
    const show = () => pane.replaceChildren(...[sharePane(shareTab, bit, h)].filter(Boolean));
    const row = makeEl('div', 'bitc-share-tabs');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', h.say('mybit_share_title'));
    for (const [id, word] of tabs) {
      const b = makeEl('button', 'bitc-seg-btn', word);
      b.type = 'button';
      b.dataset.share = id;
      b.setAttribute('aria-pressed', String(id === shareTab));
      b.addEventListener('click', () => {
        shareTab = id;
        for (const other of row.children) other.setAttribute('aria-pressed', String(other === b));
        show();
      }, { signal: h.signal });
      row.append(b);
    }
    show();
    box.append(...(tabs.length > 1 ? [row, pane] : [pane]));
    return box;
  }

  function about(bit, h) {
    const box = makeEl('div', 'broom-panel-body');
    if (!bit.hatched) { box.append(prefs(bit, h)); return box; }
    const facts = makeEl('ul', 'bitc-facts');
    for (const line of factsOf(bit, h)) facts.append(makeEl('li', '', line));
    box.append(...[nameField(bit, h), facts, traits(bit, h), prefs(bit, h), site(bit, h)].filter(Boolean));
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

  window.BitPanels = {
    build, factsOf,
    /** The share drawer opens on this part next: 'card', 'clip', 'setup' or 'recap'. */
    choose: (id) => { shareTab = id; },
  };
})();
