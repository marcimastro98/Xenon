// The local-model list: what is installed, what can be downloaded, and the selection.
'use strict';

const AI_KNOWN_MODELS = ['auto', 'qwen2.5:3b', 'qwen2.5:7b', 'llama3.1:8b', 'gemma4:12b'];
// Models actually installed in Ollama (names from /api/tags), refreshed by
// aiLocalLoadModels(). Drives the custom-field autocomplete + download state.
let _ollamaInstalledModels = [];

// Models the site's curated list offers for download — [{tag,label,sizeGB,…}].
// Kept separate from the installed list: one says what you have, the other what
// you could have. Empty until the fetch lands, and empty is a valid state (the
// four preset tiers and the custom field work exactly as before without it).
let _ollamaCatalog = [];

// Fetch the installed Ollama models and populate the autocomplete datalist.
async function aiLocalLoadModels() {
  try {
    const data = await (await fetch('/api/ai-local/models')).json();
    _ollamaInstalledModels = Array.isArray(data && data.models) ? data.models : [];
  } catch {
    _ollamaInstalledModels = [];
  }
  const list = $('ai-model-list');
  if (list) {
    list.textContent = '';
    for (const name of _ollamaInstalledModels) {
      const opt = document.createElement('option');
      opt.value = name;
      list.appendChild(opt);
    }
  }
  _populateInstalledModelOptions();
  _aiUpdateModelDownloadState();

  // The download catalog is fetched AFTER the list above is on screen, and never
  // awaited in front of it. It crosses the internet (the file lives on the site
  // so it can carry a model published after this release), and putting that in
  // front of the local list meant the models you already have appeared only once
  // a request to another machine had finished — on the first open after a
  // restart, long enough to open the dropdown and find them missing. An empty
  // catalog is a normal state, not an error: the list simply stays as it was.
  try {
    const cat = await (await fetch('/api/ai/models?provider=ollama')).json();
    _ollamaCatalog = Array.isArray(cat && cat.catalog) ? cat.catalog : [];
  } catch {
    _ollamaCatalog = [];
  }
  if (_ollamaCatalog.length) {
    _populateCatalogModelOptions();
    _reflectModelSelection();
  }
}

// Surface the actually-installed Ollama models as selectable options in the model
// dropdown (under an "Installed" group), so a user can pick a model they already
// have instead of only the preset tiers or a hand-typed custom tag. Preset tiers
// are skipped to avoid duplicates. Re-applies the stored selection afterwards, so
// it survives this async refresh landing after syncAiProviderControls().
function _populateInstalledModelOptions() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return;
  const prev = $('ai-model-installed-group');
  if (prev) prev.remove();
  const extras = _ollamaInstalledModels.filter(name => !AI_KNOWN_MODELS.includes(name));
  if (extras.length) {
    const group = document.createElement('optgroup');
    group.id = 'ai-model-installed-group';
    group.label = t('ai_model_installed_group');
    extras.forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      group.appendChild(opt);
    });
    const customOpt = modelSel.querySelector('option[value="__custom__"]');
    modelSel.insertBefore(group, customOpt);
  }
  _populateCatalogModelOptions();
  _reflectModelSelection();
}

// Models from the site's curated list that are NOT installed yet, so the
// dropdown can offer a model published after this release instead of only the
// four tiers written into the app. Selecting one leaves it un-installed; the
// Download button below the list is what fetches it, and the hardware gate on
// the server still has the last word on whether it may.
function _populateCatalogModelOptions() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return;
  const prev = $('ai-model-catalog-group');
  if (prev) prev.remove();
  const already = new Set([...AI_KNOWN_MODELS, ..._ollamaInstalledModels]);
  const extras = _ollamaCatalog.filter(m => m && m.tag && !already.has(m.tag) && !_isModelInstalled(m.tag));
  if (!extras.length) return;
  const group = document.createElement('optgroup');
  group.id = 'ai-model-catalog-group';
  group.label = t('ai_model_catalog_group');
  for (const m of extras) {
    const opt = document.createElement('option');
    opt.value = m.tag;
    // The size is the thing worth knowing before picking: these are gigabytes.
    opt.textContent = m.sizeGB ? `${m.label || m.tag} (${m.sizeGB} GB)` : (m.label || m.tag);
    group.appendChild(opt);
  }
  const customOpt = modelSel.querySelector('option[value="__custom__"]');
  modelSel.insertBefore(group, customOpt);
}

