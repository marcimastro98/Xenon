// What Performance Mode draws outside its sheet's frame: a row of the sheet, the list of apps to
// close, the System tile's button and the notice that it finished.
'use strict';

(() => {
  const { tr, surface, _procKey, _fmtMB } = window.PerformanceSessionState;
  const { currentPerf, learnedBias } = window.PerformanceAppChoice;

  // The System tile's button is "Migliora" while nothing runs and "Ripristina"
  // while a session does. body.perf-active changes nothing you can see, so this
  // button was the only place a running session could have shown itself. The
  // i18n attributes move with the text so a language switch keeps the right label.
  function _syncSystemButtons(p) {
    const on = !!p.active;
    document.querySelectorAll('.sys-optimize-btn').forEach((btn) => {
      if (btn.classList.contains('is-active') === on && btn.dataset.perfSynced) return;
      btn.dataset.perfSynced = '1';
      btn.classList.toggle('is-active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const titleKey = on ? 'settings_perf_restore_title' : 'sys_optimize';
      btn.setAttribute('data-i18n-title', titleKey);
      btn.title = on ? tr(titleKey, 'Performance Mode is on. Tap to restore') : tr(titleKey, 'Optimize performance');
      const label = btn.querySelector('span');
      if (label) {
        const key = on ? 'settings_perf_restore' : 'sys_optimize_short';
        label.setAttribute('data-i18n', key);
        label.textContent = on ? tr(key, 'Restore') : tr(key, 'Optimize');
      }
    });
  }

  function _optRow(opt, label) {
    const row = document.createElement('label');
    row.className = 'perf-sheet-opt';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.opt = opt;
    const name = document.createElement('span');
    name.className = 'perf-sheet-opt-label';
    name.textContent = label;
    row.appendChild(cb);
    row.appendChild(name);
    return row;
  }

  // Render the closable-app checklist. Pre-checked: the AI's picks when
  // available, else the conservative deterministic preselect — in both cases
  // corrected by what this user has reliably kept/closed before. Each row shows
  // the app's measured RAM so the choice is informed.
  function renderApps(appsList, windows, preselect, stats, perf) {
    appsList.textContent = '';
    const pre = new Set((Array.isArray(preselect) ? preselect : []).map(n => String(n).toLowerCase()));
    if (!windows.length) {
      const li = document.createElement('li');
      li.className = 'perf-sheet-apps-empty';
      li.textContent = tr('perf_sheet_apps_empty', 'No background apps to close.');
      appsList.appendChild(li);
      return;
    }
    for (const w of windows) {
      const proc = _procKey(w.app);
      const li = document.createElement('li');
      const label = document.createElement('label');
      label.className = 'perf-sheet-app';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = String(w.id);
      cb.dataset.name = String(w.app || '');
      cb.checked = pre.has(String(w.app || '').toLowerCase());
      const bias = learnedBias(proc, perf || currentPerf());
      if (bias === 1) cb.checked = true;
      else if (bias === -1) cb.checked = false; // the user's own habit beats any suggestion
      const name = document.createElement('span');
      name.className = 'perf-sheet-app-name';
      name.textContent = w.app || w.title || '—';
      const ttl = document.createElement('span');
      ttl.className = 'perf-sheet-app-title';
      ttl.textContent = w.title || '';
      label.appendChild(cb);
      label.appendChild(name);
      label.appendChild(ttl);
      const s = stats && stats.byProc[proc];
      if (s && s.memMB >= 50) {
        const mem = document.createElement('span');
        mem.className = 'perf-sheet-app-mem';
        mem.textContent = _fmtMB(s.memMB);
        label.appendChild(mem);
      }
      li.appendChild(label);
      appsList.appendChild(li);
    }
  }

  // The notice that an optimize or restore finished, the same one the alerts window
  // shows. `note` is { key, activity, freed, moved }.
  function _perfNote(note, kind) {
    const s = surface();
    if (s) { s.toast(note, kind); return; }
    window.XenonToast.show(window.AlertToasts.perfNote(note, kind, { t: tr }));
  }

  window.PerformanceDrawn = { _syncSystemButtons, _optRow, renderApps, _perfNote };
})();
