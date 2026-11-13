// The model pickers for cloud and command-line AI providers.
'use strict';

function _aiControlsFor(provider) { return AI_MODEL_CONTROLS.filter(c => c.provider === provider); }

// NOTE the key: `ai_model_auto` is already taken by the Ollama tier dropdown
// ("Auto (consigliato)"), and a duplicate key in the same dictionary silently
// wins over the first — which would have retitled that control too.
function _aiAutoLabel(family) {
  if (!family) return t('ai_model_auto_latest');
  // "Auto — Flash Lite": the family name is the provider's own word for the tier
  // and is not translated; only the "Auto" part is.
  const pretty = family.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  return t('ai_model_auto_latest') + ' — ' + pretty;
}

function _aiPopulateModelSelect(ctl, data) {
  const sel = $(ctl.sel);
  if (!sel) return;
  const cust = $(ctl.sel + '-custom');
  const used = $(ctl.sel + '-used');
  const saved = (ctl.normalize || normalizeModelChoice)(hubSettings[ctl.key]);
  const spec = (data && data.roles && data.roles[ctl.role]) || { kind: 'chat', family: '' };
  const all = (data && Array.isArray(data.models)) ? data.models : [];
  const list = all.filter(m => m && m.kind === spec.kind);

  sel.innerHTML = '';
  const autoGroup = document.createElement('optgroup');
  autoGroup.label = t('ai_model_auto_group');
  const addOpt = (parent, value, label) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    parent.appendChild(o);
  };
  addOpt(autoGroup, 'auto', _aiAutoLabel(''));
  const families = [];
  for (const m of list) if (m.family && !families.includes(m.family)) families.push(m.family);
  for (const f of families) addOpt(autoGroup, 'auto:' + f, _aiAutoLabel(f));
  sel.appendChild(autoGroup);

  if (list.length) {
    const pinGroup = document.createElement('optgroup');
    pinGroup.label = t('ai_model_pin_group');
    // A pinned id the API no longer returns must stay selectable, or opening
    // Settings would silently re-point the user's choice at something else.
    if (saved && !saved.startsWith('auto') && !list.some(m => m.id === saved)) addOpt(pinGroup, saved, saved);
    for (const m of list) addOpt(pinGroup, m.id, m.label || m.id);
    sel.appendChild(pinGroup);
  } else if (saved && !saved.startsWith('auto')) {
    addOpt(sel, saved, saved);
  }
  addOpt(sel, '__custom__', t('ai_model_custom'));

  const known = Array.from(sel.options).some(o => o.value === saved);
  sel.value = known ? saved : '__custom__';
  if (cust) {
    cust.hidden = known;
    if (!known) cust.value = saved;
  }
  if (typeof sel._csSync === 'function') sel._csSync(); // .value assignment fires no event

  // The resolved id, shown only when it differs from what the dropdown says.
  if (used) {
    const resolved = (data && data.resolved && data.resolved[ctl.role]) || '';
    const show = resolved && saved.startsWith('auto');
    used.hidden = !show;
    used.textContent = show ? t('ai_model_resolved').replace('{model}', resolved) : '';
  }
}

function _aiRenderProviderControls(provider) {
  const data = _aiModelCatalog[provider] || null;
  for (const ctl of _aiControlsFor(provider)) _aiPopulateModelSelect(ctl, data);
}

async function _aiLoadProviderModels(provider, opts) {
  if (!_aiControlsFor(provider).some(c => $(c.sel))) return;
  // Render from what we already have (or from nothing) first, so the panel is
  // never empty while the request is in flight.
  _aiRenderProviderControls(provider);
  const keySet = provider === 'localapi' ? true // its key is optional
    : provider === 'openai' ? hubSettings.openaiApiKeySet
      : provider === 'anthropic' ? hubSettings.anthropicApiKeySet
        : hubSettings.geminiApiKeySet;
  if (!keySet) return; // no key yet → nothing to fetch
  try {
    const r = await fetch('/api/ai/models?provider=' + provider + ((opts && opts.force) ? '&refresh=1' : ''));
    const d = await r.json();
    if (d && Array.isArray(d.models)) {
      _aiModelCatalog[provider] = d;
      _aiRenderProviderControls(provider);
      if (provider === 'localapi' && window.LocalServerSettings) window.LocalServerSettings.showState(d.state || 'offline', d.models.length, d.found);
    }
  } catch {
    // offline — keep whatever the last render showed
    if (provider === 'localapi' && window.LocalServerSettings) window.LocalServerSettings.showState('offline');
  }
}

