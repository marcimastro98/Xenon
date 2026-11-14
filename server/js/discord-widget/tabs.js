// The tabs of the Discord tile: which tab each tile shows, whether any tile shows one, and the
// words on the tile in the user's language.
'use strict';

(() => {
  // Audio-processing features → their existing Deck option i18n keys (reused).
  const FEATURES = [
    { key: 'noise_suppression', labelKey: 'deck_opt_noise_suppression' },
    { key: 'echo_cancellation', labelKey: 'deck_opt_echo_cancellation' },
    { key: 'automatic_gain_control', labelKey: 'deck_opt_automatic_gain_control' },
    { key: 'qos', labelKey: 'deck_opt_qos' },
  ];

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page). Adding the widget
  // makes it live (seed + SSE) on the next layout pass; removing it parks it back.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="discord"]')).filter(el => el.closest('.pager-page, .layer-slot')); }

  // Internal tabs so the (grouped) channel list can use the whole widget height
  // instead of being squeezed under the controls. Controls tab also carries the
  // current call's members + who's speaking. Reuses the layout_card_* i18n labels.
  const TABS = [
    { id: 'controls', labelKey: 'layout_card_controls', fb: 'Controls' },
    { id: 'channels', labelKey: 'layout_card_channels', fb: 'Channels' },
    { id: 'soundboard', labelKey: 'discord_w_soundboard', fb: 'Soundboard' },
    { id: 'notifs', labelKey: 'discord_w_notifs', fb: 'Notifications' },
  ];

  // Which tab is open is a property of the TILE, not of the widget. It used to be
  // one shared variable, which was invisible while only one Discord tile could
  // exist — and is exactly what a second tile is for: asked for on Discord by
  // someone who wanted the notification feed on top and the voice controls
  // underneath, both on screen at once. Stored on the mount so it survives every
  // repaint and travels with the tile, and remembered per tile (TileTabMemory) so
  // a reload opens each tile on the tab it was left on.
  function mounts() {
    return tiles().map((t) => t.querySelector('.discord-widget-mount')).filter(Boolean);
  }

  function tabOf(mount) {
    const v = (mount && mount.dataset) ? mount.dataset.dcTab : '';
    return TABS.some((tb) => tb.id === v) ? v : 'controls';
  }

  // Is ANY tile showing this tab? The lazy loads and the roster poll ask this
  // rather than "is the tab open": with two tiles, one of them on Channels is
  // reason enough to poll, and one on Notifications means the feed is being read.
  function anyTabOpen(id) { return mounts().some((m) => tabOf(m) === id); }

  // Re-apply every static (language-dependent) label. ensure() sets these once at
  // build time, so without this they'd stay in the language the widget was first
  // painted in. Called from paint(), which applyTranslations() re-runs on a
  // language change — so the widget follows the UI language like every other panel.
  function applyLabels(mount) {
    mount.querySelectorAll('.dc-tab-lbl').forEach(lbl => {
      const def = TABS.find(x => x.id === lbl.parentElement.dataset.dtab);
      if (def) lbl.textContent = t(def.labelKey, def.fb);
    });
    const nTxt = mount.querySelector('.dc-notice-txt');
    if (nTxt) nTxt.textContent = t('twitch_not_connected', 'Connect in Settings → Streaming');
    const inLbl = mount.querySelector('.dc-vol-in .dc-vol-lbl');
    // Inside the Discord tile the name of the app goes without saying.
    if (inLbl) inLbl.textContent = t('dc_vol_mic', 'Mic volume');
    const outLbl = mount.querySelector('.dc-vol-out .dc-vol-lbl');
    if (outLbl) outLbl.textContent = t('dc_vol_out', 'Output volume');
    const audLbl = mount.querySelector('.dc-ctl-audio .dc-sec-label');
    if (audLbl) audLbl.textContent = t('layout_card_audio', 'Audio');
    mount.querySelectorAll('.dc-chip').forEach(chip => {
      const f = FEATURES.find(x => x.key === chip.dataset.feature);
      if (f) chip.textContent = t(f.labelKey, f.key);
    });
    const sHint = mount.querySelector('.dc-sound-hint');
    if (sHint) sHint.textContent = t('discord_w_sound_hint', 'Join a voice channel to play a sound');
    const lMsg = mount.querySelector('.dc-launch-msg');
    if (lMsg) lMsg.textContent = t('discord_w_offline', 'Discord isn\'t running');
    const lBtn = mount.querySelector('.dc-launch-btn');
    if (lBtn) lBtn.textContent = t('discord_w_open', 'Open Discord');
  }

  window.DiscordWidgetTabs = { FEATURES, t, tiles, TABS, tabOf, anyTabOpen, applyLabels };
})();
