// The list of apps that turn Performance Mode on.
'use strict';

// ── Per-activity trigger apps (add/remove vs the built-in defaults) ──
function _perfIsDefaultApp(activity, name) {
  const defs = (window.PerfMode && window.PerfMode.defaultApps) ? window.PerfMode.defaultApps(activity) : [];
  return defs.includes(name);
}

function _savePerformanceActivityApps(activity, lists) {
  const cur = normalizePerformance(hubSettings.performance).activityApps;
  _savePerformance({ activityApps: { ...cur, [activity]: lists } });
  renderPerformanceTriggerApps();
}

function addPerformanceTriggerApp(activity, inputEl) {
  if (!inputEl) return;
  const name = String(inputEl.value || '').toLowerCase().trim().replace(/\.exe$/, '');
  inputEl.value = '';
  if (!PERF_ACTIVITIES.includes(activity) || !/^[a-z0-9._+\-]{1,40}$/.test(name)) return;
  const cur = normalizePerformance(hubSettings.performance).activityApps[activity];
  const add = cur.add.slice();
  let remove = cur.remove.slice();
  if (_perfIsDefaultApp(activity, name)) {
    remove = remove.filter(n => n !== name); // re-enable a previously removed default
  } else if (!add.includes(name)) {
    add.push(name);
  }
  _savePerformanceActivityApps(activity, { add, remove });
}

function removePerformanceTriggerApp(activity, name) {
  if (!PERF_ACTIVITIES.includes(activity)) return;
  const cur = normalizePerformance(hubSettings.performance).activityApps[activity];
  let add = cur.add.slice();
  const remove = cur.remove.slice();
  if (_perfIsDefaultApp(activity, name)) {
    if (!remove.includes(name)) remove.push(name); // drop a default
  } else {
    add = add.filter(n => n !== name);
  }
  _savePerformanceActivityApps(activity, { add, remove });
}

// Build the chip editors (one per activity) into #settings-perf-app-editor.
function renderPerformanceTriggerApps() {
  const host = $('settings-perf-app-editor');
  if (!host) return;
  host.textContent = '';
  const activities = [
    ['gaming', 'settings_perf_act_gaming'],
    ['coding', 'settings_perf_act_coding'],
    ['writing', 'settings_perf_act_writing'],
    ['streaming', 'settings_perf_act_streaming'],
    ['creating', 'settings_perf_act_creating'],
    ['meeting', 'settings_perf_act_meeting'],
  ];
  for (const [activity, labelKey] of activities) {
    const block = document.createElement('div');
    block.className = 'perf-app-block';
    const head = document.createElement('div');
    head.className = 'perf-app-block-title';
    head.textContent = t(labelKey);
    block.appendChild(head);

    const chips = document.createElement('div');
    chips.className = 'perf-app-chips';
    const eff = (window.PerfMode && window.PerfMode.effectiveApps) ? window.PerfMode.effectiveApps(activity) : [];
    if (!eff.length) {
      const empty = document.createElement('span');
      empty.className = 'perf-app-empty settings-note';
      empty.textContent = t('settings_perf_apps_none') || '—';
      chips.appendChild(empty);
    }
    for (const name of eff) {
      const chip = document.createElement('span');
      chip.className = 'perf-app-chip';
      const label = document.createElement('span');
      label.textContent = name;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'perf-app-chip-x';
      x.textContent = '×';
      x.setAttribute('aria-label', 'remove');
      x.addEventListener('click', () => removePerformanceTriggerApp(activity, name));
      chip.appendChild(label);
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    block.appendChild(chips);

    const addRow = document.createElement('div');
    addRow.className = 'perf-app-add';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'settings-text-input perf-app-input';
    input.placeholder = t('settings_perf_app_add') || 'app.exe';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPerformanceTriggerApp(activity, input); } });
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'settings-btn';
    btn.textContent = t('add');
    btn.addEventListener('click', () => addPerformanceTriggerApp(activity, input));
    addRow.appendChild(input);
    addRow.appendChild(btn);
    block.appendChild(addRow);

    host.appendChild(block);
  }
}
