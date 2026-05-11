'use strict';

const i18n = {
  it: {
    locale: 'it-IT',
    weekdays: ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'],
    online: 'Online', offline: 'Offline',
    open_calendar: 'Calendario',
    media_empty_title: 'Niente in riproduzione',
    media_empty_sub: 'Spotify, YouTube e altri player compariranno qui',
    media_unknown_title: 'Titolo non disponibile',
    tip_prev: 'Precedente', tip_play: 'Play/Pausa', tip_next: 'Successivo',
    agenda: 'Agenda personale', calendar: 'Calendario', media: 'Musica',
    today: 'Oggi', prev_month: 'Mese precedente', next_month: 'Mese successivo',
    add: 'Aggiungi', close: 'Chiudi', delete_event: 'Elimina',
    ph_title: 'Titolo evento', ph_notes: 'Nota breve',
    no_events: 'Nessun evento per questo giorno',
    upcoming: 'Prossimi eventi', no_upcoming: 'Nessun evento in programma',
    reminder: 'Promemoria', desktop_title: 'Promemoria Xenon Edge',
    now_playing: 'Musica in riproduzione', active_player: 'Player attivo',
    reminder_at: "All'orario", reminder_5: '5 min prima', reminder_15: '15 min prima',
    reminder_30: '30 min prima', reminder_60: '1 ora prima', reminder_1440: '1 giorno prima',
    reminder_none: 'Nessuna notifica',
    mic_active: 'Microfono attivo', mic_muted: 'Microfono mutato',
    mic_input_live: 'Ingresso live', mic_sensitivity: 'Sensibilità ingresso',
    mic_mute_tip: 'Microfono mute',
    notes_title: 'Appunti',
    notes_placeholder: 'Scrivi qui i tuoi appunti — vengono salvati automaticamente…',
    section_system: 'Sistema', uptime_prefix: 'Acceso da',
    sys_tab_main: 'Sistema', sys_tab_net: 'Rete & Gaming',
    weather_title: 'Meteo', weather_loading: 'Meteo in caricamento', weather_local: 'Locale',
    weather_unavailable: 'Meteo non disponibile', weather_feels: 'Percepita', weather_open: 'Apri dettagli meteo',
    weather_details_title: 'Condizioni live', weather_refresh: 'Aggiorna meteo', weather_updated: 'Aggiornato alle',
    weather_hourly: 'Prossime ore', weather_forecast: 'Prossimi giorni', weather_no_data: 'Nessun dato disponibile',
    weather_status: 'Stato', weather_retry_hint: 'Riprova tra poco', weather_rain_short: 'Pioggia', weather_sun: 'Sole',
    weather_metric_feels: 'Percepita', weather_metric_humidity: 'Umidità', weather_metric_humidity_sub: 'aria relativa',
    weather_metric_wind: 'Vento', weather_metric_rain: 'Precipitazioni', weather_metric_now: 'adesso',
    weather_metric_pressure: 'Pressione', weather_metric_pressure_sub: 'livello mare',
    weather_metric_visibility: 'Visibilità', weather_metric_visibility_sub: 'orizzonte',
    weather_metric_uv: 'Indice UV', weather_metric_uv_sub: 'radiazione',
    weather_metric_clouds: 'Nuvole', weather_metric_clouds_sub: 'copertura',
    net_ping: 'PING', net_ping_sub: 'Risposta server DNS',
    net_fps: 'FPS', net_fps_sub: 'Richiede PresentMon / FrameView',
    net_latency: 'LATENZA', net_latency_sub: 'Variazione del ping',
    net_bandwidth: 'RETE', net_bandwidth_sub: 'Throughput istantaneo',
    metric_na: 'N/D',
    gpu_loading: 'GPU in rilevamento',
    disk_cycle_tip: 'Disco successivo', disk_label: 'DISCO',
    disk_detail_unavailable: 'Dettaglio non disponibile',
    ram_detail_unavailable: 'Dettaglio RAM non disponibile',
    gb_free: 'liberi',
    vol_title: 'Volume', vol_mute_tip: 'Muta altoparlante',
    device_speaker: 'Altoparlante', device_mic: 'Microfono',
    picker_speaker: 'Seleziona altoparlante', picker_mic: 'Seleziona microfono',
    media_player_dynamic: 'Lettore Multimediale',
    tip_lock: 'Blocca schermo', tip_tabs: 'Apri tab', tip_focus_lock: 'Apri lock screen widget', tip_apps: 'Applicazioni aperte', tip_settings: 'Impostazioni aspetto',
    lock_exit: 'Chiudi lock screen',
    lock_widget_clock: 'Orologio', lock_widget_weather: 'Meteo', lock_widget_media: 'Musica', lock_widget_calendar: 'Eventi',
    lock_up_next: 'Prossimi eventi', lock_empty_events: 'Nessun evento in programma',
    apps_title: 'Applicazioni aperte', apps_loading: 'Caricamento applicazioni…',
    apps_empty: 'Nessuna finestra aperta trovata', apps_refresh: 'Aggiorna',
    apps_active: 'Attiva', apps_open: 'Apri applicazione', apps_minimized: 'Minimizzata',
    apps_favorite: 'Aggiungi ai preferiti', apps_unfavorite: 'Rimuovi dai preferiti', apps_favorite_open: 'Apri preferito',
    tabs_title: 'Tab widget', tab_current: 'Attivo',
    tab_full: 'Dashboard', tab_full_sub: 'Vista completa',
    tab_media: 'Media', tab_media_sub: 'Musica e calendario',
    tab_mic: 'Microfono', tab_mic_sub: 'Mute e sensibilità',
    tab_notes: 'Appunti', tab_notes_sub: 'Note rapide',
    tab_system: 'Sistema', tab_system_sub: 'CPU, GPU, RAM',
    tab_audio: 'Audio', tab_audio_sub: 'Volume e dispositivi',
    settings_title: 'Aspetto dashboard', settings_subtitle: 'Colori, trasparenze e sfondo personale',
    settings_preview_kicker: 'Anteprima live', settings_presets: 'Preset rapidi', settings_language: 'Lingua',
    settings_lockscreen: 'Lock screen', settings_lockscreen_hint: 'Widget rapidi',
    settings_preset_xenon: 'Xenon', settings_preset_ocean: 'Ocean', settings_preset_ember: 'Ember',
    settings_preset_violet: 'Violet', settings_preset_mono: 'Mono',
    settings_colors: 'Colori', settings_accent: 'Accento', settings_accent_hint: 'azioni e stati',
    settings_background: 'Sfondo base', settings_background_hint: 'dietro i pannelli',
    settings_text: 'Testo', settings_text_hint: 'contrasto principale',
    settings_surface: 'Superficie', settings_panel_opacity: 'Opacità pannelli',
    settings_bg_dim: 'Oscuramento sfondo', settings_bg_blur: 'Sfocatura sfondo',
    settings_bg_blur_note_empty: "Visibile dopo aver caricato un'immagine, GIF o video.",
    settings_bg_blur_note_active: 'Sfoca solo il media di sfondo caricato.',
    settings_background_media: 'Sfondo multimediale', settings_bg_upload: 'Carica immagine, GIF o video',
    settings_bg_upload_hint: 'PNG, JPG, WEBP, GIF, MP4 o WEBM fino a 32 MB',
    settings_bg_image_loaded: 'Immagine/GIF attiva', settings_bg_video_loaded: 'Video attivo',
    settings_bg_clear: 'Rimuovi', settings_bg_uploading: 'Caricamento sfondo…',
    settings_bg_uploaded: 'Sfondo aggiornato', settings_bg_upload_failed: 'Impossibile caricare lo sfondo',
    settings_bg_too_large: 'File troppo grande: massimo 32 MB', settings_bg_removed: 'Sfondo rimosso',
    settings_saved: 'Preferenze salvate', settings_persist_note: 'Le preferenze restano salvate su questo PC.',
    settings_reset: 'Ripristina default', settings_reset_done: 'Aspetto ripristinato'
  },
  en: {
    locale: 'en-US',
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    online: 'Online', offline: 'Offline',
    open_calendar: 'Calendar',
    media_empty_title: 'Nothing playing',
    media_empty_sub: 'Spotify, YouTube and other players will appear here',
    media_unknown_title: 'Title unavailable',
    tip_prev: 'Previous', tip_play: 'Play/Pause', tip_next: 'Next',
    agenda: 'Personal agenda', calendar: 'Calendar', media: 'Music',
    today: 'Today', prev_month: 'Previous month', next_month: 'Next month',
    add: 'Add', close: 'Close', delete_event: 'Delete',
    ph_title: 'Event title', ph_notes: 'Short note',
    no_events: 'No events for this day',
    upcoming: 'Upcoming events', no_upcoming: 'No upcoming events',
    reminder: 'Reminder', desktop_title: 'Xenon Edge Reminder',
    now_playing: 'Music playing', active_player: 'Active player',
    reminder_at: 'At time', reminder_5: '5 min before', reminder_15: '15 min before',
    reminder_30: '30 min before', reminder_60: '1 hour before', reminder_1440: '1 day before',
    reminder_none: 'No notification',
    mic_active: 'Microphone active', mic_muted: 'Microphone muted',
    mic_input_live: 'Live input', mic_sensitivity: 'Input sensitivity',
    mic_mute_tip: 'Mute microphone',
    notes_title: 'Notes',
    notes_placeholder: 'Type your notes here — they are saved automatically…',
    section_system: 'System', uptime_prefix: 'Up for',
    sys_tab_main: 'System', sys_tab_net: 'Network & Gaming',
    weather_title: 'Weather', weather_loading: 'Loading weather', weather_local: 'Local',
    weather_unavailable: 'Weather unavailable', weather_feels: 'Feels like', weather_open: 'Open weather details',
    weather_details_title: 'Live conditions', weather_refresh: 'Refresh weather', weather_updated: 'Updated at',
    weather_hourly: 'Next hours', weather_forecast: 'Next days', weather_no_data: 'No data available',
    weather_status: 'Status', weather_retry_hint: 'Try again shortly', weather_rain_short: 'Rain', weather_sun: 'Sun',
    weather_metric_feels: 'Feels like', weather_metric_humidity: 'Humidity', weather_metric_humidity_sub: 'relative air',
    weather_metric_wind: 'Wind', weather_metric_rain: 'Precipitation', weather_metric_now: 'now',
    weather_metric_pressure: 'Pressure', weather_metric_pressure_sub: 'sea level',
    weather_metric_visibility: 'Visibility', weather_metric_visibility_sub: 'horizon',
    weather_metric_uv: 'UV index', weather_metric_uv_sub: 'radiation',
    weather_metric_clouds: 'Clouds', weather_metric_clouds_sub: 'cover',
    net_ping: 'PING', net_ping_sub: 'DNS server response',
    net_fps: 'FPS', net_fps_sub: 'Requires PresentMon / FrameView',
    net_latency: 'LATENCY', net_latency_sub: 'Ping variation',
    net_bandwidth: 'NETWORK', net_bandwidth_sub: 'Live throughput',
    metric_na: 'N/A',
    gpu_loading: 'Detecting GPU',
    disk_cycle_tip: 'Next disk', disk_label: 'DISK',
    disk_detail_unavailable: 'Detail unavailable',
    ram_detail_unavailable: 'RAM detail unavailable',
    gb_free: 'free',
    vol_title: 'Volume', vol_mute_tip: 'Mute speaker',
    device_speaker: 'Speaker', device_mic: 'Microphone',
    picker_speaker: 'Select speaker', picker_mic: 'Select microphone',
    media_player_dynamic: 'Media Player',
    tip_lock: 'Lock screen', tip_tabs: 'Open tabs', tip_focus_lock: 'Open widget lock screen', tip_apps: 'Open applications', tip_settings: 'Appearance settings',
    lock_exit: 'Close lock screen',
    lock_widget_clock: 'Clock', lock_widget_weather: 'Weather', lock_widget_media: 'Music', lock_widget_calendar: 'Events',
    lock_up_next: 'Up next', lock_empty_events: 'No upcoming events',
    apps_title: 'Open applications', apps_loading: 'Loading applications…',
    apps_empty: 'No open windows found', apps_refresh: 'Refresh',
    apps_active: 'Active', apps_open: 'Open application', apps_minimized: 'Minimized',
    apps_favorite: 'Add to favorites', apps_unfavorite: 'Remove from favorites', apps_favorite_open: 'Open favorite',
    tabs_title: 'Widget tabs', tab_current: 'Active',
    tab_full: 'Dashboard', tab_full_sub: 'Full view',
    tab_media: 'Media', tab_media_sub: 'Music and calendar',
    tab_mic: 'Microphone', tab_mic_sub: 'Mute and sensitivity',
    tab_notes: 'Notes', tab_notes_sub: 'Quick notes',
    tab_system: 'System', tab_system_sub: 'CPU, GPU, RAM',
    tab_audio: 'Audio', tab_audio_sub: 'Volume and devices',
    settings_title: 'Dashboard appearance', settings_subtitle: 'Colors, transparency and personal background',
    settings_preview_kicker: 'Live preview', settings_presets: 'Quick presets', settings_language: 'Language',
    settings_lockscreen: 'Lock screen', settings_lockscreen_hint: 'Quick widgets',
    settings_preset_xenon: 'Xenon', settings_preset_ocean: 'Ocean', settings_preset_ember: 'Ember',
    settings_preset_violet: 'Violet', settings_preset_mono: 'Mono',
    settings_colors: 'Colors', settings_accent: 'Accent', settings_accent_hint: 'actions and states',
    settings_background: 'Base background', settings_background_hint: 'behind panels',
    settings_text: 'Text', settings_text_hint: 'main contrast',
    settings_surface: 'Surface', settings_panel_opacity: 'Panel opacity',
    settings_bg_dim: 'Background dim', settings_bg_blur: 'Background blur',
    settings_bg_blur_note_empty: 'Visible after uploading an image, GIF or video.',
    settings_bg_blur_note_active: 'Blurs only the uploaded background media.',
    settings_background_media: 'Media background', settings_bg_upload: 'Upload image, GIF or video',
    settings_bg_upload_hint: 'PNG, JPG, WEBP, GIF, MP4 or WEBM up to 32 MB',
    settings_bg_image_loaded: 'Image/GIF active', settings_bg_video_loaded: 'Video active',
    settings_bg_clear: 'Remove', settings_bg_uploading: 'Uploading background…',
    settings_bg_uploaded: 'Background updated', settings_bg_upload_failed: 'Could not upload background',
    settings_bg_too_large: 'File too large: maximum 32 MB', settings_bg_removed: 'Background removed',
    settings_saved: 'Preferences saved', settings_persist_note: 'Preferences stay saved on this PC.',
    settings_reset: 'Reset defaults', settings_reset_done: 'Appearance reset'
  }
};

function t(key) {
  return (i18n[lang] && i18n[lang][key]) ?? i18n.it[key] ?? key;
}

function localizeAppName(name) {
  if (!name) return '';
  if (lang === 'en' && /lettore\s+multimediale/i.test(name)) return 'Media Player';
  if (lang === 'it' && /^media\s+player$/i.test(name)) return 'Lettore Multimediale';
  return name;
}

function applyTranslations() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    el.title = t(el.getAttribute('data-i18n-title'));
  });
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
  if ($('app-switcher') && !$('app-switcher').hidden) renderAppWindows();
  if ($('settings-overlay') && !$('settings-overlay').hidden) renderSettingsModal();
  if ($('lockscreen-overlay') && !$('lockscreen-overlay').hidden && typeof renderLockScreen === 'function') renderLockScreen();
}

function setLang(l) {
  if (!i18n[l] || l === lang) return;
  lang = l;
  localStorage.setItem('uiLang', l);
  applyTranslations();
  if (typeof syncLangButtons === 'function') syncLangButtons();
  if (typeof fetchWeather === 'function') fetchWeather();
}
