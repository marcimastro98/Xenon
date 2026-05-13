'use strict';

/**
 * modules/i18n.js — Runtime translations and DOM localisation.
 *
 * Translations are inlined here (same keys as translation.json) so the widget
 * works without a separate async fetch. The translation.json file is used only
 * by iCUE's own tr() evaluator for meta-property labels.
 */
(function () {
  const Hub = window.XenonEdgeHub;

  // ── Inlined translation table (mirrors translation.json) ─────────────────

  const TRANSLATIONS = {
    en: {
      open_calendar:       'Calendar',
      media_empty_title:   'Nothing playing',
      media_empty_sub:     'Spotify, YouTube and others will appear here',
      tip_prev:            'Previous',
      tip_play:            'Play / Pause',
      tip_next:            'Next',
      now_playing:         'Now playing',
      active_player:       'Active player',
      today:               'Today',
      upcoming:            'Upcoming',
      mic_active:          'Microphone active',
      mic_muted:           'Microphone muted',
      mic_input_live:      'Live input',
      mic_mute_tip:        'Toggle microphone mute',
      mic_sensitivity:     'SENS.',
      mic_server_required: 'Requires local server',
      notes_title:         'Notes',
      notes_placeholder:   'Type your notes here — saved automatically…',
      sys_tab_main:        'System',
      sys_tab_net:         'Network & Gaming',
      layout_customize:    'Customize dashboard',
      layout_exit:         'Done',
      layout_move_previous:'Move back',
      layout_move_next:    'Move forward',
      layout_resize:       'Change size',
      layout_hide:         'Hide',
      layout_restore:      'Restore',
      layout_reset:        'Reset layout',
      layout_hidden_widgets: 'Hidden widgets',
      layout_hidden_cards: 'Hidden cards',
      layout_no_hidden:    'Nothing hidden',
      layout_tabs:         'Tabs',
      layout_swap_tabs:    'Swap tab order',
      layout_widget_media: 'Media',
      layout_widget_mic:   'Microphone',
      layout_widget_notes: 'Notes',
      layout_widget_system:'System',
      layout_card_cpu:     'CPU',
      layout_card_gpu:     'GPU',
      layout_card_ram:     'RAM',
      layout_card_disk:    'Disk',
      layout_card_ping:    'Ping',
      layout_card_fps:     'FPS',
      layout_card_latency: 'Latency',
      layout_card_bandwidth: 'Network',
      metric_na:           'N/A',
      net_ping:            'PING',
      net_fps:             'FPS',
      net_latency:         'LATENCY',
      net_bandwidth:       'NETWORK',
      net_ping_sub:        'DNS server response',
      net_fps_sub:         'Requires PresentMon / FrameView',
      net_latency_sub:     'Ping variation',
      net_bandwidth_sub:   'Instant throughput',
      net_requires_server: 'Requires local server',
      gpu_loading:         'Detecting GPU…',
      vol_title:           'Volume',
      vol_mute_tip:        'Mute speaker',
      device_speaker:      'Speaker',
      device_mic:          'Microphone',
      audio_server_required: 'Requires local server',
      open_audio_settings: 'Open Audio Settings',
      reminder_at:         'At the time',
      reminder_5:          '5 min before',
      reminder_15:         '15 min before',
      reminder_30:         '30 min before',
      reminder_60:         '1 hour before',
      reminder_1440:       '1 day before',
      reminder_none:       'No reminder',
      add:                 'Add',
      agenda:              'Personal agenda',
      ph_title:            'Event title',
      ph_notes:            'Short note',
      close:               'Close',
      delete_event:        'Delete event',
      no_upcoming:         'No upcoming events',
      no_events:           'No events today',
      reminder:            'Reminder',
      desktop_title:       'XenonEdge Hub',
      disk_cycle_tip:      'Next disk',
      server_online:       'Server online',
      server_offline:      'Server offline',
      locale:              'en-US',
      weekdays:            ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
    },
    it: {
      open_calendar:       'Calendario',
      media_empty_title:   'Niente in riproduzione',
      media_empty_sub:     'Spotify, YouTube e altri player compariranno qui',
      tip_prev:            'Precedente',
      tip_play:            'Play / Pausa',
      tip_next:            'Successivo',
      now_playing:         'In riproduzione',
      active_player:       'Player attivo',
      today:               'Oggi',
      upcoming:            'Prossimi eventi',
      mic_active:          'Microfono attivo',
      mic_muted:           'Microfono silenziato',
      mic_input_live:      'Ingresso live',
      mic_mute_tip:        'Attiva/disattiva mute microfono',
      mic_sensitivity:     'SENS.',
      mic_server_required: 'Richiede server locale',
      notes_title:         'Appunti',
      notes_placeholder:   'Scrivi qui i tuoi appunti — vengono salvati automaticamente…',
      sys_tab_main:        'Sistema',
      sys_tab_net:         'Rete & Gaming',
      layout_customize:    'Personalizza dashboard',
      layout_exit:         'Fine',
      layout_move_previous:'Sposta indietro',
      layout_move_next:    'Sposta avanti',
      layout_resize:       'Cambia dimensione',
      layout_hide:         'Nascondi',
      layout_restore:      'Ripristina',
      layout_reset:        'Reimposta layout',
      layout_hidden_widgets: 'Widget nascosti',
      layout_hidden_cards: 'Schede nascoste',
      layout_no_hidden:    'Niente nascosto',
      layout_tabs:         'Tab',
      layout_swap_tabs:    'Scambia ordine tab',
      layout_widget_media: 'Media',
      layout_widget_mic:   'Microfono',
      layout_widget_notes: 'Appunti',
      layout_widget_system:'Sistema',
      layout_card_cpu:     'CPU',
      layout_card_gpu:     'GPU',
      layout_card_ram:     'RAM',
      layout_card_disk:    'Disco',
      layout_card_ping:    'Ping',
      layout_card_fps:     'FPS',
      layout_card_latency: 'Latenza',
      layout_card_bandwidth: 'Rete',
      metric_na:           'N/D',
      net_ping:            'PING',
      net_fps:             'FPS',
      net_latency:         'LATENZA',
      net_bandwidth:       'RETE',
      net_ping_sub:        'Risposta server DNS',
      net_fps_sub:         'Richiede PresentMon / FrameView',
      net_latency_sub:     'Variazione del ping',
      net_bandwidth_sub:   'Throughput istantaneo',
      net_requires_server: 'Richiede server locale',
      gpu_loading:         'GPU in rilevamento…',
      vol_title:           'Volume',
      vol_mute_tip:        'Silenzia altoparlante',
      device_speaker:      'Altoparlante',
      device_mic:          'Microfono',
      audio_server_required: 'Richiede server locale',
      open_audio_settings: 'Apri Impostazioni Audio',
      reminder_at:         "All'orario",
      reminder_5:          '5 min prima',
      reminder_15:         '15 min prima',
      reminder_30:         '30 min prima',
      reminder_60:         '1 ora prima',
      reminder_1440:       '1 giorno prima',
      reminder_none:       'Nessuna notifica',
      add:                 'Aggiungi',
      agenda:              'Agenda personale',
      ph_title:            'Titolo evento',
      ph_notes:            'Nota breve',
      close:               'Chiudi',
      delete_event:        'Elimina evento',
      no_upcoming:         'Nessun evento in arrivo',
      no_events:           'Nessun evento oggi',
      reminder:            'Promemoria',
      desktop_title:       'XenonEdge Hub',
      disk_cycle_tip:      'Disco successivo',
      server_online:       'Server online',
      server_offline:      'Server offline',
      locale:              'it-IT',
      weekdays:            ['Lu', 'Ma', 'Me', 'Gi', 'Ve', 'Sa', 'Do']
    }
  };

  let _lang = 'en';

  // ── Public API ────────────────────────────────────────────────────────────

  /** Translates a key. Falls back to EN, then the key itself. */
  Hub.tr = function (key) {
    const entry = (TRANSLATIONS[_lang] || {})[key];
    if (entry !== undefined) return entry;
    const fallback = (TRANSLATIONS.en || {})[key];
    return fallback !== undefined ? fallback : key;
  };

  /** Sets the active language and re-applies all DOM translations. */
  Hub.setLang = function (lang) {
    const code = String(lang).toLowerCase().split('-')[0];
    _lang = TRANSLATIONS[code] ? code : 'en';
    Hub.applyTranslations();
  };

  /** Returns the current language code. */
  Hub.getLang = function () { return _lang; };

  /**
   * Detects the preferred language from iCUE, then the browser navigator.
   * Call this inside onICUEInitialized before anything else.
   */
  Hub.detectLang = function () {
    // iCUE provides the UI language via iCUE.iCUELanguage
    if (typeof iCUE !== 'undefined' && iCUE && iCUE.iCUELanguage) {
      const code = String(iCUE.iCUELanguage).toLowerCase().split('-')[0];
      if (TRANSLATIONS[code]) return code;
    }
    // Browser fallback (useful during development)
    const nav = (navigator.language || 'en').toLowerCase().split('-')[0];
    return TRANSLATIONS[nav] ? nav : 'en';
  };

  /** Walks the DOM and replaces text/title/placeholder for all data-i18n* elements. */
  Hub.applyTranslations = function () {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = Hub.tr(key);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = Hub.tr(el.getAttribute('data-i18n-title'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = Hub.tr(el.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', Hub.tr(el.getAttribute('data-i18n-aria')));
    });
    if (Hub.refreshLayoutEditor) Hub.refreshLayoutEditor();
  };
}());