// After a key is entered, the /api/ai/models endpoint reads it from the SERVER
// settings, which the 250ms-debounced save hasn't flushed yet — and typing fires
// per keystroke. Debounce past the save window so the list enriches once, with
// the key actually persisted.
let _aiModelRefreshTimer = null;
function _aiScheduleModelRefresh(provider) {
  if (_aiModelRefreshTimer) clearTimeout(_aiModelRefreshTimer);
  _aiModelRefreshTimer = setTimeout(() => { _aiModelRefreshTimer = null; _aiLoadProviderModels(provider); }, 700);
}

// One handler for every dropdown: persist the choice, then re-render so the
// "in use" line follows immediately instead of waiting for the next hydrate.
function updateAiModelChoice(key, value) {
  const ctl = AI_MODEL_CONTROLS.find(c => c.key === key);
  const next = ((ctl && ctl.normalize) || normalizeModelChoice)(value);
  hubSettings = normalizeSettings({ ...hubSettings, [key]: next });
  saveHubSettings();
  if (ctl) _aiRenderProviderControls(ctl.provider);
}

function onAiModelSelect(key, value) {
  const ctl = AI_MODEL_CONTROLS.find(c => c.key === key);
  const cust = ctl ? $(ctl.sel + '-custom') : null;
  if (value === '__custom__') { if (cust) { cust.hidden = false; cust.value = ''; cust.focus(); } return; }
  if (cust) cust.hidden = true;
  updateAiModelChoice(key, value);
}

function onOpenaiModelSelect(v) { onAiModelSelect('openaiModel', v); }

