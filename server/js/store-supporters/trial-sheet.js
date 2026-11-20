'use strict';
// The free week asked from the app, with no code to copy. The sheet takes an
// email; the server (store-supporters/trial-claim.js) asks the hub to send it with
// a random claim. The email's "Start the trial" button confirms the address, and
// this sheet, which asks the server now and then, gets the trial code back once.
// It redeems that code where a pasted code goes (POST /api/features/lyrics/unlock,
// the Lyrics tile's paste path), and a caller with its own field (the unlock
// dialog) gets the code to paste there too. "Paste the code instead" is always one
// tap away, so the email's code keeps working as before.
//
// The asking: only while a request waits, every 5 s growing to every 30 s, for
// at most 30 minutes, then "Check again". Closing the sheet with a request still
// waiting keeps that quiet asking (the email's page says the trial starts by
// itself); "Use another address", the end of the page or the limit stop it. A
// request waiting from before a reload is picked up at start. On a paired phone
// the hub's own /trial page opens instead (the server refuses these routes there).
// Everything shown is built with textContent.
(() => {
  const FIRST_DELAY_MS = 5000;
  const GROWTH = 1.5;
  const MAX_DELAY_MS = 30000;
  const LIMIT_MS = 30 * 60 * 1000;
  const BOOT_DELAY_MS = 8000;

  // Pure: the wait before the next look.
  function nextDelay(prev) { return prev > 0 ? Math.min(MAX_DELAY_MS, Math.round(prev * GROWTH)) : FIRST_DELAY_MS; }

  // Pure but for the timers it is given: one loop of looks. It stops by itself on
  // an answer that ends the wait ('ready', 'started', 'none') or at the limit.
  function createPoller({ poll, onAnswer, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, limitMs = LIMIT_MS }) {
    let timer = null;
    let delay = 0;
    let startedAt = 0;
    let running = false;
    function stop() { running = false; if (timer) clearTimer(timer); timer = null; }
    function arm() { delay = nextDelay(delay); timer = setTimer(tick, delay); }
    async function tick() {
      timer = null;
      if (!running) return;
      let out = null;
      try { out = await poll(); } catch { out = null; }
      if (!running) return;
      const state = out?.state;
      if (state === 'ready' || state === 'started' || state === 'none') { stop(); onAnswer(out); return; }
      if (now() - startedAt >= limitMs) { stop(); onAnswer({ state: 'limit' }); return; }
      arm();
    }
    function start() { stop(); running = true; delay = 0; startedAt = now(); arm(); }
    return { start, stop, isRunning: () => running };
  }

  // Pure: the words for a refused request, and for a code that did not start the trial.
  const REQUEST_ERRORS = {
    bad_email: 'trial_sheet_err_email', trial_used: 'trial_err_used', rate_limited: 'devclean_unlock_rate',
    closed: 'trial_sheet_err_closed', app_cap: 'trial_sheet_err_busy',
  };
  const REDEEM_ERRORS = {
    trial_used: 'trial_err_used', limit: 'trial_err_other_pc', expired: 'trial_err_over', rate_limited: 'devclean_unlock_rate',
    bad_code: 'preset_redeem_bad', wrong_code: 'preset_redeem_bad', bad_request: 'preset_redeem_bad',
  };
  const requestErrorKey = (error) => REQUEST_ERRORS[error] || 'preset_redeem_offline';
  const redeemErrorKey = (error) => REDEEM_ERRORS[error] || 'preset_redeem_offline';
  // The three lines of the wait, in order.
  const WAIT_LINES = ['trial_sheet_wait_1', 'trial_sheet_wait_2', 'trial_sheet_wait_3'];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { nextDelay, createPoller, requestErrorKey, redeemErrorKey, WAIT_LINES, FIRST_DELAY_MS, MAX_DELAY_MS, LIMIT_MS };
  }
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const t = (k, fb) => { const v = (typeof window.t === 'function') ? window.t(k) : k; return (v === k && fb != null) ? fb : v; };
  const origin = () => (typeof SERVER === 'string' ? SERVER : '');
  const langCode = () => (typeof lang === 'string' && lang ? lang : 'en');
  const remote = () => !!window.__xenonRemote;
  const dateText = (ms) => (window.TrialPass ? window.TrialPass.dateText(ms) : new Date(ms).toLocaleDateString());
  const webPage = () => { try { window.open(window.Xenon.constants.trialUrl(langCode()), '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ } };

  async function call(path, body) {
    try {
      const res = await fetch(origin() + path, body === undefined ? undefined : {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return await res.json();
    } catch { return null; }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function cross() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'support-sheet-x');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M6 6l12 12M18 6L6 18');
    svg.appendChild(path);
    return svg;
  }
  function key(cls, label, onClick) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  let current = null;   // { overlay, sheet, title, body, letGo, onCode, view }
  const poller = createPoller({ poll: () => call('/api/community/trial/poll', {}), onAnswer: answered });

  // ── Views ──────────────────────────────────────────────────────────
  function show(view, title, nodes, focus) {
    if (!current) return;
    current.view = view;
    current.title.textContent = title;
    current.body.replaceChildren(...nodes);
    if (focus) { try { focus.focus(); } catch { /* not focusable yet */ } }
  }

  // "Paste the code instead": a field and a key in place of the link, here.
  function pasteBlock(prefill) {
    const wrap = el('div', 'trial-sheet-paste');
    const link = key('support-sheet-alt', t('trial_sheet_paste'), () => { link.hidden = true; box.hidden = false; field.focus(); });
    const box = el('div', 'trial-sheet-paste-box');
    const label = el('label', 'trial-sheet-label', t('trial_sheet_code'));
    const field = el('input', 'trial-sheet-input');
    field.type = 'text'; field.autocomplete = 'off'; field.spellcheck = false; field.setAttribute('autocapitalize', 'characters');
    field.id = 'trial-sheet-code'; label.htmlFor = field.id;
    const error = el('p', 'trial-sheet-error');
    error.setAttribute('aria-live', 'polite');
    const go = key('support-sheet-go', t('trial_sheet_start'), () => startWith(field.value, { error, go }));
    field.addEventListener('keydown', (e) => { if (e.key === 'Enter') go.click(); });
    box.append(label, field, error, go);
    box.hidden = !prefill; link.hidden = !!prefill;
    if (prefill) field.value = prefill;
    wrap.append(link, box);
    return wrap;
  }

  function formView() {
    const form = el('form', 'trial-sheet-form');
    form.noValidate = true;
    const label = el('label', 'trial-sheet-label', t('trial_sheet_email'));
    const email = el('input', 'trial-sheet-input');
    email.type = 'email'; email.autocomplete = 'email'; email.inputMode = 'email'; email.required = true;
    email.id = 'trial-sheet-email'; label.htmlFor = email.id;
    const news = el('label', 'trial-sheet-check');
    const box = el('input');
    box.type = 'checkbox';
    news.append(box, el('span', null, t('trial_sheet_news')));
    const error = el('p', 'trial-sheet-error');
    error.setAttribute('aria-live', 'polite');
    const web = key('support-sheet-alt', t('trial_sheet_web'), webPage);
    web.hidden = true;
    const send = el('button', 'support-sheet-go', t('trial_sheet_send'));
    send.type = 'submit';
    form.append(label, email, news, error, send);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      send.disabled = true; error.textContent = ''; web.hidden = true;
      const out = await call('/api/community/trial/request', { email: email.value, news: box.checked, lang: langCode() });
      send.disabled = false;
      if (out && out.ok === true && out.pending) { waitingView(out.match); poller.start(); return; }
      error.textContent = t(requestErrorKey(out?.error));
      web.hidden = !(out && out.error === 'app_cap');
      email.focus();
    });
    show('form', t('trial_sheet_title'), [el('p', 'support-sheet-lead', t('trial_sheet_lead')), form, web, pasteBlock('')], email);
  }

  // `note`: why the code the email gave did not start the trial; its field comes filled.
  function waitingView(match, still, note, code) {
    const steps = el('ul', 'trial-sheet-steps');
    for (const k of WAIT_LINES) steps.appendChild(el('li', null, t(k)));
    const nodes = [steps];
    if (match) {
      const box = el('div', 'trial-sheet-match-box');
      box.append(el('p', 'trial-sheet-note', t('trial_sheet_match')), el('p', 'trial-sheet-match', match));
      nodes.push(box);
    }
    const status = el('p', 'trial-sheet-status', note || t(still ? 'trial_sheet_still' : 'trial_sheet_waiting'));
    status.setAttribute('aria-live', 'polite');
    nodes.push(status);
    if (still) nodes.push(key('support-sheet-go', t('trial_sheet_check'), () => { waitingView(match, false); poller.start(); }));
    const other = key('support-sheet-alt', t('trial_sheet_other'), async () => { poller.stop(); await call('/api/community/trial/forget', {}); formView(); });
    nodes.push(pasteBlock(code || ''), other);
    show('waiting', t('trial_sheet_wait_title'), nodes, null);
    if (current) current.match = match;
  }

  function startedView(endsAt) {
    const done = key('support-sheet-go', t('trial_sheet_done'), close);
    show('started', t('trial_sheet_on_title'), [el('p', 'support-sheet-lead trial-sheet-on', t('trial_sheet_on').replace('{date}', dateText(endsAt))), done], done);
  }

  // ── Starting the trial with a code ─────────────────────────────────
  // The Lyrics tile's paste path: one /redeem with the code, which remembers the
  // trial on this PC. Then the caller's own field, when it gave one.
  async function startWith(code, ui) {
    const text = String(code || '').trim();
    if (!text) { if (ui) ui.error.textContent = t('preset_redeem_bad'); return false; }
    if (ui) { ui.go.disabled = true; ui.error.textContent = ''; }
    const out = await call('/api/features/lyrics/unlock', { code: text });
    if (ui) ui.go.disabled = false;
    let endsAt = out && Number.isFinite(out.trialEndsAt) ? out.trialEndsAt : 0;
    if (out && out.ok === true && !endsAt && window.TrialPass) {
      const st = await window.TrialPass.refresh();
      if (st && st.state === 'active') endsAt = st.endsAt;
    }
    if (!(out && out.ok === true && endsAt)) {
      const message = t(out && out.ok === true ? 'trial_sheet_err_start' : redeemErrorKey(out?.error));
      if (ui) ui.error.textContent = message;
      else if (current) waitingView(current.match, false, message, text);
      else toast('error', message);
      return false;
    }
    poller.stop();
    await call('/api/community/trial/forget', {});
    if (window.TrialPass) window.TrialPass.refresh();
    const onCode = current?.onCode;
    if (current) startedView(endsAt);
    else toast('success', t('trial_sheet_on').replace('{date}', dateText(endsAt)));
    if (typeof onCode === 'function') { try { onCode(text); } catch (e) { console.warn('trial sheet: caller', e); } }
    return true;
  }

  function toast(type, message) {
    if (window.XenonToast) window.XenonToast.show({ type, title: type === 'success' ? t('trial_sheet_on_title') : t('trial_sheet_title'), message, duration: 8000 });
  }

  async function answered(out) {
    const state = out?.state;
    if (state === 'ready') { await startWith(out.code, null); return; }
    if (state === 'started') {
      const st = window.TrialPass ? await window.TrialPass.refresh() : null;
      if (current && st && st.state === 'active') startedView(st.endsAt);
      return;
    }
    if (current?.view !== 'waiting') return;
    if (state === 'none') formView();
    else if (state === 'limit') waitingView(current.match, true);
  }

  // ── Open and close ─────────────────────────────────────────────────
  // `opts.onCode(code)`: the caller's own paste path, given the code once the trial is on.
  async function open(source, opts) {
    if (remote()) { webPage(); return false; }
    if (current) close();
    const overlay = el('div', 'support-sheet-overlay trial-sheet-overlay');
    const sheet = el('section', 'support-sheet trial-sheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-labelledby', 'trial-sheet-title');
    sheet.tabIndex = -1;
    sheet.dataset.source = String(source || 'other');
    const head = el('div', 'support-sheet-head');
    const title = el('h2', 'support-sheet-title');
    title.id = 'trial-sheet-title';
    const shut = key('support-sheet-close', null, close);
    shut.setAttribute('aria-label', t('close', 'Close'));
    shut.appendChild(cross());
    head.append(title, shut);
    const body = el('div', 'trial-sheet-body');
    sheet.append(head, body);
    overlay.appendChild(sheet);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
    const letGo = window.DialogFocus ? window.DialogFocus.hold(sheet, { start: shut, onEsc: close }) : null;
    current = { overlay, sheet, title, body, letGo, onCode: opts?.onCode, view: '', match: '' };
    const waiting = await call('/api/community/trial/pending');
    if (!current || current.overlay !== overlay) return true;
    if (waiting?.pending) { waitingView(waiting.match, false); poller.start(); }
    else formView();
    return true;
  }

  // A request still waiting keeps its quiet asking; anything else stops it.
  function close() {
    if (!current) return;
    const { overlay, letGo, view } = current;
    current = null;
    if (view !== 'waiting') poller.stop();
    if (letGo) letGo();
    overlay.remove();
  }

  window.addEventListener('pagehide', () => poller.stop());
  setTimeout(async () => {
    if (remote() || poller.isRunning()) return;
    const waiting = await call('/api/community/trial/pending');
    if (waiting?.pending && !poller.isRunning()) poller.start();
  }, BOOT_DELAY_MS);

  window.TrialSheet = Object.freeze({ open, close, isOpen: () => !!current });
})();
