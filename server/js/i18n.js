'use strict';

// The app's words on a page: t() and the functions that put them on screen.
// The words themselves are one file per language, js/i18n/<code>.js. The server
// hands a page the languages it needs in front of the functions below
// (/layer-i18n.js, server/layer-strings.js: the saved language, the browser's and
// English), and js/i18n-load.js fetches the others when they are asked for.
// Loaded on its own this file has no words and t() answers with the key.
const i18n = {};

function t(key) {
  // Fallback: selected language → English → key name (never silently shows Italian to non-Italian users)
  return (i18n[lang] && i18n[lang][key]) ?? (i18n.en && i18n.en[key]) ?? key;
}

function localizeAppName(name) {
  if (!name) return '';
  if (/lettore\s+multimediale|^media\s+player$/i.test(name)) return t('media_player_dynamic');
  return name;
}

// "c=90,g=88" → { c: 90, g: 88 }. Anything unparseable is dropped rather than
// printed, so a typo leaves the placeholder visible instead of "NaN°C".
function parseTempTokens(spec) {
  const out = {};
  for (const pair of String(spec || '').split(',')) {
    const [name, value] = pair.split('=');
    const n = Number(value);
    if (name && name.trim() && Number.isFinite(n)) out[name.trim()] = n;
  }
  return out;
}

// The fixed text in the markup under `root`, in the current language. The light
// layer page (js/layer-lite.js) runs this on the tiles it carries; the rest of
// applyTranslations() redraws dashboard parts it does not have.
function translateStatic(root) {
  root.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    // data-i18n-temps="c=90,g=88" names the Celsius constants a static string
    // quotes, so a hint describing a threshold prints it in the unit the user
    // picked instead of a hard "°C" beside readings that say °F. The numbers
    // live in the markup next to the rule they describe; a test pins them to
    // the thresholds briefing.js actually enforces.
    const temps = el.getAttribute('data-i18n-temps');
    el.textContent = temps ? fillTemps(t(key), parseTempTokens(temps)) : t(key);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  root.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
  root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label')));
  });
}

function applyTranslations() {
  document.documentElement.lang = lang;
  translateStatic(document);
  document.querySelectorAll('.lang-seg').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  if (statusDot) statusDot.title = statusDot.classList.contains('offline') ? t('offline') : t('online');
  if (typeof muted === 'boolean') applyUI(muted);
  if (mediaData) applyMedia(mediaData); else refreshMediaEmpty();
  if (weatherData) applyWeather(weatherData);
  if ($('weather-overlay') && !$('weather-overlay').hidden) renderWeatherDetails();
  if (audioData) applyAudio(audioData);
  if (calendarMode) renderCalendar();
  renderUpcoming();
  if ($('day-modal').classList.contains('open') && modalDateValue) {
    updateDayModalTitle();
    renderDayModalEvents();
  }
  tickClock();
  renderAppFavorites();
  // Page names resolved from a seed key were captured by the pager when the
  // page was registered; with labelled dots that stale string is on screen.
  if (window.DashboardPages && typeof window.DashboardPages.relabel === 'function') window.DashboardPages.relabel();
  if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
  if ($('app-switcher') && !$('app-switcher').hidden) renderAppWindows();
  if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
  if (typeof renderDynamicIslandSources === 'function' && typeof _settingsCat !== 'undefined' && _settingsCat === 'island') renderDynamicIslandSources();
  if ($('lockscreen-overlay') && !$('lockscreen-overlay').hidden && typeof renderLockScreen === 'function') renderLockScreen();
  if (typeof renderTasks === 'function') renderTasks();
  if (typeof renderNotes === 'function') renderNotes();
  if (typeof _aiRefreshWakeStatus === 'function') _aiRefreshWakeStatus();
  if (window.DiscordWidget && typeof window.DiscordWidget.renderWidgets === 'function') window.DiscordWidget.renderWidgets();
  if (window.StreamerbotWidget && typeof window.StreamerbotWidget.renderWidgets === 'function') window.StreamerbotWidget.renderWidgets();
  if (window.NotificationsWidget && typeof window.NotificationsWidget.renderWidgets === 'function') window.NotificationsWidget.renderWidgets();
  if (window.TransferWidget && typeof window.TransferWidget.renderWidgets === 'function') window.TransferWidget.renderWidgets();
  if (window.CustomWidget && typeof window.CustomWidget.renderWidgets === 'function') window.CustomWidget.renderWidgets();
  if (window.SmartHome && typeof window.SmartHome.renderWidgets === 'function') window.SmartHome.renderWidgets();
  if (window.VitalsWidget && typeof window.VitalsWidget.renderWidgets === 'function') window.VitalsWidget.renderWidgets();
  if (window.LyricsWidget && typeof window.LyricsWidget.renderWidgets === 'function') window.LyricsWidget.renderWidgets();
  // The YouTube widget re-labels in place rather than rebuilding: a language
  // change must not tear down a video the user is watching.
  if (window.YouTubeWidget && typeof window.YouTubeWidget.renderWidgets === 'function') window.YouTubeWidget.renderWidgets();
  if (window.YouTubeLiveWidget && typeof window.YouTubeLiveWidget.renderWidgets === 'function') window.YouTubeLiveWidget.renderWidgets();
  if (window.TwitchWatchWidget && typeof window.TwitchWatchWidget.renderWidgets === 'function') window.TwitchWatchWidget.renderWidgets();
  if (window.PerfWidget) window.PerfWidget.renderWidgets();
  if (window.ScreenTile) window.ScreenTile.renderWidgets();
  // The Scintille chips and Bit's model button build their words in script.
  if (window.XenonCredits) window.XenonCredits.renderChips();
  if (window.BitWelcome) window.BitWelcome.refresh();
}

