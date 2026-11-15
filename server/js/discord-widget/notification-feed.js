// The Notifications tab of a Discord tile: one row per message with its Reply button, and what the
// tab says when the feed is off, loading or empty.
'use strict';

window.DiscordWidgetNotificationFeed = (wrapper) => {
  const {
    el, discordState, paint, openConversation, openStreamingSettings, notifIconBad, notifRevealed,
    NOTIF_ICON_BAD_MAX,
  } = wrapper;

  const { fmtNotifTime } = window.DiscordWidgetLists;
  const { t } = window.DiscordWidgetTabs;
  const { ICONS } = window.DiscordWidgetIcons;

  // ── Notification feed (Notifications tab) ─────────────────────────────────

  // One feed row. Title/body are Discord user content → textContent (via el),
  // never innerHTML; the avatar URL is https-only (enforced server-side). While
  // "hide content" is on, the body stays masked until the row is tapped.
  function notifRow(n) {
    const row = el('div', 'dc-notif');
    if (n.icon && !notifIconBad.has(n.icon)) {
      const img = document.createElement('img');
      img.className = 'dc-notif-ico'; img.alt = '';
      img.src = n.icon;
      img.addEventListener('error', () => {
        if (notifIconBad.size >= NOTIF_ICON_BAD_MAX) notifIconBad.clear();
        notifIconBad.add(n.icon);
        img.hidden = true;
      }, { once: true });
      row.appendChild(img);
    }
    const txt = el('div', 'dc-notif-txt');
    const head = el('div', 'dc-notif-head');
    head.append(el('span', 'dc-notif-title', n.title || ''), el('span', 'dc-notif-time', fmtNotifTime(n.at)));
    const body = el('div', 'dc-notif-body');
    const masked = discordState.notif.hide && n.body && !notifRevealed.has(n.id);
    body.textContent = masked ? t('discord_w_notif_hidden', 'Tap to show') : (n.body || '');
    body.classList.toggle('is-masked', !!masked);
    txt.append(head, body);
    row.appendChild(txt);
    const reply = replyButton(n);
    if (reply) row.appendChild(reply);
    if (discordState.notif.hide && n.body) {
      row.classList.add('is-tappable');
      row.addEventListener('click', () => {
        if (notifRevealed.has(n.id)) notifRevealed.delete(n.id); else notifRevealed.add(n.id);
        paint();
      });
    }
    return row;
  }

  // "Reply": bring Discord forward on this PC with that conversation open
  // (server/discord/discord-launch.js). Xenon cannot send the message itself, since
  // Discord's local connection has no command for it, so this is the shortest
  // honest path to answering. Only for a row that names its channel, and not on
  // a paired phone: the button acts on the PC's Discord, and someone holding a
  // phone answers in the Discord app in their hand.
  function replyButton(n) {
    if (!n.channelId) return null;
    if (window.RemoteSurface && typeof window.RemoteSurface.isRemote === 'function' && window.RemoteSurface.isRemote()) return null;
    const b = el('button', 'dc-notif-reply');
    b.type = 'button';
    b.title = t('discord_w_notif_reply_title', 'Open this conversation in Discord');
    b.setAttribute('aria-label', b.title);
    b.innerHTML = ICONS.reply;                       // static, trusted SVG
    b.appendChild(el('span', 'dc-notif-reply-lbl', t('discord_w_notif_reply', 'Reply')));
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();                          // the row's own tap reveals hidden text
      openConversation(b, n.channelId);
    });
    return b;
  }

  // The Notifications tab: opt-in feed with deliberate states — off (points at
  // Settings), token minted without the scope (points at a one-time re-link),
  // loading, empty, or the rows themselves.
  function paintNotifs(mount) {
    const list = mount.querySelector('.dc-notif-list');
    if (!list) return;
    // Skip the rebuild when nothing drawn has changed. paint() runs on every
    // voice push — a SPEAKING_START/STOP for anyone in the channel, several a
    // second while people are talking — and rebuilding the rows re-creates every
    // <img>, which is what made the avatars in the feed blink. Same guard, and
    // for the same reason, as the one in paintChannels. Reported on Discord.
    const sig = discordState.connected !== true ? 'x'
      : discordState.notifItems === null ? 'loading'
      : !discordState.notif.enabled ? 'off'
      : discordState.notif.state === 'scope_missing' ? 'relink'
      : !discordState.notifItems.length ? 'empty'
      : discordState.notifItems.map(n => n.id + ((discordState.notif.hide && n.body && !notifRevealed.has(n.id)) ? 'm' : '')).join('|');
    // The states, the masked body and the times are all rendered here, so a
    // language change or a 12/24h change has to redraw them.
    const full = sig + '#' + (document.documentElement.lang || '')
      + '#' + (timeParts().hour12 ? '12' : '24');
    if (list.dataset.dcSig === full) return;
    list.dataset.dcSig = full;
    const showMsg = (key, fb, cta) => {
      const box = el('div', 'dc-notif-empty');
      box.appendChild(el('span', 'dc-notif-empty-txt', t(key, fb)));
      if (cta) {
        const b = el('button', 'dc-notif-cta', t('discord_w_notif_settings', 'Open Settings')); b.type = 'button';
        b.addEventListener('click', openStreamingSettings);
        box.appendChild(b);
      }
      list.replaceChildren(box);
    };
    if (discordState.connected !== true) { showMsg('twitch_notlinked', 'Not linked'); return; }
    if (discordState.notifItems === null) { showMsg('discord_w_loading', 'Loading…'); return; }
    if (!discordState.notif.enabled) { showMsg('discord_w_notif_off', 'Notification mirroring is off', true); return; }
    if (discordState.notif.state === 'scope_missing') { showMsg('discord_w_notif_relink', 'Reconnect Discord once to activate notifications', true); return; }
    if (!discordState.notifItems.length) { showMsg('discord_w_notif_empty', 'No notifications yet'); return; }
    const frag = document.createDocumentFragment();
    discordState.notifItems.forEach(n => frag.appendChild(notifRow(n)));
    list.replaceChildren(frag);
  }

  return { paintNotifs };
};
