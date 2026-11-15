// The part of the Discord card that turns on showing its notifications on the dashboard, with the
// note that says when Discord has to be linked again.
'use strict';

(() => {
  const { t, el } = window.StreamingPageLoginWords;

  // Discord-only: the notification-mirroring opt-in, on the provider card because
  // the re-link its extra scope needs happens right here. Reads the shared
  // script-scope `hubSettings` (NOT window.hubSettings — never assigned) and saves
  // through settings/notifications.js's global updateDiscordNotifications. OFF by default.
  function buildDiscordNotifBlock(st) {
    const box = el('div', 'streaming-notif');
    const dn = (typeof hubSettings === 'object' && hubSettings && hubSettings.discordNotifications) || { enabled: false, hide: false };
    const toggleRow = (labelKey, labelFb, hintKey, hintFb, checked, onChange) => {
      const row = el('label', 'settings-toggle-row full');
      const inp = document.createElement('input');
      inp.type = 'checkbox'; inp.className = 'settings-check'; inp.checked = checked;
      inp.addEventListener('change', () => onChange(inp.checked));
      const line = el('span', 'settings-label-line');
      line.append(el('span', null, t(labelKey, labelFb)), el('span', 'settings-hint', t(hintKey, hintFb)));
      row.append(inp, line);
      return row;
    };
    const hideRow = toggleRow(
      'streaming_discord_notif_hide', 'Hide content until tapped',
      'streaming_discord_notif_hide_hint', 'Show who wrote, but keep the text masked until you tap the notification.',
      dn.hide, (on) => { if (typeof updateDiscordNotifications === 'function') updateDiscordNotifications('hide', on); });
    // Two ways to know a re-link is needed, and the first is the useful one.
    //
    // st.notifScope === 'missing' reads the GRANT: the stored token records what
    // Discord actually gave it, and the notification scope is not in the list. So
    // the warning can appear the moment the switch goes on, before anything has
    // been waited for. That matters because reconnecting cannot fix it — Discord
    // reuses an existing authorization and hands back the scopes already granted —
    // so someone who is not told now waits, sees nothing arrive, and reconnects
    // several times before finding out. Reported on Discord as exactly that.
    //
    // st.notif === 'scope_missing' stays as the backstop: a CONFIRMED failure,
    // set when the live watch really tried to subscribe and Discord refused. It
    // still catches a grant revoked from Discord's side after linking, which the
    // stored scope list cannot know about.
    //
    // 'unknown' (a token from before the scope was recorded) deliberately shows
    // nothing: it is not evidence, and a warning in front of someone whose
    // notifications work would be worse than the wait it saves. Those users still
    // get the backstop. And 'off' is not a failure either — right after a
    // successful Connect the scope check takes a beat, and warning then reads as
    // "it failed again".
    const relinkNeeded = (on) => on && st.connected
      && (st.notifScope === 'missing' || st.notif === 'scope_missing');
    // The fallback used to say "Disconnect and reconnect once", which is the one
    // thing that does NOT work: Discord's RPC AUTHORIZE reuses an existing
    // authorization and hands back a code for the scopes already granted, so the
    // new one is never asked for. The grant has to be removed on Discord's side
    // first. Kept in step with the translated string, which says the same.
    const relink = el('p', 'settings-note streaming-warn',
      t('streaming_discord_notif_relink',
        'Discord has not granted this app notification access: reconnecting alone will not help. '
        + 'Remove the app in Discord → User Settings → Authorizations, then link again.'));
    box.appendChild(toggleRow(
      'streaming_discord_notif', 'Mirror notifications on the dashboard',
      'streaming_discord_notif_hint', 'DMs and mentions appear in the Discord widget. Read locally from the desktop app: nothing leaves this PC.',
      dn.enabled, (on) => {
        if (typeof updateDiscordNotifications === 'function') updateDiscordNotifications('enabled', on);
        hideRow.hidden = !on;
        relink.hidden = !relinkNeeded(on);
      }));
    hideRow.hidden = !dn.enabled;
    relink.hidden = !relinkNeeded(dn.enabled);
    box.append(hideRow, relink);
    return box;
  }

  window.StreamingPageDiscordNotifications = { buildDiscordNotifBlock };
})();
