'use strict';
// The guided setup of the person's Bit, in its room's drawer (room.js, room-panels.js). It opens by itself in
// every room that opens until it is done: right after the egg hatches and, while it is due, each time Xenon
// opens (companion.js opens the room then, and loads this file only while it is due). Three steps: where to
// see it (the dashboard, and the desktop where the shell draws it), how it gets around (a tap on an effect
// plays it on the big Bit), what it can do. Done on the last step (prefs.setup, kept by the server, so no
// other screen offers it again); every choice stays in its settings afterwards.
(() => {
  const QUESTIONS = ['mybit_guide_where', 'mybit_guide_moves', 'mybit_guide_can'];
  const CAN = ['mybit_guide_can_react', 'mybit_guide_can_news', 'mybit_guide_can_room', 'mybit_guide_can_chat'];
  const offered = new WeakSet(); // the rooms it opened in by itself
  let step = 0;

  /** True until the person has been through it: a hatched Bit without prefs.setup. */
  const due = (bit) => bit?.ok === true && bit.hatched === true && bit.prefs?.setup !== true;

  /** 'setup' the first time a room fills while it is due (that room only), else null. */
  function first(bit, room) {
    if (!due(bit) || !room || offered.has(room)) return null;
    offered.add(room);
    step = 0;
    return 'setup';
  }

  const line = (text) => makeEl('p', 'bitc-line', text);

  function button(text, main, onClick, h) {
    const b = makeEl('button', main ? 'bitc-seg-btn is-main' : 'bitc-seg-btn', text);
    b.type = 'button';
    b.addEventListener('click', onClick, { signal: h.signal });
    return b;
  }

  // Where: the dashboard's places, then the desktop where the shell draws it.
  function where(bit, h, P) {
    const p = bit.prefs || {};
    const parts = [P.choice(h.say('mybit_guide_dashboard'), 'place', P.PLACES, p.place, (v) => h.say(`mybit_place_${v}`), h)];
    if (P.deskShown()) parts.push(P.desk(p, h), line(h.say('mybit_guide_desk_line')));
    return parts;
  }

  // A tap on an effect plays it on the big Bit. On a phone the drawer covers it, so it steps aside meanwhile
  // (.is-watching, BitCompanion.css): a class, as the redraw that keeps the choice leaves it on the drawer.
  async function preview(b) {
    const sprite = b.closest('.broom')?.querySelector('.broom-bit');
    const drawer = b.closest('.broom-drawer');
    if (!sprite || !b.dataset.value || !window.BitWarp) return;
    drawer?.classList.add('is-watching');
    try { await window.BitWarp.move(sprite, b.dataset.value); } finally { drawer?.classList.remove('is-watching'); }
  }

  // How: the effects, then the strolls only where it has a corner to stroll in.
  function moves(bit, h, P) {
    const p = bit.prefs || {};
    const warp = P.warp(p, h);
    for (const b of warp.querySelectorAll('button')) b.addEventListener('click', () => preview(b), { signal: h.signal });
    const parts = [line(h.say('mybit_guide_moves_line')), warp];
    if (p.place === 'corner' || p.place === 'both') parts.push(P.roam(p, h));
    return parts;
  }

  const can = (_bit, h) => CAN.map((key) => line(h.say(key)));

  const STEPS = [where, moves, can];

  // The drawer is drawn again on the next step; the focus goes to its question.
  function go(n, e, h) {
    const drawer = e.target.closest('.broom-drawer');
    step = n;
    h.redraw();
    drawer?.querySelector('[data-guide-step]')?.focus({ preventScroll: true });
  }

  function nav(at, h) {
    const row = makeEl('div', 'bitc-acts');
    if (at > 0) row.append(button(h.say('mybit_guide_back'), false, (e) => go(at - 1, e, h), h));
    const last = at === STEPS.length - 1;
    row.append(button(h.say(last ? 'mybit_guide_done' : 'mybit_guide_next'), true, (e) => (last ? done(h) : go(at + 1, e, h)), h));
    return row;
  }

  // Done only on its last step: closed before, or with an answer that fails, it is offered again next time.
  async function done(h) {
    h.close();
    const out = await h.post('/api/bit/prefs', { setup: true });
    if (out.ok) h.told(out);
  }

  /**
   * The setup drawer at its current step.
   * @param {object} bit the server's view of the Bit (GET /api/bit)
   * @param {{ say: Function, num: Function, post: Function, told: Function, redraw: Function, close: Function,
   *   signal: AbortSignal }} h the room's hands
   * @returns {{ title: string, body: HTMLElement } | null}
   */
  function build(bit, h) {
    const P = window.BitPanels?.parts;
    if (!P || !bit?.hatched) return null;
    const at = Math.min(step, STEPS.length - 1);
    const part = makeEl('section', 'bitc-part');
    const question = makeEl('h3', 'bitc-part-title', h.say(QUESTIONS[at]));
    question.tabIndex = -1;
    question.dataset.guideStep = String(at);
    part.append(line(h.say('mybit_guide_step', { n: h.num(at + 1), total: h.num(STEPS.length) })), question, ...STEPS[at](bit, h, P));
    const body = makeEl('div', 'broom-panel-body');
    body.append(part, nav(at, h));
    return { title: h.say('mybit_guide_title'), body };
  }

  window.BitSetup = Object.freeze({ due, first, build });
})();
