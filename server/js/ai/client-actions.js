// Runs on the dashboard the actions the AI answers with.
'use strict';

function _aiExecuteClientAction(action, args) {
  switch (action) {
    case 'open_weather_panel':
      if (typeof toggleWeatherDetails === 'function') toggleWeatherDetails();
      break;
    case 'open_settings':
      if (typeof toggleSettings === 'function') toggleSettings();
      break;
    case 'open_app_switcher':
      if (typeof toggleAppSwitcher === 'function') toggleAppSwitcher();
      break;
    case 'open_sparks_shop':
      if (window.XenonCredits && typeof XenonCredits.openShop === 'function') XenonCredits.openShop();
      break;
    case 'open_whats_new':
      if (window.XenonWhatsNew) XenonWhatsNew.reopen();
      break;
    case 'open_store_entry':
      if (window.CommunityGallery) CommunityGallery.openEntryById(String(args.entryId || ''));
      break;
    case 'show_lock_screen':   // pre-v4.4 alias — was a TOGGLE, keep that semantic
      if (window.AmbientMode) AmbientMode.toggle();
      break;
    case 'start_ambient_mode':
      if (window.AmbientMode) AmbientMode.open({ manual: true });
      break;
    case 'stop_ambient_mode':
      if (window.AmbientMode) AmbientMode.close();
      break;
    case 'change_theme':
      if (typeof setThemePreset === 'function' && args.preset) {
        setThemePreset(String(args.preset).toLowerCase());
      }
      break;
    case 'close_ai_panel':
      closeAiPanel();
      break;
    case 'optimize_performance':
      if (window.PerfMode && typeof window.PerfMode.optimize === 'function') window.PerfMode.optimize();
      break;
    case 'restore_performance':
      if (window.PerfMode && typeof window.PerfMode.restore === 'function') window.PerfMode.restore();
      break;
    case 'customize_appearance':
      if (typeof applyAiAppearance === 'function') applyAiAppearance(args);
      break;
    case 'style_tile':
      if (window.TileDress) window.TileDress.dress(args);
      break;
    case 'create_dashboard_style':
      if (typeof applyAiCreateStyle === 'function') applyAiCreateStyle(args);
      break;
    case 'create_animated_background':
      if (typeof applyAiAnimatedBackground === 'function') applyAiAnimatedBackground(args);
      break;
    case 'configure_preferences':
      if (typeof applyAiPreferences === 'function') applyAiPreferences(args);
      break;
    case 'set_media_source':
      if (typeof setPreferredMediaSource === 'function') {
        const src = String(args.source || '').trim();
        setPreferredMediaSource(/^(auto|automatic|automatico)$/i.test(src) ? '' : src);
      }
      break;
    case 'confirm_pc_command':
      _aiShowPcConfirm(args || {});
      break;
    case 'confirm_deck_action':
      if (window.AiDeckConfirm) {
        window.AiDeckConfirm.open(args || {}, {
          onOpen: () => {
            // Same guard as the PC card: no listening while the card is up.
            _aiPcConfirmOpen = true;
            if (_aiFollowupTimer) { clearTimeout(_aiFollowupTimer); _aiFollowupTimer = null; }
            if (aiListening) { try { _aiStopServerRecorder(); } catch {} }
          },
          onClose: () => {
            _aiPcConfirmOpen = false;
            if (_aiVoiceSessionActive && !aiListening) _aiStartFollowupListen();
          },
        });
      }
      break;
    case 'run_deck_client':
      // A sound or the mixer: only a dashboard can play them (deck.js).
      if (window.DeckClientRun) window.DeckClientRun(args && args.action);
      break;
    case 'refresh_tasks':
      if (typeof loadTasks === 'function') loadTasks();
      break;
    case 'refresh_calendar':
      if (typeof loadCalendarEvents === 'function') loadCalendarEvents();
      if (typeof renderUpcoming === 'function') renderUpcoming();
      break;
    case 'refresh_notes':
      if (typeof loadNotes === 'function') loadNotes();
      break;
    case 'refresh_timers':
      if (typeof loadTimers === 'function') loadTimers();
      break;
    case 'show_monitor_picker':
      _aiShowVoiceMonitorPicker(args.screens || []);
      break;
    case 'go_to_page':
      if (window.DashboardPager && args.page) window.DashboardPager.goToPage(String(args.page));
      break;
    case 'switch_deck_profile':
      if (window.Deck && window.Deck.switchProfileByName && args.profile) {
        window.Deck.switchProfileByName(String(args.profile));
      }
      break;
    case 'genesis_compose_page':
      if (window.Genesis) window.Genesis.composePage(args.name, args.widgets, { tabs: args.tabs, sizes: args.sizes });
      break;
    case 'genesis_add_widgets':
      if (window.Genesis) window.Genesis.addWidgets(args.page, args.widgets, { tabs: args.tabs });
      break;
    case 'genesis_duplicate_widget':
      if (window.Genesis && window.Genesis.duplicateWidget) window.Genesis.duplicateWidget(args.widget, args.page);
      break;
    case 'genesis_remove_page':
      if (window.Genesis) window.Genesis.removePage(args.page);
      break;
    case 'genesis_setup_deck':
      if (window.Genesis && window.Genesis.setupDeck) window.Genesis.setupDeck(args);
      break;
    case 'configure_deck':
      // Full-vocabulary deck composer: every action re-validated by
      // DeckActions.validateAction inside applyAiDeck before anything persists.
      if (window.Deck && window.Deck.applyAiDeck) window.Deck.applyAiDeck(args || {});
      break;
    case 'place_created_widget':
      if (window.CustomWidget && window.CustomWidget.placeCreated && args && args.id) window.CustomWidget.placeCreated(String(args.id));
      break;
    case 'marketplace_open_import':
      // A catalog entry the AI resolved — the NORMAL import review dialog opens;
      // the user confirms (or cancels) exactly like a hand-pasted code.
      // A code the assistant made replaces its previous draft's dialog.
      if (window.PresetShare && window.PresetShare.openImport && args && args.code) window.PresetShare.openImport(String(args.code), { draft: args.created === true });
      break;
  }
}
