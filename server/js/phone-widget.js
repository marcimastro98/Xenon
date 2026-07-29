'use strict';
// Phone widget — the paired phone's call log, phonebook and dialler.
//
// Everything on screen here came off the user's own phone over Bluetooth, so
// every string is untrusted: names, numbers and the phone's own device name all
// go through textContent, never innerHTML.
//
// Two behaviours are deliberate and easy to "simplify" wrongly.
//
//  1. THE CONTACTS PULL IS LAZY. Reading the phonebook opens a Bluetooth
//     channel other software on the PC also wants, and takes a second or two.
//     The call log is what the tile shows first because it is short and it is
//     what people look at; contacts load the first time the user asks for them.
//
//  2. PLACING A CALL ASKS FIRST. This runs on a touchscreen that lives on a
//     desk, and a call is the one action in the product that costs money and
//     rings another human being. A single stray tap must not be able to do it.
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let status = null;        // null = not asked yet
  let recents = null;       // null = not loaded; [] = loaded, empty
  let contacts = null;      // null = never pulled (lazy, see the header)
  let live = { incoming: false, active: false };
  let tab = 'recents';      // 'recents' | 'contacts' | 'dial'
  let query = '';
  let typed = '';           // the dialler's own number
  let msgList = null;       // null = never pulled (lazy, like contacts)
  let openMsg = null;       // { handle, name, number, body } — the open message
  let draft = '';           // the reply being typed
  let pending = null;       // { kind:'call'|'send', name, number, text } — the confirm sheet
  let busy = false;
  let seeded = false;
  let notice = '';          // one line about the last action, cleared on the next

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="phone"]')).filter(n => n.closest('.pager-page'));
  }

  // ── Formatting ───────────────────────────────────────────────────────────

  function when(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hhmm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    if (sameDay) return hhmm;
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return t('phone_yesterday', 'Yesterday') + ' ' + hhmm;
    return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // Direction glyphs. Missed is the only one that carries colour, because it is
  // the only one the user might need to act on.
  const ARROWS = {
    in: 'M7 17 17 7M17 7H9m8 0v8',
    out: 'M17 7 7 17M7 17h8m-8 0V9',
    missed: 'M17 7 7 17M7 17h8m-8 0V9',
  };

  function arrow(direction) {
    const span = el('span', 'phw-dir is-' + (direction || 'unknown'));
    const path = ARROWS[direction] || 'M12 5v14';
    // Static, trusted markup — the only innerHTML in this file.
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
      + 'stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg>';
    return span;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '#';
    // Intl-safe first character of up to two words. Array.from avoids splitting
    // an emoji or an accented letter in half, which a name really can start with.
    const take = (s) => Array.from(s)[0] || '';
    return (take(parts[0]) + (parts.length > 1 ? take(parts[1]) : '')).toUpperCase();
  }

  // ── Rows ─────────────────────────────────────────────────────────────────

  function personRow(name, sub, direction, number, at) {
    const row = el('button', 'phw-row');
    row.type = 'button';

    const av = el('span', 'phw-avatar');
    av.appendChild(el('span', 'phw-initials', initials(name || sub)));
    row.appendChild(av);

    const body = el('div', 'phw-body');
    const top = el('div', 'phw-line');
    if (direction) top.appendChild(arrow(direction));
    top.appendChild(el('span', 'phw-name', name || sub || t('phone_unknown', 'Unknown')));
    body.appendChild(top);
    if (name && sub) body.appendChild(el('div', 'phw-sub', sub));
    row.appendChild(body);

    if (at) row.appendChild(el('span', 'phw-when', when(at)));

    if (canDial() && number) {
      row.classList.add('is-callable');
      row.addEventListener('click', () => askCall(name, number));
      row.title = t('phone_call', 'Call');
    } else {
      row.disabled = true;
    }
    return row;
  }

  // ── Views ────────────────────────────────────────────────────────────────

  function canDial() {
    return !!(status && status.ok && status.canDial);
  }

  function emptyNote(text) {
    return el('div', 'phw-empty', text);
  }

  // What is wrong, in one sentence, in the user's language — and only ever
  // something they can act on. A raw error code on a dashboard is noise.
  function problemFor(reason) {
    const r = String(reason || '');
    if (r === 'disabled') return t('phone_off', 'Phone is off. Turn it on in Settings.');
    // Not a fault and not a missing download: the Bluetooth side of this only
    // exists on Windows so far. Saying "the phone is not answering" here would
    // send somebody to check a phone that is working perfectly.
    if (r === 'platform_unsupported') return t('phone_platform', 'Not available on this system yet.');
    if (r === 'helper_missing') return t('phone_needs_helper', 'Needs the Xenon Helper.');
    if (r === 'no_paired_phonebook' || r === 'no_paired_messages') return t('phone_not_paired', 'No phone paired over Bluetooth.');
    // On Windows this one is routine rather than exceptional: Phone Link holds
    // the same channel whenever it runs, and Xenon never takes it away.
    if (r === 'channel_busy' || /channel_unavailable/.test(r)) return t('phone_busy_channel', 'Another app is using the phone connection.');
    if (r === 'message_too_long') return t('phone_too_long', 'That message is too long.');
    if (r === 'empty_message') return t('phone_empty', 'Write something first.');
    if (/forbidden|unauthorized/.test(r)) return t('phone_not_allowed', 'Allow contact sharing for this PC on your phone.');
    if (r === 'phone_timeout') return t('phone_timeout', 'The phone did not answer in time.');
    return t('phone_error', 'Could not reach the phone.');
  }

  function head() {
    const bar = el('div', 'phw-head');
    const title = el('div', 'phw-title');
    title.appendChild(el('span', 'phw-device',
      (status && status.device) || t('layout_widget_phone', 'Phone')));
    if (live.active) title.appendChild(el('span', 'phw-badge is-active', t('phone_in_call', 'In call')));
    else if (live.incoming) title.appendChild(el('span', 'phw-badge is-ring', t('phone_ringing', 'Ringing')));
    bar.appendChild(title);

    const refresh = el('button', 'phw-icon-btn');
    refresh.type = 'button';
    refresh.title = t('phone_refresh', 'Refresh');
    refresh.setAttribute('aria-label', t('phone_refresh', 'Refresh'));
    refresh.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
      + 'stroke-linecap="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>';
    refresh.disabled = busy;
    refresh.addEventListener('click', () => reload(true));
    bar.appendChild(refresh);
    return bar;
  }

  function tabsBar() {
    const bar = el('div', 'phw-tabs');
    const items = [
      ['recents', t('phone_tab_recents', 'Recents')],
      ['contacts', t('phone_tab_contacts', 'Contacts')],
    ];
    if (hasMessages()) items.push(['messages', t('phone_tab_messages', 'Messages')]);
    if (canDial()) items.push(['dial', t('phone_tab_dial', 'Keypad')]);
    for (const [id, label] of items) {
      const b = el('button', 'phw-tab' + (tab === id ? ' is-on' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => {
        tab = id;
        openMsg = null;
        // The phonebook and the message list are only fetched when somebody
        // asks to see them: both open a Bluetooth channel other software wants.
        if (id === 'contacts' && contacts === null) loadContacts();
        if (id === 'messages' && msgList === null) loadMessages();
        paint();
      });
      bar.appendChild(b);
    }
    return bar;
  }

  function recentsView() {
    const list = el('div', 'phw-list');
    if (recents === null) return emptyNote(t('phone_loading', 'Reading the phone…'));
    if (!recents.length) return emptyNote(t('phone_no_calls', 'No recent calls.'));
    for (const c of recents.slice(0, 40)) {
      list.appendChild(personRow(c.name, c.number, c.direction, c.number, c.at));
    }
    return list;
  }

  function contactsView() {
    const wrap = el('div', 'phw-pane');
    const search = el('input', 'phw-search');
    search.type = 'search';
    search.placeholder = t('phone_search', 'Search contacts');
    search.value = query;
    search.addEventListener('input', () => {
      query = search.value;
      repaintList(wrap, contactList());
    });
    wrap.appendChild(search);
    wrap.appendChild(contactList());
    return wrap;
  }

  function contactList() {
    if (contacts === null) return emptyNote(t('phone_loading', 'Reading the phone…'));
    const q = query.trim().toLowerCase();
    const matches = contacts.filter((c) => {
      if (!q) return true;
      if (String(c.name || '').toLowerCase().includes(q)) return true;
      return (c.numbers || []).some(n => String(n.value || '').replace(/\s/g, '').includes(q.replace(/\s/g, '')));
    });
    if (!matches.length) return emptyNote(q ? t('phone_no_match', 'Nobody matches that.') : t('phone_no_contacts', 'No contacts.'));
    const list = el('div', 'phw-list');
    for (const c of matches.slice(0, 300)) {
      const first = (c.numbers && c.numbers[0]) || null;
      list.appendChild(personRow(c.name, first ? first.value : '', '', first ? first.value : '', 0));
    }
    return list;
  }

  function repaintList(wrap, next) {
    const old = wrap.querySelector('.phw-list, .phw-empty');
    if (old) old.replaceWith(next); else wrap.appendChild(next);
  }

  function hasMessages() {
    return !!(status && status.ok && status.map);
  }

  // Whether message text is masked until tapped. The same answer the
  // notification mirror already gives to the same problem: a dashboard sits on
  // a desk in the open, and an inbox is full of one-time login codes.
  function maskText() {
    return !!(status && status.hide);
  }

  function messagesView() {
    const wrap = el('div', 'phw-pane');
    if (openMsg) return messageDetail();
    if (msgList === null) return emptyNote(t('phone_loading', 'Reading the phone…'));
    if (!msgList.length) return emptyNote(t('phone_no_messages', 'No messages.'));

    const list = el('div', 'phw-list');
    for (const m of msgList.slice(0, 40)) {
      const row = el('button', 'phw-row is-callable' + (m.read ? '' : ' is-unread'));
      row.type = 'button';

      const av = el('span', 'phw-avatar');
      av.appendChild(el('span', 'phw-initials', initials(m.name || m.number)));
      row.appendChild(av);

      const body = el('div', 'phw-body');
      const top = el('div', 'phw-line');
      if (!m.read) top.appendChild(el('span', 'phw-unread-dot'));
      top.appendChild(el('span', 'phw-name', m.name || m.number || t('phone_unknown', 'Unknown')));
      body.appendChild(top);
      body.appendChild(el('div', 'phw-sub' + (maskText() ? ' is-masked' : ''),
        maskText() ? t('phone_hidden', 'Tap to show') : m.preview));
      row.appendChild(body);
      row.appendChild(el('span', 'phw-when', when(m.at)));

      row.addEventListener('click', () => openMessage(m));
      list.appendChild(row);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function messageDetail() {
    const wrap = el('div', 'phw-pane phw-thread');

    const bar = el('div', 'phw-thread-head');
    const back = el('button', 'phw-icon-btn', '‹');
    back.type = 'button';
    back.title = t('phone_back', 'Back');
    back.addEventListener('click', () => { openMsg = null; draft = ''; paint(); });
    bar.appendChild(back);
    bar.appendChild(el('span', 'phw-name', openMsg.name || openMsg.number || t('phone_unknown', 'Unknown')));
    wrap.appendChild(bar);

    const body = el('div', 'phw-thread-body');
    body.appendChild(el('p', 'phw-msg-text',
      openMsg.body === null ? t('phone_loading', 'Reading the phone…') : (openMsg.body || '')));
    wrap.appendChild(body);

    // Replying needs a number. A message from an alphanumeric sender (a bank,
    // a delivery service) has none, and those cannot be replied to at all — so
    // the box is absent rather than present and refusing.
    const to = openMsg.number || '';
    if (to && /\d/.test(to)) {
      const compose = el('div', 'phw-compose');
      const input = el('textarea', 'phw-input');
      input.rows = 2;
      input.maxLength = 1000;
      input.placeholder = t('phone_reply', 'Reply');
      input.value = draft;
      input.addEventListener('input', () => { draft = input.value; sendBtn.disabled = !draft.trim() || busy; });
      compose.appendChild(input);

      const sendBtn = el('button', 'phw-call-btn', t('phone_send', 'Send'));
      sendBtn.type = 'button';
      sendBtn.disabled = !draft.trim() || busy;
      sendBtn.addEventListener('click', () => askSend(openMsg.name, to, draft.trim()));
      compose.appendChild(sendBtn);
      wrap.appendChild(compose);
    }
    return wrap;
  }

  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

  function dialView() {
    const wrap = el('div', 'phw-dial');
    const display = el('div', 'phw-dial-value', typed || ' ');
    wrap.appendChild(display);

    const pad = el('div', 'phw-pad');
    for (const k of KEYS) {
      const b = el('button', 'phw-key', k);
      b.type = 'button';
      b.addEventListener('click', () => {
        if (typed.length < 24) typed += k;
        display.textContent = typed || ' ';
      });
      pad.appendChild(b);
    }
    wrap.appendChild(pad);

    const actions = el('div', 'phw-dial-actions');
    const back = el('button', 'phw-icon-btn', '⌫');
    back.type = 'button';
    back.title = t('phone_backspace', 'Delete');
    back.addEventListener('click', () => {
      typed = typed.slice(0, -1);
      display.textContent = typed || ' ';
    });
    actions.appendChild(back);

    const call = el('button', 'phw-call-btn', t('phone_call', 'Call'));
    call.type = 'button';
    call.addEventListener('click', () => { if (typed.trim()) askCall('', typed.trim()); });
    actions.appendChild(call);
    wrap.appendChild(actions);
    return wrap;
  }

  // The confirm sheet. It names the number in full: a tap that starts a real
  // call has to show what it is about to dial, not just who it thinks it is.
  function confirmSheet() {
    const sending = pending.kind === 'send';
    const sheet = el('div', 'phw-confirm');
    const card = el('div', 'phw-confirm-card');
    card.appendChild(el('div', 'phw-confirm-q', sending
      ? t('phone_confirm_send', 'Send this message?')
      : t('phone_confirm', 'Place this call?')));
    if (pending.name) card.appendChild(el('div', 'phw-confirm-name', pending.name));
    card.appendChild(el('div', 'phw-confirm-num', pending.number));
    // The message is shown back in full before it goes. It cannot be recalled,
    // and it leaves under the user's own number.
    if (sending) card.appendChild(el('div', 'phw-confirm-text', pending.text));

    const row = el('div', 'phw-confirm-actions');
    const no = el('button', 'phw-btn', t('dlg_cancel', 'Cancel'));
    no.type = 'button';
    no.addEventListener('click', () => { pending = null; paint(); });
    const yes = el('button', 'phw-btn is-primary',
      sending ? t('phone_send', 'Send') : t('phone_call', 'Call'));
    yes.type = 'button';
    yes.disabled = busy;
    yes.addEventListener('click', sending ? doSend : doCall);
    row.append(no, yes);
    card.appendChild(row);
    sheet.appendChild(card);
    return sheet;
  }

  function view() {
    const wrap = el('div', 'phw-wrap');
    wrap.appendChild(head());

    if (!status) { wrap.appendChild(emptyNote(t('phone_loading', 'Reading the phone…'))); return wrap; }
    if (!status.ok) { wrap.appendChild(emptyNote(problemFor(status.reason))); return wrap; }
    if (!status.pbap && !status.telephony) {
      wrap.appendChild(emptyNote(problemFor('no_paired_phonebook')));
      return wrap;
    }

    wrap.appendChild(tabsBar());
    if (tab === 'contacts') wrap.appendChild(contactsView());
    else if (tab === 'messages' && hasMessages()) wrap.appendChild(messagesView());
    else if (tab === 'dial') wrap.appendChild(dialView());
    else wrap.appendChild(recentsView());

    if (notice) wrap.appendChild(el('div', 'phw-notice', notice));
    if (pending) wrap.appendChild(confirmSheet());
    return wrap;
  }

  function paint() {
    for (const tile of tiles()) {
      const mount = tile.querySelector('.phone-widget-mount') || tile;
      mount.textContent = '';
      mount.appendChild(view());
    }
  }

  // ── Data ─────────────────────────────────────────────────────────────────

  async function loadStatus(force) {
    const d = await api('/api/phone' + (force ? '?refresh=1' : ''));
    status = d || { ok: false, reason: 'phone_error' };
    if (d && d.state) live = { incoming: !!d.state.incoming, active: !!d.state.active };
  }

  async function loadCalls(force) {
    const d = await api('/api/phone/calls' + (force ? '?refresh=1' : ''));
    // A failed refresh still carries the last good list, so the tile keeps
    // showing what it had instead of blanking.
    recents = (d && Array.isArray(d.list)) ? d.list : (recents || []);
    if (d && d.ok === false) notice = problemFor(d.reason);
  }

  async function loadContacts(force) {
    if (contacts === null) contacts = [];   // stop a second tab switch re-firing
    const d = await api('/api/phone/contacts' + (force ? '?refresh=1' : ''));
    contacts = (d && Array.isArray(d.list)) ? d.list : (contacts || []);
    if (d && d.ok === false) notice = problemFor(d.reason);
    paint();
  }

  async function reload(force) {
    if (busy) return;
    busy = true;
    notice = '';
    paint();
    try {
      await loadStatus(force);
      await loadCalls(force);
      if (contacts !== null) await loadContacts(force);
      if (msgList !== null) await loadMessages(force);
    } finally {
      busy = false;
      paint();
    }
  }

  async function loadMessages(force) {
    if (msgList === null) msgList = [];   // a second tab switch must not re-fire
    const d = await api('/api/phone/messages?folder=inbox' + (force ? '&refresh=1' : ''));
    msgList = (d && Array.isArray(d.list)) ? d.list : (msgList || []);
    if (d && d.ok === false) notice = problemFor(d.reason);
    paint();
  }

  async function openMessage(m) {
    // The body is fetched on open rather than with the list: it is the part of
    // this worth not holding on to, and the list already shows enough to choose.
    openMsg = { handle: m.handle, name: m.name, number: m.number, body: null };
    draft = '';
    notice = '';
    paint();
    const d = await api('/api/phone/message?folder=inbox&handle=' + encodeURIComponent(m.handle));
    if (!openMsg || openMsg.handle !== m.handle) return;   // the user moved on
    if (d && d.ok && d.message) {
      openMsg.body = d.message.body || '';
      if (!openMsg.name && d.message.name) openMsg.name = d.message.name;
      if (!openMsg.number && d.message.number) openMsg.number = d.message.number;
    } else {
      openMsg.body = '';
      notice = problemFor(d && d.reason);
    }
    paint();
  }

  function askCall(name, number) {
    if (!canDial()) return;
    pending = { kind: 'call', name: String(name || ''), number: String(number || '') };
    notice = '';
    paint();
  }

  function askSend(name, number, text) {
    if (!text) return;
    pending = { kind: 'send', name: String(name || ''), number: String(number || ''), text: String(text) };
    notice = '';
    paint();
  }

  async function doSend() {
    if (!pending || busy) return;
    const { number, text } = pending;
    busy = true;
    paint();
    try {
      const res = await fetch(SERVER + '/api/phone/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, text }),
      });
      const out = res.ok ? await res.json().catch(() => null) : null;
      if (out && out.ok) {
        notice = t('phone_sent', 'Message sent.');
        draft = '';
      } else {
        notice = problemFor(out && out.error);
      }
    } catch {
      notice = problemFor('phone_error');
    } finally {
      pending = null;
      busy = false;
      paint();
    }
  }

  async function doCall() {
    if (!pending || busy) return;
    const number = pending.number;
    busy = true;
    paint();
    try {
      // A plain fetch, never keepalive: the response decides what the user is
      // told, and a swallowed rejection here would look like a placed call.
      const res = await fetch(SERVER + '/api/phone/dial', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number }),
      });
      const out = res.ok ? await res.json().catch(() => null) : null;
      if (out && out.ok) {
        notice = t('phone_calling', 'Calling…');
        typed = '';
      } else {
        notice = problemFor(out && out.error);
      }
    } catch {
      notice = problemFor('phone_error');
    } finally {
      pending = null;
      busy = false;
      paint();
    }
  }

  // ── Entry points ─────────────────────────────────────────────────────────

  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();
    if (!seeded) { seeded = true; reload(false); }
  }

  // The live call state, pushed by the server. Only repaints when something the
  // tile actually shows has changed.
  function onSSE(d) {
    if (!d || typeof d !== 'object') return;
    const incoming = d.incoming === true;
    const active = d.active === true;
    const changed = incoming !== live.incoming || active !== live.active;
    live = { incoming, active };
    if (!changed) return;
    // A call that just ended is a new row in the log — but the phone writes it
    // a moment after the fact, so the refresh waits rather than racing it.
    if (!incoming && !active && seeded) setTimeout(() => loadCalls(true).then(paint), 2500);
    paint();
  }

  window.PhoneWidget = { renderWidgets, onSSE };
})();