// ── Claude Code / Codex (the user's own subscription) ───────────────────────
// One panel for both. It says whether the program is installed and signed in,
// with what to run when it is not, and offers the models the program itself
// lists. Nothing here handles a credential: sign-in happens in the program.
const AI_CLI_INFO = {
  claudecode: { app: 'Claude Code', login: 'claude auth login', guide: 'https://code.claude.com/docs/en/setup', key: 'claudeCodeModel' },
  codex: { app: 'Codex', login: 'codex login', guide: 'https://developers.openai.com/codex/cli', key: 'codexModel' },
};
let _aiCliSeq = 0;
function _aiCliText(k, info, extra) {
  let s = t(k).replace(/\{app\}/g, info.app).replace(/\{cmd\}/g, info.login);
  if (extra && extra.version != null) s = s.replace(/\{ver\}/g, extra.version ? ' ' + extra.version : '');
  return s;
}
async function aiCliRefresh(provider, fresh) {
  const info = AI_CLI_INFO[provider];
  if (!info) return;
  const seq = ++_aiCliSeq;
  const intro = $('settings-cli-intro');
  if (intro) intro.textContent = _aiCliText('settings_cli_intro', info);
  const guide = $('settings-cli-guide');
  if (guide) { guide.href = info.guide; guide.textContent = _aiCliText('settings_cli_guide', info); }
  const statusEl = $('settings-cli-status');
  const detailEl = $('settings-cli-detail');
  if (statusEl) { statusEl.textContent = t('settings_cli_checking'); statusEl.dataset.state = 'checking'; }
  if (detailEl) { detailEl.textContent = ''; detailEl.hidden = true; }
  _aiCliRenderModels(provider, null);   // "loading" until the program answers
  const q = (fresh ? '&fresh=1' : '');
  // Independent: the list shows as soon as it arrives, whatever the status does.
  const getJson = (url) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
  getJson('/api/ai/cli/models?provider=' + provider + q).then((list) => {
    if (seq !== _aiCliSeq) return;
    _aiCliRenderModels(provider, (list && Array.isArray(list.models)) ? list.models : []);
  });
  const st = await getJson('/api/ai/cli/status?provider=' + provider + q);
  if (seq !== _aiCliSeq) return;   // the user switched provider meanwhile
  if (!statusEl) return;
  let k = 'settings_cli_unknown', state = 'warn', detail = '';
  if (!st || st.ok === false) {
    // No answer at all: most often a dashboard newer than the Xenon running it.
    k = 'settings_cli_no_server';
  } else if (!st.installed) { k = 'settings_cli_not_installed'; state = 'bad'; }
  else if (st.loggedIn === false) { k = 'settings_cli_not_logged_in'; state = 'bad'; }
  else if (st.loggedIn === true && /api.?key/i.test(String(st.method || ''))) { k = 'settings_cli_api_key'; state = 'warn'; }
  else if (st.loggedIn === true) { k = 'settings_cli_ready'; state = 'ok'; }
  else if (st.detail) detail = t('settings_cli_detail').replace('{detail}', String(st.detail));
  if (st && st.loggedIn === true && st.plan) detail = t('settings_cli_plan').replace('{plan}', String(st.plan));
  statusEl.textContent = _aiCliText(k, info, { version: (st && st.version) || '' });
  statusEl.dataset.state = state;
  if (guide) guide.hidden = state === 'ok';
  if (detailEl) { detailEl.textContent = detail; detailEl.hidden = !detail; }
}
// `models` null = still loading. Each entry is { id, label, version?, resolved? }
// exactly as the program described it; nothing here invents a model.
let _aiCliModels = [];
function _aiCliRenderModels(provider, models) {
  const info = AI_CLI_INFO[provider];
  const sel = $('settings-cli-model');
  if (!sel || !info) return;
  const cur = normalizeCliModel(hubSettings && hubSettings[info.key]);
  sel.replaceChildren();
  const add = (value, label) => { const o = document.createElement('option'); o.value = value; o.textContent = label; sel.appendChild(o); return o; };
  if (models === null) {
    add(cur, t('settings_cli_models_loading')).disabled = true;
    sel.value = cur;
    _aiCliShowUsed(null);
    return;
  }
  _aiCliModels = models.filter(m => m && typeof m.id === 'string');
  const ids = new Set();
  // "Opus" + "Opus 5.5" reads as "Opus 5.5"; the default keeps its own name.
  const withVersion = (label, version) => {
    const l = String(label), v = String(version || '');
    if (!v || v.toLowerCase() === l.toLowerCase()) return l;
    return v.toLowerCase().startsWith(l.toLowerCase()) ? v : l + ' · ' + v;
  };
  // The program's own "default" (Claude Code lists it) reads as ours, localized.
  const def = _aiCliModels.find(m => m.id === 'default');
  add('default', withVersion(t('settings_cli_model_default'), def && def.version));
  ids.add('default');
  for (const m of _aiCliModels) {
    if (ids.has(m.id)) continue;
    ids.add(m.id);
    add(m.id, withVersion(m.label || m.id, m.version));
  }
  // A saved model the program no longer lists stays selectable, marked as such.
  if (!ids.has(cur)) add(cur, t('settings_cli_model_saved').replace('{model}', cur));
  sel.value = cur;
  _aiCliShowUsed(cur);
}
// "In use: claude-opus-5-5": the exact model the chosen entry resolves to today.
function _aiCliShowUsed(id) {
  const el = $('settings-cli-model-used');
  if (!el) return;
  const m = id ? _aiCliModels.find(x => x.id === id) : null;
  const resolved = m && m.resolved && m.resolved !== m.id ? m.resolved : '';
  el.textContent = resolved ? t('ai_model_resolved').replace('{model}', resolved) : '';
  el.hidden = !resolved;
}
function onAiCliModelSelect(value) {
  const provider = hubSettings && hubSettings.aiProvider;
  const info = AI_CLI_INFO[provider];
  if (!info) return;
  hubSettings = normalizeSettings({ ...hubSettings, [info.key]: normalizeCliModel(value) });
  saveHubSettings();
  _aiCliShowUsed(normalizeCliModel(value));
}
function aiCliRecheck() {
  const provider = hubSettings && hubSettings.aiProvider;
  if (AI_CLI_PROVIDERS.includes(provider)) aiCliRefresh(provider, true);
}
function onAnthropicModelSelect(v) { onAiModelSelect('anthropicModel', v); }
