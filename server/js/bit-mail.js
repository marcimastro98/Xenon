'use strict';
// Bit's mail, the screen side: the Mail button in the top bar, the box it
// opens, and the one sentence Bit says when a letter arrives.
//
// Channels (the month's drops, hub announcements, the supporter ask, the share
// invitation) call BitMail.post() instead of opening a popup, and register how
// their letter reads when opened. This file owns nothing about what a letter
// says; js/bit-mail-core.js owns the store and the "not now" rule.
//
// The button is hidden while the box is empty, so a new install has nothing
// extra in its bar. A green dot (Bit's colour) says a letter is unread; it does
// not pulse, because nothing in the box is urgent.
(function () {
  const el = makeEl;                 // shared DOM factory (textContent-safe) from utils.js
  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const core = window.BitMailCore;
  if (!core) return;

  const NOTE_DELAY_MS = 2500;        // letters posted together get one note
  const NOTE_RETRY_MS = 60 * 1000;   // a busy moment is retried, not skipped
  const NOTE_RETRIES = 30;
  const PHONE_MAX = 600;             // below this the box is a bottom sheet
  const GAP = 8;

  // Bit's pixel face, the same one Settings → Bit wears. Static, trusted markup.
  const FACE = '<svg viewBox="0 0 12 12" shape-rendering="crispEdges" aria-hidden="true"><rect x="6" y="0" width="1" height="2" fill="#6ee787"/><rect x="3" y="2" width="6" height="1" fill="#6ee787"/><rect x="2" y="3" width="8" height="6" fill="#6ee787"/><rect x="3" y="9" width="6" height="1" fill="#6ee787"/><rect x="3" y="10" width="2" height="1" fill="#6ee787"/><rect x="7" y="10" width="2" height="1" fill="#6ee787"/><rect x="4" y="4" width="1" height="2" fill="#0d1117"/><rect x="7" y="4" width="1" height="2" fill="#0d1117"/><rect x="4" y="7" width="1" height="1" fill="#0d1117"/><rect x="5" y="8" width="2" height="1" fill="#0d1117"/><rect x="7" y="7" width="1" height="1" fill="#0d1117"/></svg>';

  const renderers = new Map();
  let panel = null;
  let onKey = null;
  let onDown = null;

  const button = () => document.getElementById('bit-mail-btn');

  function lang() {
    try { return String(((typeof window.currentLang === 'function') ? window.currentLang() : window.LANG) || document.documentElement.lang || 'en').slice(0, 2); } catch { return 'en'; }
  }
  function when(at) {
    try { return new Intl.DateTimeFormat(lang(), { day: 'numeric', month: 'short' }).format(new Date(at)); } catch { return ''; }
  }

  // ── The button ─────────────────────────────────────────────────────────────
  function sync() {
    const b = button();
    if (!b) return;
    const all = core.list().length;
    const n = core.unread();
    b.hidden = all === 0;
    const dot = document.getElementById('bit-mail-dot');
    if (dot) dot.hidden = n === 0;
    const name = t('bitmail_title', "Bit's mail");
    const label = n ? name + ', ' + t('bitmail_unread', '{n} unread').replace('{n}', String(n)) : name;
    b.title = label;
    b.setAttribute('aria-label', label);
    b.setAttribute('aria-expanded', panel ? 'true' : 'false');
  }

  // ── The box ────────────────────────────────────────────────────────────────
  function place() {
    if (!panel) return;
    const phone = window.innerWidth <= PHONE_MAX || document.documentElement.classList.contains('is-phone');
    panel.classList.toggle('is-sheet', phone);
    if (phone) { panel.style.removeProperty('left'); panel.style.removeProperty('top'); return; }
    const b = button();
    const r = b && !b.hidden ? b.getBoundingClientRect() : null;
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const left = r ? Math.min(Math.max(GAP, r.left), window.innerWidth - w - GAP) : window.innerWidth - w - GAP;
    // Below the button when it fits, else beside it (the Minimal rail sits on a side).
    let top = r ? r.bottom + GAP : GAP * 8;
    if (r && top + h > window.innerHeight - GAP) top = Math.max(GAP, Math.min(r.top, window.innerHeight - h - GAP));
    panel.style.left = Math.round(left) + 'px';
    panel.style.top = Math.round(top) + 'px';
  }

  const BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const BIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  function iconButton(cls, svg, label, onClick) {
    const b = el('button', 'bitmail-icon ' + cls);
    b.type = 'button';
    b.innerHTML = svg;                     // static, trusted markup
    b.setAttribute('aria-label', label);
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  }

  // One bar for both views: Bit's face over the list; over a letter, the way
  // back takes the face's place and Delete sits beside the close button, so the
  // letter itself starts at its title.
  function head() {
    const h = el('div', 'bitmail-head');
    const lead = el('span', 'bitmail-lead');
    const tools = el('span', 'bitmail-tools');
    const x = el('button', 'bitmail-x', '×');
    x.type = 'button';
    x.setAttribute('aria-label', t('close', 'Close'));
    x.addEventListener('click', () => close());
    tools.appendChild(x);
    h.append(lead, el('h2', 'bitmail-title', t('bitmail_title', "Bit's mail")), tools);
    return h;
  }

  function setHead(onBack, onDelete) {
    const lead = panel && panel.querySelector('.bitmail-lead');
    const tools = panel && panel.querySelector('.bitmail-tools');
    if (!lead || !tools) return;
    const old = tools.querySelector('.bitmail-del');
    if (old) old.remove();
    if (!onBack) {
      const face = el('span', 'bitmail-face');
      face.innerHTML = FACE;
      lead.replaceChildren(face);
      return;
    }
    lead.replaceChildren(iconButton('bitmail-backbtn', BACK, t('bitmail_back', 'All letters'), onBack));
    tools.insertBefore(iconButton('bitmail-del', BIN, t('bitmail_delete', 'Delete'), onDelete), tools.firstChild);
  }

  function showList(body) {
    body.replaceChildren();
    setHead(null);
    const letters = core.list();
    if (!letters.length) { body.appendChild(el('p', 'bitmail-empty', t('bitmail_empty', 'No letters. Bit writes here when something new is out for you.'))); return; }
    const ul = el('ul', 'bitmail-list');
    for (const l of letters) {
      const li = el('li');
      const row = el('button', 'bitmail-row' + (l.read ? '' : ' is-unread'));
      row.type = 'button';
      const text = el('span', 'bitmail-row-text');
      text.appendChild(el('span', 'bitmail-row-title', l.title));
      if (l.line) text.appendChild(el('span', 'bitmail-row-line', l.line));
      row.append(text, el('span', 'bitmail-row-when', when(l.at)));
      row.addEventListener('click', () => showLetter(body, l.id));
      li.appendChild(row);
      ul.appendChild(li);
    }
    body.appendChild(ul);
  }

  function showLetter(body, id) {
    const l = core.get(id);
    if (!l) { showList(body); return; }
    core.markRead(id);
    sync();
    body.replaceChildren();
    const letter = el('article', 'bitmail-letter');
    letter.appendChild(el('h3', 'bitmail-letter-title', l.title));
    const ctx = { close, remove: () => { core.remove(id); sync(); showList(body); } };
    const draw = renderers.get(l.kind);
    try {
      if (draw) draw(l, letter, ctx);
      else if (l.line) letter.appendChild(el('p', 'bitmail-letter-line', l.line));
    } catch { if (l.line) letter.appendChild(el('p', 'bitmail-letter-line', l.line)); }
    body.appendChild(letter);
    body.scrollTop = 0;
    setHead(() => showList(body), ctx.remove);
    place();
    const back = panel && panel.querySelector('.bitmail-backbtn');
    if (back) back.focus({ preventScroll: true });
  }

  function open(id) {
    if (panel) close();
    panel = el('div', 'bitmail');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', t('bitmail_title', "Bit's mail"));
    const body = el('div', 'bitmail-body');
    panel.append(head(), body);
    document.body.appendChild(panel);
    if (id && core.get(id)) showLetter(body, id); else showList(body);
    place();
    sync();
    onKey = (e) => { if (e.key === 'Escape') close(); };
    // Outside the box closes it; the button toggles on its own click.
    onDown = (e) => { if (panel && !panel.contains(e.target) && !(button() && button().contains(e.target))) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    const x = panel.querySelector('.bitmail-x');
    if (!id && x) x.focus({ preventScroll: true });
  }

  function close() {
    if (!panel) return;
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', place);
    onKey = null; onDown = null;
    panel.remove();
    panel = null;
    sync();
  }

  function toggle() { if (panel) close(); else open(); }

  // ── Bit's note ─────────────────────────────────────────────────────────────
  // One sentence, at most once a day, never mid-task. A letter that missed its
  // note is still in the box with the dot on: nothing is lost by staying quiet.
  let fresh = [];
  let noteTimer = null;
  let tries = 0;

  function scheduleNote(delay) {
    if (noteTimer) return;
    noteTimer = setTimeout(sayNote, delay);
  }

  function pendingIds() {
    return fresh.filter((id) => { const l = core.get(id); return l && !l.read; });
  }

  function retry() {
    if (++tries <= NOTE_RETRIES) scheduleNote(NOTE_RETRY_MS);
    else fresh = [];
  }

  function sayNote() {
    noteTimer = null;
    if (!pendingIds().length || panel) { fresh = []; return; }
    if (core.quiet()) { retry(); return; }
    const I = window.XenonInterrupts;
    const speak = () => {
      const ids = pendingIds();
      if (!ids.length || panel) { fresh = []; return; }
      if (core.quiet()) { retry(); return; }
      fresh = [];
      tries = 0;
      if (!core.claimNote()) return;
      const one = ids.length === 1 ? core.get(ids[0]) : null;
      const line = one ? (one.note || one.title) : t('bitmail_note_many', "You have {n} new letters in Bit's mail.").replace('{n}', String(ids.length));
      if (!window.XenonToast) return;
      window.XenonToast.show({ type: 'info', kicker: 'Bit', title: line, duration: 9000, onClick: () => open(one ? one.id : null) });
    };
    if (I && typeof I.whenIdle === 'function') I.whenIdle(speak, { priority: I.PRIORITY.message });
    else speak();
  }

  // ── Channel API ────────────────────────────────────────────────────────────
  // post({ id, kind, title, line, note, data }) → true when it is a new letter.
  // `note` is the one sentence Bit says about it; `line` the summary in the list.
  function post(letter) {
    if (!core.post(letter)) return false;
    fresh.push(letter.id);
    sync();
    scheduleNote(NOTE_DELAY_MS);
    return true;
  }

  // register(kind, (letter, node, { close, remove }) => void) draws an opened letter.
  function register(kind, draw) {
    if (typeof kind === 'string' && typeof draw === 'function') renderers.set(kind, draw);
  }

  window.BitMail = { post, register, open, close, toggle, sync, unread: () => core.unread() };
  if (window.XenonInterrupts && typeof window.XenonInterrupts.registerOverlay === 'function') {
    window.XenonInterrupts.registerOverlay('.bitmail');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', sync, { once: true });
  else sync();
})();
