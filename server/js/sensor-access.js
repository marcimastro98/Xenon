'use strict';
// Shared "sensors need administrator rights" affordance.
//
// LibreHardwareMonitor reads CPU temperature, fan RPM and CPU watts through a
// kernel driver it can only load elevated. install.ps1 registers Xenon's startup
// task with RunLevel = Highest ONLY when INSTALL.bat was itself run as admin —
// double-clicking it registers the task Limited, and nothing repairs that later
// (update-apply.ps1 never touches the task). Those users silently never get CPU
// temperature, no matter how many times they update.
//
// This is the one-tap repair: POST /system/enable-sensors raises a UAC prompt and
// sets the task to Highest, permanently. Shared by the Fans and Energy widgets and
// by Settings → Performance ("Hardware sensors", #settings-sensors-hub) so the fix
// is wherever the user notices the problem.
(function () {
  const el = makeEl;
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // Message per outcome the server reports. Anything unknown falls back to the
  // generic failure rather than claiming success.
  function resultText(res) {
    const status = res && res.status;
    if (status === 'declined') return { cls: 'is-warn', text: t('sensors_enable_declined', 'You cancelled the Windows prompt, so nothing changed. You can try again any time.') };
    if (status === 'no_task') return { cls: 'is-warn', text: t('sensors_enable_no_task', 'Part of the Xenon install is missing. Re-run INSTALL.bat with right-click → “Run as administrator”.') };
    if (status === 'raised_no_restart') return { cls: 'is-warn', text: t('sensors_enable_no_restart', 'Permission granted! Just one step left: restart your computer and the sensors will switch on by themselves.') };
    return { cls: 'is-warn', text: t('sensors_enable_failed', 'That didn’t work. Try re-running INSTALL.bat with right-click → “Run as administrator”.') };
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

  // Never claim success from a status string alone: the whole point of this
  // button is that the sensors read, so ask the new server whether they do.
  async function verifyAccess() {
    const sys = await apiJson('/system');
    return sys && sys.sensorAccess;
  }

  // A hint line plus the repair button. `text` is the caller's already-localized
  // explanation of what is missing (fans vs CPU watts read differently).
  // `cls` ADDS the caller's placement class — it never replaces `sa-hint`, which
  // carries the layout: without it the text/status blocks (max-width, so they do
  // not self-centre) pin left while the inline button centres, and the block falls
  // apart.
  function hintNode(text, cls) {
    const wrap = el('div', 'sa-hint' + (cls ? ' ' + cls : ''));
    wrap.appendChild(el('div', 'sa-hint-text', text));

    const btn = el('button', 'sa-btn');
    btn.type = 'button';
    btn.textContent = t('sensors_enable_btn', 'Enable sensors');
    const status = el('div', 'sa-status');

    const say = (cls, text) => { status.className = 'sa-status' + (cls ? ' ' + cls : ''); status.textContent = text; };

    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      say('', t('sensors_enable_busy', 'Confirm the Windows prompt…'));

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

      if (res.status !== 'restarting' && res.status !== 'raised') {
        const out = resultText(res);
        say(out.cls, out.text);
        btn.disabled = false;   // every other outcome is worth retrying
        return;
      }

      say('', t('sensors_enable_restarting', 'Restarting Xenon…'));
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
    // 'missing' or unknown — no LibreHardwareMonitor, so this repair cannot help
    // whatever is wrong; offering it would be a button that always fails.
    if ((sys && sys.sensorAccess) !== 'needs_admin') { host.replaceChildren(); return; }

    const group = el('div', 'settings-group');
    const head = el('div', 'settings-group-head');
    head.appendChild(el('span', '', t('sensors_admin_title', 'Hardware sensors')));
    group.appendChild(head);
    group.appendChild(hintNode(t('sensors_admin_desc', 'CPU temperature, fan speeds and watts come from your PC’s sensors, which Windows protects: without your permission they stay empty forever. One click and one confirmation.'), 'sa-hint--settings'));
    host.replaceChildren(group);
  }

  window.SensorAccess = { hintNode, initSettings };
})();
