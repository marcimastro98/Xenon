'use strict';
// Discord dashboard widget: live voice presence (current channel, its members +
// who's speaking, self mute / deafen / voice mode) with one-tap controls — mute,
// deafen, push-to-talk toggle, leave, mic & output volume — a voice-channel JOIN
// list grouped by server, and the audio-processing toggles. Every control goes
// through the allowlisted /actions/run dispatcher (the same discord* actions the
// Deck uses); the widget only READS state.
//
// EVENT-DRIVEN: instead of polling, the server SUBSCRIBEs to Discord's voice
// events and pushes fresh state over SSE (event: 'discord') → onSSE(). The widget
// only fetches once on mount (an instant first paint) and then idles until Discord
// actually changes — near-zero cost at rest. The Discord DESKTOP app must be
// running and the account linked in Settings → Streaming. Renders into
// .discord-widget-mount.
(function () {
  const { ICONS } = window.DiscordWidgetIcons;
  const { t, tiles, tabOf, anyTabOpen, applyLabels } = window.DiscordWidgetTabs;

  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  const discordState = {
    connected: null,      // null = unknown, from /stream/discord/status
    username: '',
    voice: null,          // last voice state (from the mount fetch or an SSE push)
    channels: null,       // cached voice-channel list
    channelsInflight: null,
    sounds: null,         // cached soundboard list (lazy: fetched when the tab opens)
    soundsInflight: null,
    previewAudio: null,   // shared <audio> for local sound auditions (one at a time)
    seeded: false,        // did the one-shot mount fetch run yet?
    // Roster: who's currently connected in each voice channel (Channels tab). Unlike
    // the event-driven voice state, this needs a GET_CHANNEL per channel, so it's
    // polled ONLY while the Channels tab is open and the page is visible (see
    // syncRosterPolling) — near-zero cost otherwise. Map<channelId, members[]>.
    roster: null,
    rosterInflight: null,
    rosterTimer: null,
    // Notification mirroring (opt-in): the feed's flags + a bounded item list.
    // Seeded lazily from GET /stream/discord/notifications the first time the tab
    // opens; new items then arrive over the `discord_notification` SSE event.
    notif: { enabled: false, hide: false, state: 'off' },  // state: 'off'|'ok'|'scope_missing'
    notifItems: null,        // null = not seeded yet
    notifInflight: null,
    notifUnread: 0,               // arrivals while another tab is open → red badge on the tab
    // Discord lets you set the volume of one person in your channel, and mute them
    // for yourself only — the thing you reach for when one friend is twice as loud
    // as everyone else. It has been available to community widgets since 4.11 and
    // had no control of its own here, so the only way to use it was to write a
    // widget. Someone asked where the setting was, which is a fair question to ask
    // about a feature with no setting.
    //
    // Tapping a name opens the controls under the list rather than in a popover: a
    // popover needs positioning, a dismiss rule and a z-index on a surface that is
    // often a touchscreen, and this widget already speaks in rows.
    openMember: '',       // id of the person whose controls are open, '' for none
    dragging: false,       // true while a finger/pointer is on the slider
  };

  const ROSTER_MS = 6000;


  const NOTIF_MAX = 30;
  const notifRevealed = new Set();   // ids tapped open while "hide content" is on
  // Avatar URLs that did not load. Discord hands one out for accounts with no
  // picture of their own and it does not always resolve, so a remembered URL is
  // never turned back into an <img>: without this every rebuild of the feed drew
  // the circle and then hid it again. Bounded — the feed itself is capped, and a
  // long session that somehow collects more than this starts the list over.
  const notifIconBad = new Set();
  // Member avatars that failed to load: the chip keeps the initial instead of
  // asking the CDN again on every rebuild. Bounded like notifIconBad.
  const avatarBad = new Set();
  const NOTIF_ICON_BAD_MAX = 200;

  // Open Settings → Streaming (from the widget's "not linked" notice).
  function openStreamingSettings() {
    openSettingsCategory('streaming');
  }

  // POST an allowlisted Deck action and flash the button. Refreshes the voice
  // state right after so the control reflects Discord immediately (before the SSE push).
  async function runAction(btn, action) {
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/actions/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) });
    const ok = !!(r && r.ok);
    btn.classList.add(ok ? 'ok' : 'err');
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1200);
    if (tiles().length) { await pullVoice(); paint(); }
    return r;
  }

  const {
    ensure,
  } = window.DiscordWidgetSkeleton({ el, discordState, runAction, paint, openStreamingSettings, openDiscord });

  // Launch the Discord desktop app, then re-check a few times so the overlay clears
  // itself the moment the app becomes reachable (each /voice read re-arms the watch).
  async function openDiscord(btn) {
    btn.disabled = true;
    await api('/stream/discord/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {});
    let tries = 0;
    const recheck = () => {
      if (!tiles().length) { btn.disabled = false; return; }
      pullVoice().then(() => {
        paint();
        tries += 1;
        if ((!discordState.voice || !discordState.voice.ok) && tries < 6) setTimeout(recheck, 2000);
        else btn.disabled = false;
      });
    };
    setTimeout(recheck, 2500);
  }

  // ── Favourite voice channels ───────────────────────────────────────────────
  const {
    splitFavourites, favIds, collapsedIds, isCollapsed, fmtNotifTime,
  } = window.DiscordWidgetLists;

  // Appended rather than prepended: a new favourite goes to the BOTTOM of the
  // pinned group, so starring a second channel never moves the first one out
  // from under the pointer that is about to click it.
  function toggleFav(id) {
    const key = String(id);
    if (typeof saveTileSetting !== 'function') return;
    const cur = favIds();
    const next = cur.includes(key) ? cur.filter((x) => x !== key) : cur.concat([key]);
    // Also from a widget on the screen, where the settings are read-only (utils.js).
    saveTileSetting({ discordFavChannels: next }).then((ok) => { if (!ok) renderWidgets(); });
    renderWidgets();
  }

  // ── Collapsing a server ────────────────────────────────────────────────────
  function saveCollapsed(next) {
    if (typeof saveTileSetting !== 'function') return;
    saveTileSetting({ discordCollapsedGuilds: next }).then((ok) => { if (!ok) renderWidgets(); });
    renderWidgets();
  }

  function toggleGuild(guildId) {
    const key = String(guildId || '');
    if (!key) return;
    const cur = collapsedIds();
    saveCollapsed(cur.includes(key) ? cur.filter(x => x !== key) : cur.concat([key]));
  }

  // One control for both halves of the request ("collapse all" and "expand
  // all"): while anything is open it closes everything, and once everything is
  // closed it opens everything. Two buttons would mean one of them is always
  // the no-op you just pressed.
  function toggleAllGuilds(ids) {
    const known = (ids || []).filter(Boolean).map(String);
    if (!known.length) return;
    const anyOpen = known.some(id => !isCollapsed(id));
    if (!anyOpen) { saveCollapsed(collapsedIds().filter(id => !known.includes(id))); return; }
    const cur = collapsedIds();
    saveCollapsed(cur.concat(known.filter(id => !cur.includes(id))));
  }

  const {
    memberChip, memberShape, fillMembers, fillMemberCtl, callTitle,
  } = window.DiscordWidgetCallPeople({ el, discordState, runAction, paint, avatarBad, NOTIF_ICON_BAD_MAX });

  const {
    paintChannels,
  } = window.DiscordWidgetChannelList({ el, discordState, runAction, toggleFav, toggleGuild, toggleAllGuilds, memberChip, memberShape });

  // Audition a sound locally from Discord's public CDN, without broadcasting it to
  // a voice channel. Guild sounds stream from the CDN; a built-in default sound or
  // a network hiccup simply no-ops. One shared <audio>, replaced on each play.
  function previewSound(id) {
    if (!/^\d+$/.test(String(id))) return;
    try {
      if (discordState.previewAudio) discordState.previewAudio.pause();
      discordState.previewAudio = new Audio('https://cdn.discordapp.com/soundboard-sounds/' + id);
      discordState.previewAudio.volume = 0.8;
      discordState.previewAudio.play().catch(() => { /* autoplay/network blocked → ignore */ });
    } catch { /* ignore */ }
  }

  // A soundboard tile: the name area plays the sound into the current voice channel
  // (the allowlisted discordSoundboard action), and the ▶ auditions it locally. Two
  // sibling buttons (never nested) so both stay valid, focusable controls.
  function soundTile(s) {
    const ref = (s.guildId || '') + '|' + s.id;
    const tile = el('div', 'dc-sound');
    const play = el('button', 'dc-sound-play'); play.type = 'button';
    play.title = s.name || '';   // full name on hover when the label is truncated
    play.appendChild(el('span', 'dc-sound-name', s.name || s.id));
    play.addEventListener('click', () => runAction(play, { type: 'discordSoundboard', sound: ref }));
    const prev = el('button', 'dc-sound-prev'); prev.type = 'button';
    prev.title = t('deck_sound_preview', 'Preview');
    prev.innerHTML = ICONS.play;   // static, trusted SVG
    prev.addEventListener('click', (e) => { e.stopPropagation(); previewSound(s.id); });
    tile.append(play, prev);
    return tile;
  }

  // The Soundboard tab: a grid of the user's sounds. A hint shows (and broadcasting
  // no-ops) when not in a voice channel, but auditioning still works.
  function paintSoundboard(mount) {
    const panel = mount.querySelector('.dc-panel--soundboard');
    if (!panel) return;
    const linked = discordState.connected === true;
    const inChan = !!(discordState.voice && discordState.voice.ok && discordState.voice.channel);
    const hint = panel.querySelector('.dc-sound-hint');
    if (hint) hint.hidden = !linked || inChan;
    const grid = panel.querySelector('.dc-sound-grid');
    if (!grid) return;
    if (!linked) { grid.replaceChildren(el('div', 'dc-sound-empty', t('twitch_notlinked', 'Not linked'))); return; }
    if (discordState.sounds === null) { grid.replaceChildren(el('div', 'dc-sound-empty', t('discord_w_loading', 'Loading…'))); return; }
    if (!discordState.sounds.length) { grid.replaceChildren(el('div', 'dc-sound-empty', t('discord_w_no_sounds', 'No soundboard sounds'))); return; }
    const frag = document.createDocumentFragment();
    discordState.sounds.forEach(s => frag.appendChild(soundTile(s)));
    grid.replaceChildren(frag);
  }

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
  // (server/discord-launch.js). Xenon cannot send the message itself, since
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

  async function openConversation(btn, channelId) {
    if (btn.disabled) return;
    btn.disabled = true; btn.classList.remove('ok', 'err');
    const r = await api('/stream/discord/open-chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId }),
    }).catch(() => null);
    const ok = !!(r && r.ok);
    btn.classList.add(ok && r.selected ? 'ok' : 'err');
    // Said, not left to a red flash: either Discord came up without the chat,
    // or it could not be started at all, and the user needs to know which.
    if (window.XenonToast && !(ok && r.selected)) {
      window.XenonToast.show({
        type: ok ? 'info' : 'warn',
        title: t(ok ? 'discord_w_notif_reply_partial' : 'discord_w_notif_reply_failed',
          ok ? "Discord is open, but the conversation didn't open: find it there" : "Couldn't open Discord on this PC"),
      });
    }
    setTimeout(() => { btn.classList.remove('ok', 'err'); btn.disabled = false; }, 1200);
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

  // Seed the feed (flags + recent buffer) — once, lazily, when the tab first
  // opens. Newest first; live items then prepend via onNotification().
  function loadNotifs() {
    if (discordState.notifInflight) return discordState.notifInflight;
    discordState.notifInflight = api('/stream/discord/notifications').then(d => {
      if (d && d.ok) {
        discordState.notif = { enabled: !!d.enabled, hide: !!d.hide, state: d.state || 'off' };
        discordState.notifItems = Array.isArray(d.items) ? d.items.slice(-NOTIF_MAX).reverse() : [];
      } else if (discordState.notifItems === null) discordState.notifItems = [];
    }).catch(() => { if (discordState.notifItems === null) discordState.notifItems = []; })
      .finally(() => { discordState.notifInflight = null; });
    return discordState.notifInflight;
  }

  function syncNotifsLoad() {
    if (anyTabOpen('notifs') && discordState.connected === true && discordState.notifItems === null && !discordState.notifInflight) {
      loadNotifs().then(paint);
    }
  }

  // Live push (SSE `discord_notification`): prepend + cap. An arriving item also
  // proves the subscription is live, whatever the last seeded flags said.
  function onNotification(item) {
    if (!item || typeof item !== 'object') return;
    if (discordState.notifItems === null) discordState.notifItems = [];
    discordState.notifItems.unshift(item);
    if (discordState.notifItems.length > NOTIF_MAX) discordState.notifItems.length = NOTIF_MAX;
    discordState.notif.enabled = true;
    discordState.notif.state = 'ok';
    if (!anyTabOpen('notifs')) discordState.notifUnread += 1;   // no badge while a tile is showing the feed
    if (tiles().length) paint();
  }

  // Soundboard list — fetched once (lazily, the first time the tab is opened while
  // Discord is reachable), then cached. Degrades to [] when Discord is offline.
  function loadSounds() {
    if (discordState.soundsInflight) return discordState.soundsInflight;
    discordState.soundsInflight = api('/stream/discord/sounds').then(d => {
      discordState.sounds = (d && d.ok && Array.isArray(d.sounds)) ? d.sounds : [];
    }).catch(() => { discordState.sounds = []; }).finally(() => { discordState.soundsInflight = null; });
    return discordState.soundsInflight;
  }

  // Lazily load the soundboard the first time its tab is opened while Discord is up.
  // One-shot (no polling): once `sounds` is an array it never refetches until reset.
  function syncSoundsLoad() {
    if (anyTabOpen('soundboard') && discordState.connected === true && discordState.voice && discordState.voice.ok && discordState.sounds === null && !discordState.soundsInflight) {
      loadSounds().then(paint);
    }
  }

  function paint() {
    const linked = discordState.connected === true;
    const live = !!(discordState.voice && discordState.voice.ok);
    const inChan = live && discordState.voice.channel;
    tiles().forEach(tile => {
      const mount = tile.querySelector('.discord-widget-mount');
      if (!mount) return;
      ensure(mount);
      applyLabels(mount);   // keep static labels in the current UI language
      mount.querySelector('.dc-wrap').classList.toggle('dc-off', !linked);
      mount.querySelector('.dc-user').textContent = linked ? (discordState.username || '') : '';

      const pill = mount.querySelector('.dc-pill');
      pill.classList.toggle('in-voice', !!inChan);
      mount.querySelector('.dc-pill-txt').textContent =
        !linked ? t('twitch_notlinked', 'Not linked')
          : inChan ? callTitle()
            : t('discord_w_idle', 'Not in a channel');

      const notice = mount.querySelector('.dc-notice');
      if (notice) notice.hidden = linked;

      // "Open Discord" overlay: linked, but the desktop app isn't reachable (a
      // loaded voice state that came back not-ok). Not shown until voice is known,
      // so it doesn't flash before the first read resolves.
      const launch = mount.querySelector('.dc-launch');
      if (launch) launch.hidden = !(linked && discordState.voice && discordState.voice.ok === false);

      // Tabs: each tile reflects ITS OWN open tab, so two Discord tiles can show
      // two different ones at the same time.
      const tab = tabOf(mount);
      mount.querySelectorAll('.dc-tab').forEach(tb => tb.classList.toggle('is-active', tb.dataset.dtab === tab));
      mount.querySelectorAll('.dc-panel').forEach(p => { p.hidden = p.dataset.dtab !== tab; });
      const badge = mount.querySelector('.dc-tab-badge');
      if (badge) {
        badge.hidden = discordState.notifUnread <= 0;
        badge.textContent = discordState.notifUnread > 9 ? '9+' : String(discordState.notifUnread);
      }

      // Mute
      const mute = mount.querySelector('.dc-mute');
      const muted = !!(live && discordState.voice.mute);
      mute.classList.toggle('is-on', muted);
      mute.querySelector('.dc-btn-ico').innerHTML = muted ? ICONS.micOff : ICONS.micOn;
      mute.querySelector('.dc-btn-lbl').textContent = muted ? t('twitch_mic_unmute', 'Unmute') : t('twitch_mic_mute', 'Mute');
      // Deafen
      const deaf = mount.querySelector('.dc-deaf');
      const deafened = !!(live && discordState.voice.deaf);
      deaf.classList.toggle('is-on', deafened);
      deaf.querySelector('.dc-btn-ico').innerHTML = deafened ? ICONS.deafOff : ICONS.deafOn;
      deaf.querySelector('.dc-btn-lbl').textContent = deafened ? t('discord_w_undeafen', 'Undeafen') : t('discord_w_deafen', 'Deafen');
      // Push-to-talk / voice activity (label shows the CURRENT mode)
      const ptt = mount.querySelector('.dc-ptt');
      const isPtt = !!(live && discordState.voice.mode === 'PUSH_TO_TALK');
      ptt.classList.toggle('is-on', isPtt);
      ptt.querySelector('.dc-btn-ico').innerHTML = isPtt ? ICONS.ptt : ICONS.vad;
      ptt.querySelector('.dc-btn-lbl').textContent = isPtt ? t('deck_opt_ptt', 'Push-to-talk') : t('deck_opt_vad', 'Voice activity');
      // Leave (only meaningful while in a channel)
      const leave = mount.querySelector('.dc-leave');
      leave.classList.toggle('is-idle', !inChan);
      leave.querySelector('.dc-btn-ico').innerHTML = ICONS.leave;
      leave.querySelector('.dc-btn-lbl').textContent = t('discord_w_leave', 'Leave');

      // Volumes
      const inVal = mount.querySelector('.dc-vol-in .dc-vol-val');
      if (inVal) inVal.textContent = (live && discordState.voice.inputVolume != null) ? String(discordState.voice.inputVolume) : '—';
      const outVal = mount.querySelector('.dc-vol-out .dc-vol-val');
      if (outVal) outVal.textContent = (live && discordState.voice.outputVolume != null) ? String(discordState.voice.outputVolume) : '—';

      // Audio chips
      mount.querySelectorAll('.dc-chip').forEach(chip => {
        const on = !!(live && discordState.voice.features && discordState.voice.features[chip.dataset.feature]);
        chip.classList.toggle('is-on', on);
      });

      // Current call (Controls tab): title + members with live speaking. Hidden when
      // not in a call.
      const call = mount.querySelector('.dc-call');
      if (call) {
        call.hidden = !inChan;
        if (inChan) {
          call.querySelector('.dc-call-label').textContent = callTitle();
          fillMembers(call.querySelector('.dc-call-members'));
          fillMemberCtl(call.querySelector('.dc-call-mctl'));
        } else {
          discordState.openMember = '';   // left the call: nothing to point at any more
        }
      }

      paintChannels(mount);
      paintSoundboard(mount);
      paintNotifs(mount);
    });
    syncRosterPolling();   // start/stop the Channels-tab roster poll to match the current view
    syncSoundsLoad();      // lazily load the soundboard the first time its tab is opened
    syncNotifsLoad();      // lazily seed the notification feed the first time its tab is opened
  }

  // Voice-channel list — fetched once when linked (deduped across the multi-pass
  // layout init), then cached. Degrades to [] when Discord is offline.
  function loadChannels() {
    if (discordState.channelsInflight) return discordState.channelsInflight;
    discordState.channelsInflight = api('/stream/discord/channels').then(d => {
      discordState.channels = (d && d.ok && Array.isArray(d.channels)) ? d.channels : [];
    }).catch(() => { discordState.channels = []; }).finally(() => { discordState.channelsInflight = null; });
    return discordState.channelsInflight;
  }

  async function pullVoice() {
    const v = await api('/stream/discord/voice');
    discordState.voice = (v && typeof v === 'object') ? v : null;
  }

  // Fetch the per-channel roster (who's in each voice channel) into a Map. Keeps the
  // previous roster on a transient failure so the strip doesn't flicker empty.
  function loadRoster() {
    if (discordState.rosterInflight) return discordState.rosterInflight;
    discordState.rosterInflight = api('/stream/discord/roster').then(d => {
      if (d && d.ok && Array.isArray(d.channels)) {
        const map = new Map();
        d.channels.forEach(c => { if (c && c.id) map.set(String(c.id), Array.isArray(c.members) ? c.members : []); });
        discordState.roster = map;
      }
    }).catch(() => { /* keep last roster on a transient blip */ })
      .finally(() => { discordState.rosterInflight = null; });
    return discordState.rosterInflight;
  }

  // Poll the roster ONLY while the Channels tab is open, Discord is linked, the page
  // is visible and a tile is placed — so the per-channel GET_CHANNEL reads never run
  // when nobody's looking (keeps the integration lightweight).
  function rosterWanted() {
    return anyTabOpen('channels') && discordState.connected === true && !document.hidden && tiles().some(onVisiblePage);
  }

  function syncRosterPolling() {
    if (rosterWanted()) {
      if (discordState.rosterTimer) return;                          // already polling
      discordState.rosterTimer = setInterval(() => { loadRoster().then(paint); }, ROSTER_MS);
      loadRoster().then(paint);                         // instant first fill on open
    } else if (discordState.rosterTimer) {
      clearInterval(discordState.rosterTimer); discordState.rosterTimer = null;
      discordState.roster = null;                                    // drop stale membership; reopening refetches
    }
  }

  // One-shot seed on mount: status + voice + channels for an instant first paint.
  // After this, live changes arrive via onSSE() — the widget never polls.
  async function seed() {
    if (!tiles().length) return;
    const s = await api('/stream/discord/status');
    if (s) { discordState.connected = !!s.connected; discordState.username = s.login || ''; }
    if (discordState.connected) {
      await pullVoice();
      // Load the channel list once Discord is actually reachable (voice.ok). If it
      // drops (app closed), forget the cached list so it reloads when it returns.
      if (discordState.voice && discordState.voice.ok) { if (discordState.channels === null) await loadChannels(); }
      else { discordState.channels = null; discordState.sounds = null; }
    } else {
      discordState.voice = null; discordState.channels = null; discordState.sounds = null;
    }
    paint();
  }

  // Live push from the server's voice-event watch: fresh {connected, login, voice}.
  // Zero work happens here until Discord actually changes something.
  function onSSE(data) {
    if (!data || typeof data !== 'object') return;
    discordState.connected = !!data.connected;
    discordState.username = data.login || '';
    discordState.voice = (data.voice && typeof data.voice === 'object') ? data.voice : null;
    // Feed health rides the same event ('off' | 'ok' | 'scope_missing') so the
    // Notifications tab can point at the one-time re-link without polling.
    if (typeof data.notif === 'string') discordState.notif.state = data.notif;
    if (discordState.connected && discordState.voice && discordState.voice.ok) { if (discordState.channels === null) { loadChannels().then(paint); } }
    else if (!discordState.connected) { discordState.channels = null; discordState.sounds = null; discordState.notifItems = null; notifRevealed.clear(); discordState.notifUnread = 0; }
    paint();
  }

  function renderWidgets() {
    // No tiles placed → park state so a later re-add re-seeds from scratch, and stop
    // the roster poll (syncRosterPolling sees no tiles → clears its timer).
    if (!tiles().length) { discordState.seeded = false; syncRosterPolling(); return; }
    paint();                                       // instant paint from cache
    if (!discordState.seeded) { discordState.seeded = true; seed(); }        // deduped across the multi-pass layout init
  }

  // Re-evaluate the roster poll when the page is hidden/shown (stop while hidden).
  document.addEventListener('visibilitychange', syncRosterPolling);

  // splitFavourites is published for the tests: this file cannot be required in
  // node (it reaches for browser globals at IIFE top level, unlike
  // js/phone-view.js), so the suite lifts that one pure function out of the
  // source and runs it instead. Reaching the rendered list would need a linked
  // Discord account, which no test has.
  window.DiscordWidget = { renderWidgets, onSSE, onNotification, splitFavourites };
})();
