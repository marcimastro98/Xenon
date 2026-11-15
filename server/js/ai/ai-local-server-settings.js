// Settings → Bit → Local server (server/ai-local-server.js): where the server is,
// whether it answers, and the optional key. The model list itself is the shared
// picker in settings.js; this file paints what that list's answer says.
(function () {
  const STATE_KEYS = {
    checking: 'settings_localapi_state_checking',
    ok: 'settings_localapi_state_ok',
    no_models: 'settings_localapi_state_no_models',
    no_list: 'settings_localapi_state_no_list',
    offline: 'settings_localapi_state_offline',
    bad_key: 'settings_localapi_state_bad_key',
    not_compatible: 'settings_localapi_state_not_compatible',
  };
  const field = (id) => document.getElementById(id);
  let shown = { state: '', count: 0 };

  function paint() {
    const line = field('settings-localapi-state');
    if (!line) return;
    const key = STATE_KEYS[shown.state];
    line.textContent = key ? t(key).replace('{n}', String(shown.count)) : '';
  }

  // Still on the default address and another usual one answers: nothing for the
  // user to do but pick this provider. An address they typed is theirs to change.
  function showState(state, count, found) {
    if (state === 'offline' && found && hubSettings.localApiUrl === LocalServerFields.DEFAULT_URL) {
      setUrl(found);
      return;
    }
    shown = { state, count: count || 0 };
    paint();
  }

  function save(changes) {
    hubSettings = normalizeSettings({ ...hubSettings, ...changes });
    saveHubSettings();
  }

  function syncKey() {
    const key = field('settings-localapi-key');
    if (key) { key.value = ''; key.placeholder = hubSettings.localApiKeySet ? t('settings_key_saved') : ''; }
    const reset = field('settings-localapi-reset');
    if (reset) reset.hidden = !hubSettings.localApiKeySet;
  }

  // Reflect the saved settings. The status line keeps its last answer, so a
  // language change repaints it without asking the server again.
  function sync() {
    const url = field('settings-localapi-url');
    if (url) url.value = hubSettings.localApiUrl;
    const vision = field('settings-localapi-vision');
    if (vision) vision.checked = hubSettings.localApiVision === true;
    syncKey();
    paint();
  }

  function check() {
    showState('checking');
    _aiLoadProviderModels('localapi', { force: true });
  }

  // The list is read from the server's settings, so it waits for the save.
  function checkAfterSave() {
    showState('checking');
    _aiScheduleModelRefresh('localapi');
  }

  function setUrl(value) {
    save({ localApiUrl: value });
    sync();
    checkAfterSave();
  }

  function setKey(value) {
    const v = String(value || '').trim().slice(0, 200);
    if (!v) return;
    save({ localApiKey: v, localApiKeySet: true });
    syncKey();
    checkAfterSave();
  }

  // key='' with *Set=false is what the server honours as a real removal.
  function resetKey() {
    save({ localApiKey: '', localApiKeySet: false });
    syncKey();
    checkAfterSave();
  }

  function setVision(on) {
    save({ localApiVision: on === true });
  }

  window.LocalServerSettings = { sync, check, showState, setUrl, setKey, resetKey, setVision };
})();
