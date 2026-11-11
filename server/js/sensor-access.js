'use strict';
// Shared "sensors need administrator rights" affordance.
//
// LibreHardwareMonitor reads CPU temperature, fan RPM and CPU watts through a
// kernel driver it can only load elevated. Since 5.1.0 Xenon itself never runs
// elevated: one UAC prompt (POST /system/enable-sensors) installs the "Xenon
// Sensors" service, which reads them from Program Files and leaves the readings
// where the engine can read them. Shared by the Fans and Energy widgets and by
// Settings → Performance ("Hardware sensors", #settings-sensors-hub) so the fix
// is wherever the user notices the problem.
(function () {
  const el = makeEl;
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // Message per outcome the server reports. Anything unknown falls back to the
  // generic failure rather than claiming success.
  function resultText(res) {
    const status = res && res.status;
    if (status === 'declined') return { cls: 'is-warn', text: t('sensors_enable_declined', 'You cancelled the Windows prompt, so nothing changed. You can try again any time.') };
    if (status === 'raised_no_restart') return { cls: 'is-warn', text: t('sensors_enable_no_restart', 'Permission granted! Just one step left: restart your computer and the sensors will switch on by themselves.') };
    // The task was raised either way; only the sensor reader is missing.
    if (status === 'no_winget' || status === 'install_failed') return { cls: 'is-warn', text: t('sensors_install_failed', 'The sensor reader could not be installed. Check the internet connection and try again.') };
    return { cls: 'is-warn', text: t('sensors_enable_failed', 'That didn’t work. Restart your computer and try once more.') };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Wait for the restarted backend to answer again. GET /version is the smallest
  // endpoint that proves the server is up (the updater polls the same one).
  async function waitForServer(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(700);
      try {
        const r = await fetch('/version', { cache: 'no-store' });
        if (r.ok) return true;
      } catch { /* still down */ }
    }
    return false;
  }

  // The answer now arrives a moment BEFORE the elevated helper stops this
  // server (it has to, to be sent at all), so wait for the old one to go away
  // first; asking it about the sensors would describe the state before the fix.
  async function waitForDown(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { await fetch('/version', { cache: 'no-store' }); } catch { return true; }
      await sleep(400);
    }
    return false;
  }

  // Never claim success from a status string alone: the whole point of this
  // button is that the sensors read, so ask the new server whether they do. A
  // server that just started has not read them yet (null): ask again briefly.
  async function verifyAccess() {
    for (let i = 0; i < 12; i++) {
      const sys = await apiJson('/system');
      if (sys && sys.sensorAccess) return sys.sensorAccess;
      await sleep(1000);
    }
    return null;
  }

  // After a 'service' answer the old reading ('needs_admin'/'missing') can
  // linger until the next poll: wait for 'ok' rather than taking the first one.
  async function verifyServiceAccess() {
    for (let i = 0; i < 25; i++) {
      const sys = await apiJson('/system');
      if (sys && sys.sensorAccess === 'ok') return 'ok';
      await sleep(1000);
    }
    return null;
  }

  // A hint line plus the repair button. `text` is the caller's already-localized
  // explanation of what is missing (fans vs CPU watts read differently).
  // `cls` ADDS the caller's placement class — it never replaces `sa-hint`, which
  // carries the layout: without it the text/status blocks (max-width, so they do
  // not self-centre) pin left while the inline button centres, and the block falls
  // apart. `install`: the sensor reader itself is missing ('missing'), so the
  // same prompt also installs it and the wait is longer; the label says so.
  // `label` overrides the key's text (the outdated-service card).
  function hintNode(text, cls, install, label) {
    const wrap = el('div', 'sa-hint' + (cls ? ' ' + cls : ''));
    wrap.appendChild(el('div', 'sa-hint-text', text));

    const btn = el('button', 'sa-btn');
    btn.type = 'button';
    btn.textContent = label || (install ? t('sensors_install_btn', 'Install sensors') : t('sensors_enable_btn', 'Enable sensors'));
    const status = el('div', 'sa-status');

    const say = (cls, text) => { status.className = 'sa-status' + (cls ? ' ' + cls : ''); status.textContent = text; };

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      say('', install
        ? t('sensors_install_busy', 'Confirm the Windows prompt. Installing takes a minute or two…')
        : t('sensors_enable_busy', 'Confirm the Windows prompt…'));

      let res = null;
      try {
        // No keepalive: this waits on a UAC prompt the user may take a while to
        // answer, and the reply carries an outcome we must not guess at.
        const r = await fetch('/system/enable-sensors', { method: 'POST' });
        res = await r.json();
      } catch {
        // Expected on SUCCESS: the elevated helper stops this very server to
        // restart it through the (now elevated) task, so the reply can never
        // arrive. A dead socket here means the restart began — it is not a
        // failure, and reporting one would be wrong exactly when it worked.
        res = { status: 'restarting' };
      }

      // The service is in place and this engine was never elevated: nothing
      // restarts, the readings arrive within a few seconds. Ask, never assume.
      if (res.status === 'service') {
        const access = await verifyServiceAccess();
        say('is-ok', access === 'ok'
          ? t('sensors_enable_service_done', 'Done! Fan speeds, CPU watts and CPU temperature are reading now. The FPS counter in games starts after your next sign-in.')
          : t('sensors_enable_ok', 'Done! Restart your computer and the sensors will switch on by themselves.'));
        return;
      }

      if (res.status !== 'restarting' && res.status !== 'raised') {
        const out = resultText(res);
        say(out.cls, out.text);
        btn.disabled = false;   // every other outcome is worth retrying
        return;
      }

      say('', t('sensors_enable_restarting', 'Restarting Xenon…'));
      if (res.status === 'raised') await waitForDown(8000);
      const back = await waitForServer(45000);
      if (!back) {
        say('is-warn', t('sensors_enable_slow', 'Xenon is taking a while to come back. Reload the page in a few seconds.'));
        return;
      }
      // The task now runs elevated, but that only helps a backend STARTED by it.
      // Ask the new server what it can actually read rather than assuming.
      const access = await verifyAccess();
      if (access === 'ok') say('is-ok', t('sensors_enable_done', 'Done! Fan speeds, CPU watts and CPU temperature are reading now.'));
      else if (access === 'needs_admin') say('is-warn', t('sensors_enable_still_limited', 'Permission granted! Just one step left: restart your computer and the sensors will switch on by themselves.'));
      else { say('is-ok', t('sensors_enable_ok', 'Done! Restart your computer and the sensors will switch on by themselves.')); }
    });

    wrap.append(btn, status);
    return wrap;
  }

  // Settings → Performance. The same repair, findable by a user who never added
  // the Fans/Energy widgets and only knows their CPU temperature is missing.
  // Reads /system rather than taking a param: Settings opens independently of the
  // widgets, so it must resolve sensorAccess itself.
  // Settings → Performance. This section exists ONLY when there is something to
  // repair, and it brings its own heading with it.
  //
  // It used to be a permanent panel in index.html with the heading baked in, so
  // the box was there whatever the answer was. Two bad outcomes, both reported:
  // on a machine where the sensors work it sat at the very top of the page —
  // above Performance Mode, which is what anyone opens that page for — saying
  // only "already on", which is a heading with nothing under it; and where
  // LibreHardwareMonitor does not exist at all, which is every macOS and Linux
  // install, it drew a titled panel that was completely empty. A section that
  // announces a subject and then has nothing to say about it reads as something
  // that failed to load.
  //
  // Note it cannot simply be hidden: settingsSetCategory() writes `hidden` on
  // every [data-settings-cat] element each time a category is opened, so any
  // hiding done here would be undone on the next visit. Building the section
  // instead of hiding it is what makes this stick.
  async function initSettings() {
    const host = document.getElementById('settings-sensors-hub');
    if (!host) return;
    const sys = await apiJson('/system');
    // 'ok' — nothing to fix, and the Fans and Energy widgets showing real
    // numbers is a better confirmation than a line of text here.
    // 'missing' — no LibreHardwareMonitor (5.1 installs no longer add it at
    // setup): the same prompt installs it. Only Windows reports it.
    // Unknown — nothing to offer.
    const access = sys && sys.sensorAccess;
    if (access !== 'needs_admin' && access !== 'missing') {
      const card = await outdatedServiceCard();
      if (card) host.replaceChildren(card); else host.replaceChildren();
      return;
    }
    const install = access === 'missing';

    const group = el('div', 'settings-group');
    const head = el('div', 'settings-group-head');
    head.appendChild(el('span', '', t('sensors_admin_title', 'Hardware sensors')));
    group.appendChild(head);
    const desc = install
      ? t('sensors_missing_desc', 'CPU temperature, fan speeds and watts need a small free sensor reader (LibreHardwareMonitor) and Windows’ permission to use it. One click installs both.')
      : t('sensors_admin_desc', 'CPU temperature, fan speeds and watts come from your PC’s sensors, which Windows protects: without your permission they stay empty forever. One click and one confirmation.');
    const repair = group.appendChild(hintNode(desc, 'sa-hint--settings', install));
    // Same block as the tiles, but on this page the key looks like every other key.
    repair.querySelector('.sa-btn').className = 'settings-btn primary';
    host.replaceChildren(group);
  }

  // The sensors read, but the service still runs the scripts of the version
  // before an update (they sit in Program Files, which the updater cannot
  // write): the same prompt brings it up to date. Null when nothing is to do.
  async function outdatedServiceCard() {
    const r = await apiJson('/api/sensor-service');
    if (!r || !r.service || !r.service.outdated) return null;
    const group = el('div', 'settings-group');
    const head = el('div', 'settings-group-head');
    head.appendChild(el('span', '', t('sensors_admin_title', 'Hardware sensors')));
    group.appendChild(head);
    const repair = group.appendChild(hintNode(
      t('sensors_update_desc', 'Xenon was updated, but its sensor service still runs the previous version. One confirmation brings it up to date.'),
      'sa-hint--settings', false, t('sensors_update_btn', 'Update sensors')));
    repair.querySelector('.sa-btn').className = 'settings-btn primary';
    return group;
  }

  window.SensorAccess = { hintNode, initSettings };
})();