// Reflect the persisted ollamaModel into the model <select>: pick the matching
// option when one exists (a preset tier OR an installed model added above),
// otherwise fall back to the custom field.
function _reflectModelSelection() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return;
  const modelCustom = $('ai-model-custom');
  const modelWarn = $('ai-model-custom-warn');
  const model = (hubSettings && hubSettings.ollamaModel) || 'auto';
  const hasOption = model !== '__custom__'
    && Array.from(modelSel.options).some(o => o.value === model);
  if (hasOption) {
    modelSel.value = model;
    if (modelCustom) modelCustom.hidden = true;
    if (modelWarn) modelWarn.hidden = true;
  } else {
    modelSel.value = '__custom__';
    if (modelCustom) { modelCustom.hidden = false; modelCustom.value = model; }
    if (modelWarn) modelWarn.hidden = false;
  }
  // The select is a data-custom-select: assigning .value fires no event, so the
  // visible trigger would keep the previous label.
  if (typeof modelSel._csSync === 'function') modelSel._csSync();
}

// Resolve the concrete model tag for the current UI selection (not the stored
// 'auto'/'__custom__' marker). Empty string when custom is selected but blank.
function _resolveSelectedModelTag() {
  const modelSel = $('ai-model-select');
  if (!modelSel) return '';
  if (modelSel.value === '__custom__') {
    const modelCustom = $('ai-model-custom');
    return modelCustom ? modelCustom.value.trim() : '';
  }
  if (modelSel.value === 'auto') {
    const rec = hubSettings && hubSettings.hardwareScan && hubSettings.hardwareScan.recommended;
    return rec && rec !== 'auto' ? rec : 'qwen2.5:3b';
  }
  return modelSel.value;
}

// Normalized membership test against the installed-models list. Ollama reports
// tags as "name:tag" (e.g. "llama3.1:latest"), so a bare "llama3.1" matches any
// installed "llama3.1:*", and a "qwen2.5:7b" matches itself or "qwen2.5:7b:latest".
function _isModelInstalled(tag) {
  if (!tag) return false;
  if (_ollamaInstalledModels.includes(tag)) return true;
  if (_ollamaInstalledModels.includes(tag + ':latest')) return true;
  if (!tag.includes(':')) {
    return _ollamaInstalledModels.some(name => name.startsWith(tag + ':'));
  }
  return false;
}

// Reflect whether the selected model is already downloaded: set the status span
// and turn the pull button into "re-download/update" when it is (still enabled).
function _aiUpdateModelDownloadState() {
  const installedEl = $('ai-model-installed');
  const pullBtn = $('ai-pull-model');
  const tag = _resolveSelectedModelTag();
  if (!tag) {
    if (installedEl) installedEl.textContent = '';
    if (pullBtn) { pullBtn.hidden = false; pullBtn.textContent = t('ai_comp_download_model'); }
    return;
  }
  const installed = _isModelInstalled(tag);
  // Already downloaded → tell the user which model is in use and hide the
  // download button; only offer "Scarica modello" when the model is missing.
  if (installedEl) {
    installedEl.textContent = installed
      ? `${t('ai_model_in_use')} ${tag}`
      : `${tag}, ${t('ai_model_not_installed')}`;
  }
  if (pullBtn) {
    pullBtn.hidden = installed;
    pullBtn.textContent = t('ai_comp_download_model');
  }
}

// Show only the config rows that belong to the selected provider: the local
// panel for Ollama, the Gemini key row for Gemini, and the ChatGPT/Claude
// key+model panels for those. Shared by the initial sync and the radio handler.
function _reflectAiProviderRows(provider) {
  const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };
  show('ai-local-panel', provider === 'ollama');
  show('settings-localapi-panel', provider === 'localapi');
  show('settings-gemini-setup', provider === 'gemini');
  // Live voice is Gemini Live; on any other provider voice is turn-based.
  show('settings-ai-live-row', provider === 'gemini');
  show('settings-gemini-key-row', provider === 'gemini');
  show('settings-gemini-models', provider === 'gemini');
  show('settings-openai-panel', provider === 'openai');
  show('settings-anthropic-panel', provider === 'anthropic');
  show('settings-cli-panel', AI_CLI_PROVIDERS.includes(provider));
  show('settings-xenon-panel', provider === 'xenon');
}
