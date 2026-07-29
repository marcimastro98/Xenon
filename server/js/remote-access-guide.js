// The step-by-step phone setup, shown inside Settings → Telefono.
//
// The panel next to it is a set of switches: correct, dense, and no help at all
// to somebody who has just answered "my phone or tablet" and has never seen any
// of this. The only ordered list of steps that existed was `ra_https_how_*`,
// and it appeared ONLY after the secure door had already failed — so the one
// moment a person is guaranteed to be lost, the guidance was to read a link to
// a website. This is that guidance, in the app, in order, on the switches
// themselves.
//
// STATE DERIVED, no step cursor — the same shape as the Sunshine wizard in
// remote-control.js. Every "done" below is read from the live
// /api/remote-access/status the panel already holds, except three that no
// server can observe (something happened on the phone) and are ticked by hand.
// There is nothing to get stuck halfway through, and reloading the page or
// pairing from another surface lands on the right step by itself.
//
// It renders NOTHING of its own that the panel already knows how to draw: the
// pairing sheet, the setup progress, the failure reason and the manual command
// all come in through `ctx` from remote-access-page.js. Two copies of the QR
// code, or of the Tailscale error ladder, is how the two halves drift apart.
(function () {
  'use strict';

  // Local, per-PC UI state: which steps the user ticked by hand, and whether the
  // guide is open. Deliberately NOT a hub setting — the settings blob reaches
  // every paired phone and is rebuilt from the client model on every save, and
  // "I already added it to my home screen" is neither shared nor server-owned.
  const KEY = 'xenon.phoneGuide.v1';
  const DEFAULTS = { open: false, home: false, tsPhone: false, repaired: false };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
      const v = raw && typeof raw === 'object' ? raw : {};
      return {
        open: v.open === true,
        home: v.home === true,
        tsPhone: v.tsPhone === true,
        repaired: v.repaired === true,
      };
    } catch { return { ...DEFAULTS }; }
  }

  function save(patch) {
    const next = { ...load(), ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  }

  function isOpen() { return load().open; }
  function open() { save({ open: true }); repaint(); }
  function close() { save({ open: false }); repaint(); }

  function repaint() {
    if (window.RemoteAccessPage && typeof window.RemoteAccessPage.render === 'function') {
      window.RemoteAccessPage.render();
    }
  }

  // ── Small builders ───────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function tr(key, fallback) {
    if (typeof t !== 'function') return fallback;
    const v = t(key);
    return (v && v !== key) ? v : fallback;
  }

  /**
   * One step. `done` paints the tick and dims the body; `current` is what the
   * eye should land on. A step that is neither is still fully readable — this
   * is a guide, not a form, and somebody who wants to read ahead should be able
   * to.
   */
  function step(num, titleKey, titleText, done, current) {
    const box = el('div', 'ra-step' + (done ? ' done' : '') + (current ? ' current' : ''));
    const head = el('div', 'ra-step-head' + (done ? ' done' : ''));
    head.appendChild(el('span', 'ra-step-num', done ? '✓' : String(num)));
    head.appendChild(el('span', 'ra-step-title', tr(titleKey, titleText)));
    box.appendChild(head);
    const body = el('div', 'ra-step-body');
    box.appendChild(body);
    box.body = body;
    return box;
  }

  /** A "I have done this on the phone" tick, for what no server can observe. */
  function ackButton(flag, done) {
    const b = el('button', 'ra-btn ' + (done ? 'ghost small' : 'primary'),
      done ? tr('ra_guide_undo', 'Not done yet') : tr('ra_guide_ack', 'Done'));
    b.type = 'button';
    b.addEventListener('click', () => { save({ [flag]: !done }); repaint(); });
    return b;
  }

  function note(key, fallback) { return el('p', 'ra-note', tr(key, fallback)); }

  // ── The guide ────────────────────────────────────────────────────────────
  /**
   * @param ctx everything the panel already owns: the live status and the
   *            builders for the pieces that must not be reimplemented here.
   */
  function render(ctx) {
    const st = ctx.st || {};
    const local = load();
    const devices = Array.isArray(st.devices) ? st.devices : [];
    const paired = devices.length > 0;
    const tls = st.https || {};
    const setup = st.httpsSetup || {};
    const httpsUi = st.httpsSupported !== false;

    const wrap = el('div', 'ra-guide');

    const head = el('div', 'ra-guide-head');
    head.appendChild(el('h4', 'ra-guide-title', tr('ra_guide_title', 'Set up your phone, step by step')));
    const shut = el('button', 'ra-guide-close', tr('ra_guide_close', 'Close the guide'));
    shut.type = 'button';
    shut.addEventListener('click', close);
    head.appendChild(shut);
    wrap.appendChild(head);
    wrap.appendChild(el('p', 'ra-guide-sub', tr('ra_guide_sub',
      'Steps 1 to 3 put the dashboard on your phone at home. The rest is only needed if you want it to work away from home too.')));

    // ── At home ──
    const home = el('div', 'ra-steps');

    // 1 — the opt-in. The real switch, inside the step: sending someone to find
    // it further down the page is where a guide stops being one.
    const s1 = step(1, 'ra_guide_s1', 'Turn on access from other devices', st.enabled === true, st.enabled !== true);
    s1.body.appendChild(note('ra_guide_s1_body',
      'It is off until you turn it on. While it is off, Xenon answers this PC and nothing else.'));
    const row = el('label', 'ra-toggle-row');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = st.enabled === true;
    toggle.addEventListener('change', () => {
      toggle.disabled = true;
      ctx.act('/api/remote-access/enable', { value: toggle.checked });
    });
    row.appendChild(toggle);
    row.appendChild(el('span', 'ra-toggle-knob'));
    const rowText = el('span', 'ra-toggle-text');
    rowText.appendChild(el('strong', null, t('ra_enable')));
    rowText.appendChild(el('span', 'ra-toggle-hint', t('ra_enable_hint')));
    row.appendChild(rowText);
    s1.body.appendChild(row);
    home.appendChild(s1);

    // 2 — pairing. The panel's own sheet, moved here rather than copied: while
    // the guide is open the panel does not draw it, so there is exactly one QR
    // code on screen.
    const s2 = step(2, 'ra_guide_s2', 'Point your phone at the QR code', paired, st.enabled === true && !paired);
    if (st.enabled !== true) {
      s2.body.appendChild(note('ra_guide_s2_wait', 'Available once the switch above is on.'));
    } else if (!Array.isArray(st.addresses) || !st.addresses.length) {
      s2.body.appendChild(el('p', 'ra-warn', t('ra_no_network')));
    } else {
      s2.body.appendChild(note('ra_guide_s2_body',
        'The code is an invitation, not a password: it lasts three minutes and stops working after a few wrong tries. The dashboard opens in the phone browser. There is nothing to install on the phone.'));
      s2.body.appendChild(ctx.pairingSheet(st));
    }
    home.appendChild(s2);

    // 3 — the home screen. Nothing here can see it happen, and it is worth its
    // own step: it is what turns a browser tab into the thing people actually
    // use, and it is the only way the microphone and notifications work.
    const s3 = step(3, 'ra_guide_s3', 'Add it to the phone home screen', local.home, paired && !local.home);
    s3.body.appendChild(note('ra_guide_s3_body',
      'On iPhone open Share and then Add to Home Screen. On Android, Chrome offers to install it. Xenon then opens with its own icon, full screen, and the microphone and notifications work there.'));
    s3.body.appendChild(ackButton('home', local.home));
    home.appendChild(s3);

    wrap.appendChild(el('h5', 'ra-guide-group', tr('ra_guide_group_home', 'At home, on your own Wi-Fi')));
    wrap.appendChild(home);

    // ── Away from home ──
    if (httpsUi) {
      const away = el('div', 'ra-steps');

      // 4 — Tailscale on the PC. Everything the panel knows how to say about
      // this is reused: the running job, the reason it is not up, the exact
      // command where we cannot do it ourselves.
      const s4 = step(4, 'ra_guide_s4', 'Turn on the secure address', tls.running === true, paired && !tls.running);
      s4.body.appendChild(note('ra_guide_s4_body',
        'This gives this PC a name of its own that works from anywhere, over an encrypted connection. It uses Tailscale, which is free, and Xenon installs and signs in to it for you. You are not creating an account with Xenon.'));
      const httpsRow = el('label', 'ra-toggle-row');
      const httpsToggle = document.createElement('input');
      httpsToggle.type = 'checkbox';
      httpsToggle.checked = st.httpsEnabled === true;
      httpsToggle.addEventListener('change', () => {
        httpsToggle.disabled = true;
        ctx.act('/api/remote-access/https', { value: httpsToggle.checked });
      });
      httpsRow.appendChild(httpsToggle);
      httpsRow.appendChild(el('span', 'ra-toggle-knob'));
      const httpsText = el('span', 'ra-toggle-text');
      httpsText.appendChild(el('strong', null, t('ra_https')));
      httpsText.appendChild(el('span', 'ra-toggle-hint', t('ra_https_hint')));
      httpsRow.appendChild(httpsText);
      s4.body.appendChild(httpsRow);
      if (setup.running) {
        s4.body.appendChild(ctx.setupProgress(setup));
      } else if (st.httpsEnabled === true && !tls.running) {
        s4.body.appendChild(ctx.httpsFailure(st));
      } else if (tls.running) {
        const on = el('p', 'ra-https-on');
        on.appendChild(el('span', null, t('ra_https_url') + ' '));
        on.appendChild(el('code', null, tls.url));
        s4.body.appendChild(on);
      }
      away.appendChild(s4);

      // 5 — the certificate switch. The one step of the whole product that
      // happens on somebody else's website, and the one nobody would guess.
      const s5 = step(5, 'ra_guide_s5', 'Turn on HTTPS certificates in your Tailscale account',
        tls.running === true, st.httpsEnabled === true && !tls.running);
      s5.body.appendChild(note('ra_guide_s5_body',
        'This is the one step Xenon cannot do for you. Open the Tailscale admin console, scroll to HTTPS Certificates and press Enable. It is free on every plan. Then come back here: Xenon has carried on waiting.'));
      const admin = el('a', 'ra-btn primary', t('ra_https_open_admin'));
      admin.href = ctx.tailnetAdmin;
      admin.target = '_blank';
      admin.rel = 'noopener noreferrer';
      s5.body.appendChild(admin);
      away.appendChild(s5);

      // 6 — Tailscale on the PHONE. The step people miss, and it is easy to
      // spot: the address does not open at all. Say that here, before they hit
      // it and go looking at their router.
      const s6 = step(6, 'ra_guide_s6', 'Install Tailscale on the phone, same account',
        local.tsPhone, tls.running === true && !local.tsPhone);
      s6.body.appendChild(note('ra_guide_s6_body',
        'Get it from the App Store or Google Play, sign in with the same account you just used, and turn its switch on. This is the step people forget. When it is missing the phone says it cannot open the address at all: nothing is broken, that address only exists inside your own network.'));
      s6.body.appendChild(ackButton('tsPhone', local.tsPhone));
      away.appendChild(s6);

      // 7 — pair again. A pairing belongs to the address it was made on, so the
      // phone paired at home is not paired on the secure name.
      const s7 = step(7, 'ra_guide_s7', 'Pair the phone again on the new address',
        local.repaired, local.tsPhone && !local.repaired);
      s7.body.appendChild(note('ra_guide_s7_body',
        'Press Add device in step 2 and scan again. The browser ties a pairing to the address it was made on, so a phone paired on the home address is not paired on the secure one. After this you only need the new address, at home and away.'));
      s7.body.appendChild(ackButton('repaired', local.repaired));
      away.appendChild(s7);

      wrap.appendChild(el('h5', 'ra-guide-group', tr('ra_guide_group_away', 'Away from home (optional)')));
      wrap.appendChild(away);
    }

    // ── The end ──
    // Only with a paired device: until there is one, "hide Xenon from this PC"
    // would hide the only screen showing the dashboard.
    if (paired) wrap.appendChild(finishBlock());

    return wrap;
  }

  /**
   * What happens to the window on this PC — asked, never assumed.
   *
   * Choosing "my phone or tablet" in the first-run picker no longer implies it:
   * plenty of people want the dashboard on the phone AND on the PC, and taking
   * the PC's window away as a side effect of answering a question about where
   * they want the dashboard is a setting the user never made.
   */
  function finishBlock() {
    const box = el('div', 'ra-guide-done');
    box.appendChild(el('h5', 'ra-guide-done-title', tr('ra_guide_done_title', 'That is the setup done')));
    box.appendChild(el('p', 'ra-note', tr('ra_guide_done_body',
      'Your phone is paired. Last thing: should Xenon keep opening on this PC as well?')));

    const native = window.XenonNative;
    const canHide = !!(native && native.isNative && typeof native.choosePhoneScreen === 'function');

    const row = el('div', 'ra-guide-actions');

    const keep = el('button', 'ra-btn primary', tr('ra_guide_keep', 'Keep it here too'));
    keep.type = 'button';
    keep.addEventListener('click', () => {
      if (typeof window.setSurfaceChoice === 'function') {
        window.setSurfaceChoice({ kind: 'both', asked: true, monitor: '', label: '' });
      }
      if (typeof window.renderSurfaceSection === 'function') window.renderSurfaceSection();
      close();
    });
    row.appendChild(keep);

    if (canHide) {
      const hide = el('button', 'ra-btn ghost', tr('ra_guide_hide', 'Hide Xenon on this PC'));
      hide.type = 'button';
      hide.addEventListener('click', () => {
        // Settings first, shell second: the stored choice is what the next
        // launch reads, and it must already be written when the window goes.
        if (typeof window.setSurfaceChoice === 'function') {
          window.setSurfaceChoice({ kind: 'phone', asked: true, monitor: '', label: '' });
        }
        if (typeof window.renderSurfaceSection === 'function') window.renderSurfaceSection();
        close();
        native.choosePhoneScreen(true);
      });
      row.appendChild(hide);
    }
    box.appendChild(row);

    box.appendChild(el('p', 'ra-note', canHide
      ? tr('ra_guide_hide_note',
        'Hiding it stops Xenon opening on this PC, at login too. It keeps running in the background, so the phone keeps working. Bring the window back from the Xenon icon next to the clock, or from Settings, then Screen.')
      : tr('ra_guide_hide_browser',
        'This is the dashboard in a browser, so there is no window to hide. In the Xenon app you can also choose to have it stop opening on this PC.')));
    return box;
  }

  window.RemoteAccessGuide = { isOpen, open, close, render };
})();
