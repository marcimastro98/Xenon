// The parts of a Discord tile that are built once per mount: the header, the tab bar, the four
// panels with their buttons and volume rows, and the cover that offers to open Discord.
'use strict';

window.DiscordWidgetSkeleton = (wrapper) => {
  const { el, discordState, runAction, paint, openStreamingSettings, openDiscord } = wrapper;

  const { FEATURES, t, TABS } = window.DiscordWidgetTabs;
  const { ICONS } = window.DiscordWidgetIcons;

  // A one-tap control button (icon + label), state reflected in paint().
  function ctlBtn(cls, onClick) {
    const b = el('button', 'dc-btn ' + cls);
    b.append(el('span', 'dc-btn-ico'), el('span', 'dc-btn-lbl'));
    b.addEventListener('click', () => onClick(b));
    return b;
  }

  // A volume nudge row: label + [− value +]. dir buttons fire the given action type.
  function volRow(cls, labelKey, actionType) {
    const row = el('div', 'dc-vol ' + cls);
    row.appendChild(el('span', 'dc-vol-lbl', t(labelKey, '')));
    const ctr = el('div', 'dc-vol-ctr');
    const down = el('button', 'dc-vol-btn'); down.innerHTML = ICONS.minus;   // static, trusted SVG
    down.addEventListener('click', () => runAction(down, { type: actionType, mode: 'down' }));
    const val = el('span', 'dc-vol-val', '—');
    const up = el('button', 'dc-vol-btn'); up.innerHTML = ICONS.plus;         // static, trusted SVG
    up.addEventListener('click', () => runAction(up, { type: actionType, mode: 'up' }));
    ctr.append(down, val, up);
    row.appendChild(ctr);
    return row;
  }

  // Build the static skeleton once per mount (idempotent) so the per-update paint
  // and the tab switching don't fight; only dynamic content is refreshed.
  function ensure(mount) {
    if (mount.dataset.dcBuilt === '1' && mount.firstChild) return;
    mount.dataset.dcBuilt = '1';
    const tileId = window.TileTabMemory ? TileTabMemory.tileIdOf(mount, 'discord') : '';
    if (tileId) mount.dataset.dcTab = TileTabMemory.get(tileId, TABS.map((tb) => tb.id), 'controls');
    const wrap = el('div', 'dc-wrap');

    const head = el('div', 'dc-head');
    const brand = el('div', 'dc-brand');
    brand.append(el('span', 'dc-logo', 'Discord'), el('span', 'dc-user'));
    const pill = el('span', 'dc-pill');
    pill.append(el('span', 'dc-pill-dot'), el('span', 'dc-pill-txt'));
    head.append(brand, pill);
    wrap.appendChild(head);

    const notice = el('button', 'dc-notice'); notice.type = 'button'; notice.hidden = true;
    const nIco = el('span', 'dc-notice-ico'); nIco.innerHTML = ICONS.logo;   // static, trusted SVG
    notice.append(nIco, el('span', 'dc-notice-txt', t('twitch_not_connected', 'Connect in Settings → Streaming')));
    notice.addEventListener('click', openStreamingSettings);
    wrap.appendChild(notice);

    // Tab bar ---------------------------------------------------------------
    const tabs = el('div', 'dc-tabs');
    TABS.forEach(tb => {
      const b = el('button', 'dc-tab');
      b.type = 'button'; b.dataset.dtab = tb.id;
      b.appendChild(el('span', 'dc-tab-lbl', t(tb.labelKey, tb.fb)));
      // Unread counter for notifications that arrive while another tab is open;
      // filled in paint(), cleared the moment the tab is tapped.
      if (tb.id === 'notifs') { const bd = el('span', 'dc-tab-badge'); bd.hidden = true; b.appendChild(bd); }
      b.addEventListener('click', () => {
        mount.dataset.dcTab = tb.id;   // this tile only — a sibling tile keeps its own
        if (tileId) TileTabMemory.set(tileId, tb.id);
        if (tb.id === 'notifs') discordState.notifUnread = 0;
        paint();
      });
      tabs.appendChild(b);
    });
    wrap.appendChild(tabs);

    const body = el('div', 'dc-body');

    // Controls panel: voice controls + current-call members + audio processing --
    const pCtl = el('div', 'dc-panel dc-panel--controls'); pCtl.dataset.dtab = 'controls';
    const row = el('div', 'dc-btn-row');
    row.append(
      ctlBtn('dc-mute', (b) => runAction(b, { type: 'discordMute', mode: 'toggle' })),
      ctlBtn('dc-deaf', (b) => runAction(b, { type: 'discordDeafen', mode: 'toggle' })),
      ctlBtn('dc-ptt', (b) => runAction(b, { type: 'discordPtt', mode: 'toggle' })),
      ctlBtn('dc-leave', (b) => runAction(b, { type: 'discordLeave' })),
    );
    pCtl.appendChild(row);
    // Current call: title + members (with live speaking). Hidden when not in a call.
    // It sits above the volumes: a person's own volume row opens inside it, so the
    // two volume rows belong underneath the list of people, not between the
    // buttons and the people (Discord, Oct 2026).
    const call = el('div', 'dc-call'); call.hidden = true;
    const mctl = el('div', 'dc-mctl dc-call-mctl'); mctl.hidden = true;
    call.append(el('div', 'dc-sec-label dc-call-label'), el('div', 'dc-members dc-call-members'), mctl);
    pCtl.appendChild(call);
    // Volumes grouped so the panel can space its blocks (buttons / call / volumes /
    // audio) evenly down the full height instead of clustering them at the top.
    const vols = el('div', 'dc-ctl-group dc-ctl-vols');
    vols.append(
      volRow('dc-vol-in', 'dc_vol_mic', 'discordInputVol'),
      volRow('dc-vol-out', 'dc_vol_out', 'discordOutputVol'),
    );
    pCtl.appendChild(vols);
    // Audio processing toggles.
    const audio = el('div', 'dc-ctl-group dc-ctl-audio');
    audio.appendChild(el('div', 'dc-sec-label', t('layout_card_audio', 'Audio')));
    const chips = el('div', 'dc-chips');
    FEATURES.forEach(f => {
      const chip = el('button', 'dc-chip', t(f.labelKey, f.key));
      chip.dataset.feature = f.key;
      chip.addEventListener('click', () => runAction(chip, { type: 'discordAudioToggle', feature: f.key }));
      chips.appendChild(chip);
    });
    audio.appendChild(chips);
    pCtl.appendChild(audio);
    body.appendChild(pCtl);

    // Channels panel: full-height grouped channel list ----------------------
    const pCh = el('div', 'dc-panel dc-panel--channels'); pCh.dataset.dtab = 'channels';
    pCh.appendChild(el('div', 'dc-chan-list'));
    body.appendChild(pCh);

    // Soundboard panel: a grid of the user's soundboard sounds. Tapping a tile
    // plays it into the current voice channel (the discordSoundboard Deck action);
    // the ▶ auditions it locally from Discord's CDN without broadcasting.
    const pSb = el('div', 'dc-panel dc-panel--soundboard'); pSb.dataset.dtab = 'soundboard';
    const sbHint = el('div', 'dc-sound-hint', t('discord_w_sound_hint', 'Join a voice channel to play a sound')); sbHint.hidden = true;
    pSb.append(sbHint, el('div', 'dc-sound-grid'));
    body.appendChild(pSb);

    // Notifications panel: the mirrored DM/mention feed (opt-in) -------------
    const pNf = el('div', 'dc-panel dc-panel--notifs'); pNf.dataset.dtab = 'notifs';
    pNf.appendChild(el('div', 'dc-notif-list'));
    body.appendChild(pNf);

    wrap.appendChild(body);

    // "Open Discord" overlay — covers the whole widget while the account is linked
    // but the desktop app isn't running (voice reads fail), since none of the
    // controls work until Discord is up. Hidden otherwise (see paint()).
    const launch = el('div', 'dc-launch'); launch.hidden = true;
    const lIco = el('span', 'dc-launch-ico'); lIco.innerHTML = ICONS.logo;   // static, trusted SVG
    const lBtn = el('button', 'dc-launch-btn', t('discord_w_open', 'Open Discord')); lBtn.type = 'button';
    lBtn.addEventListener('click', () => openDiscord(lBtn));
    launch.append(lIco, el('span', 'dc-launch-msg', t('discord_w_offline', 'Discord isn\'t running')), lBtn);
    wrap.appendChild(launch);

    mount.replaceChildren(wrap);
  }

  return { ensure };
};