function setLang(l) {
  const nextLang = normalizeLangCode(l);
  if (!nextLang) return;
  // A page holds only some languages (/layer-i18n.js): fetch this one first.
  if (!i18n[nextLang]) { if (window.I18nLoad) window.I18nLoad.ensure([nextLang]).then((ok) => { if (ok) setLang(nextLang); }); return; }
  if (!window._langSelectSyncing && window.XenonNative) window.XenonNative.tellSplashLanguage(nextLang);
  // Persist to hubSettings so the language survives browser-storage resets and
  // reaches every other surface. This must run even when nextLang === lang: a
  // browser locale that already matched the pick used to return early below,
  // hubSettings.language stayed '' and every surface chose its own (#72).
  // Skipped during syncLangButtons' synthetic label-sync dispatch: that isn't a
  // user pick, and persisting there would pin this surface's browser locale.
  if (!window._langSelectSyncing
      && typeof hubSettings !== 'undefined' && hubSettings.language !== nextLang
      && typeof saveHubSettings === 'function') {
    hubSettings = normalizeSettings({ ...hubSettings, language: nextLang });
    saveHubSettings({ server: true });
  }
  localStorage.setItem('uiLang', nextLang);
  if (nextLang === lang) return; // already active — persisted above, nothing to re-render
  lang = nextLang;
  applyTranslations();
  // Installed widgets render their own text and were handed the language code
  // at mount. Without this they keep it until something reloads them, so a
  // dashboard switched to another language would sit next to a widget still in
  // the old one.
  try {
    if (window.CustomWidget && typeof window.CustomWidget.refreshLang === 'function') {
      window.CustomWidget.refreshLang();
    }
  } catch (e) { /* a widget bridge that is not up yet is not an error */ }
  if (typeof syncLangButtons === 'function') syncLangButtons();
  // The AI key fields set their own placeholder ("•••••••• saved" vs the format
  // hint) because applyTranslations can only restore one of the two — without
  // this, switching language with a key saved made the field read "AIza…" again,
  // which looks exactly like the key was lost.
  if (typeof syncAiSettingsControls === 'function') syncAiSettingsControls();
  // Weather text is served in the UI language → refetch. Through the shared
  // debounce timer, so a remote hydrate that changes language AND city fetches
  // once, not twice (settings.js queues the city change on the same timer).
  if (typeof queueWeatherSettingsRefresh === 'function') queueWeatherSettingsRefresh();
  else if (typeof fetchWeather === 'function') fetchWeather();
}
