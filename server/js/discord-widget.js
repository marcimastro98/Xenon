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
  const ICONS = {
    micOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    micOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M9 9v2a3 3 0 0 0 4.5 2.6M15 11V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 10 6.3M12 18v3"/></svg>',
    deafOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="2" y="14" width="5" height="6" rx="1.5"/><rect x="17" y="14" width="5" height="6" rx="1.5"/></svg>',
    deafOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 3 18 18M4 14v-2a8 8 0 0 1 12.5-6.6M20 12v2"/><rect x="2" y="14" width="5" height="6" rx="1.5"/><rect x="17" y="14" width="5" height="6" rx="1.5"/></svg>',
    ptt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M7 11h.01M11 11h.01M15 11h.01M7 15h10"/></svg>',
    vad: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h2l2-5 3 12 3-16 2 9h4"/></svg>',
    leave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4"/><path d="M10 17 5 12l5-5M5 12h11"/></svg>',
    join: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M16 9a5 5 0 0 1 0 6"/></svg>',
    minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6a16 16 0 0 0-4-1l-.3.6a12 12 0 0 1 3.5 1.1 13 13 0 0 0-10.4 0A12 12 0 0 1 10.3 5.6L10 5a16 16 0 0 0-4 1C3.5 9.7 2.8 13.3 3.2 16.8a16 16 0 0 0 4.9 2.5l1-1.7a10 10 0 0 1-1.6-.8l.4-.3a11 11 0 0 0 9.4 0l.4.3a10 10 0 0 1-1.6.8l1 1.7a16 16 0 0 0 4.9-2.5c.5-4-.6-7.6-3.4-10.8Z"/><circle cx="9.3" cy="13" r="1.2"/><circle cx="14.7" cy="13" r="1.2"/></svg>',
  };
  // Audio-processing features → their existing Deck option i18n keys (reused).
  const FEATURES = [
    { key: 'noise_suppression', labelKey: 'deck_opt_noise_suppression' },
    { key: 'echo_cancellation', labelKey: 'deck_opt_echo_cancellation' },
    { key: 'automatic_gain_control', labelKey: 'deck_opt_automatic_gain_control' },
    { key: 'qos', labelKey: 'deck_opt_qos' },
  ];

  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl;   // shared DOM factory from utils.js
  const api = apiJson; // shared fetch-JSON helper from utils.js

  // Only tiles actually placed on a dashboard page count. A hidden / never-added
  // widget sits in the #widget-pool (outside any .pager-page). Adding the widget
  // makes it live (seed + SSE) on the next layout pass; removing it parks it back.
  function tiles() { return Array.from(document.querySelectorAll('[data-dashboard-widget="discord"]')).filter(el => el.closest('.pager-page')); }

  let connected = null;      // null = unknown, from /stream/discord/status
  let username = '';
  let voice = null;          // last voice state (from the mount fetch or an SSE push)
  let channels = null;       // cached voice-channel list
  let channelsInflight = null;
  let seeded = false;        // did the one-shot mount fetch run yet?

  // Roster: who's currently connected in each voice channel (Channels tab). Unlike
  // the event-driven voice state, this needs a GET_CHANNEL per channel, so it's
  // polled ONLY while the Channels tab is open and the page is visible (see
  // syncRosterPolling) — near-zero cost otherwise. Map<channelId, members[]>.
  let roster = null;
  let rosterInflight = null;
  let rosterTimer = null;
  const ROSTER_MS = 6000;

  // Internal tabs so the (grouped) channel list can use the whole widget height
  // instead of being squeezed under the controls. Controls tab also carries the
  // current call's members + who's speaking. Reuses the layout_card_* i18n labels.
  const TABS = [
    { id: 'controls', labelKey: 'layout_card_controls', fb: 'Controls' },
    { id: 'channels', labelKey: 'layout_card_channels', fb: 'Channels' },
  ];
  let activeTab = 'controls';   // shared across this widget's tiles (session-scoped)

  // Open Settings → Streaming (from the widget's "not linked" notice).
  function openStreamingSettings() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.hidden && typeof window.toggleSettings === 'function') window.toggleSettings();
    if (typeof window.settingsSetCategory === 'function') window.settingsSetCategory('streaming');
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
      const b = el('button', 'dc-tab', t(tb.labelKey, tb.fb));
      b.type = 'button'; b.dataset.dtab = tb.id;
      b.addEventListener('click', () => { activeTab = tb.id; paint(); });
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
    // Volumes grouped so the panel can space its blocks (buttons / volumes / call /
    // audio) evenly down the full height instead of clustering them at the top.
    const vols = el('div', 'dc-ctl-group dc-ctl-vols');
    vols.append(
      volRow('dc-vol-in', 'deck_act_discordInputVol', 'discordInputVol'),
      volRow('dc-vol-out', 'deck_act_discordOutputVol', 'discordOutputVol'),
    );
    pCtl.appendChild(vols);
    // Current call: title + members (with live speaking). Hidden when not in a call.
    const call = el('div', 'dc-call'); call.hidden = true;
    call.append(el('div', 'dc-sec-label dc-call-label'), el('div', 'dc-members dc-call-members'));
    pCtl.appendChild(call);
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
        if ((!voice || !voice.ok) && tries < 6) setTimeout(recheck, 2000);
        else btn.disabled = false;
      });
    };
    setTimeout(recheck, 2500);
  }

  // Group the flat channel list by server (guild), preserving first-seen order so
  // the list reads the same way every render.
  function groupByGuild(list) {
    const groups = new Map();
    list.forEach(c => {
      const g = c.guild || '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    });
    return groups;
  }

  // A compact member chip: display name + a live speaking highlight + a muted/
  // deafened marker. Names are dynamic Discord data → textContent (via el), never
  // innerHTML. Reused by the current-call strip and the per-channel roster.
  function memberChip(m) {
    const chip = el('span', 'dc-member');
    chip.classList.toggle('is-speaking', !!m.speaking);
    chip.classList.toggle('is-muted', !!(m.mute || m.deaf));
    chip.append(el('span', 'dc-member-dot'), el('span', 'dc-member-name', m.name || '—'));
    return chip;
  }

  // Fill a container with member chips for the current call.
  function fillMembers(box) {
    const members = (voice && Array.isArray(voice.members)) ? voice.members : [];
    const frag = document.createDocumentFragment();
    members.forEach(m => frag.appendChild(memberChip(m)));
    box.replaceChildren(frag);
  }

  // Re-apply every static (language-dependent) label. ensure() sets these once at
  // build time, so without this they'd stay in the language the widget was first
  // painted in. Called from paint(), which applyTranslations() re-runs on a
  // language change — so the widget follows the UI language like every other panel.
  function applyLabels(mount) {
    mount.querySelectorAll('.dc-tab').forEach(tb => {
      const def = TABS.find(x => x.id === tb.dataset.dtab);
      if (def) tb.textContent = t(def.labelKey, def.fb);
    });
    const nTxt = mount.querySelector('.dc-notice-txt');
    if (nTxt) nTxt.textContent = t('twitch_not_connected', 'Connect in Settings → Streaming');
    const inLbl = mount.querySelector('.dc-vol-in .dc-vol-lbl');
    if (inLbl) inLbl.textContent = t('deck_act_discordInputVol', '');
    const outLbl = mount.querySelector('.dc-vol-out .dc-vol-lbl');
    if (outLbl) outLbl.textContent = t('deck_act_discordOutputVol', '');
    const audLbl = mount.querySelector('.dc-ctl-audio .dc-sec-label');
    if (audLbl) audLbl.textContent = t('layout_card_audio', 'Audio');
    mount.querySelectorAll('.dc-chip').forEach(chip => {
      const f = FEATURES.find(x => x.key === chip.dataset.feature);
      if (f) chip.textContent = t(f.labelKey, f.key);
    });
    const lMsg = mount.querySelector('.dc-launch-msg');
    if (lMsg) lMsg.textContent = t('discord_w_offline', 'Discord isn\'t running');
    const lBtn = mount.querySelector('.dc-launch-btn');
    if (lBtn) lBtn.textContent = t('discord_w_open', 'Open Discord');
  }

  // Title for the channel/call you're in: the channel name, or (for a nameless DM/
  // group call) the participant names, or a generic "in call" label.
  function callTitle() {
    if (!voice || !voice.channel) return '';
    if (voice.channel.name) return voice.channel.name;
    const names = (voice.members || []).map(m => m.name).filter(Boolean);
    return names.length ? names.slice(0, 3).join(', ') : t('discord_w_call', 'In call');
  }

  // The Channels tab: the joinable voice channels grouped by server, using the full
  // widget height. The current call's members/speaking live in the Controls tab.
  function paintChannels(mount) {
    const list = mount.querySelector('.dc-chan-list');
    if (!list) return;
    const linked = connected === true;
    if (!linked) { list.replaceChildren(el('div', 'dc-chan-empty', t('twitch_notlinked', 'Not linked'))); return; }
    if (!channels || !channels.length) {
      list.replaceChildren(el('div', 'dc-chan-empty', t('discord_w_no_channels', 'No voice channels')));
      return;
    }
    const activeId = voice && voice.channel ? voice.channel.id : '';
    const frag = document.createDocumentFragment();
    groupByGuild(channels).forEach((chs, guild) => {
      if (guild) frag.appendChild(el('div', 'dc-guild', guild));
      chs.forEach(c => {
        const isActive = c.id === activeId;
        // Members: the live voice state (with speaking) for the channel you're in,
        // the polled roster for every other channel. Either may be absent.
        const members = (isActive && voice && Array.isArray(voice.members))
          ? voice.members
          : (roster ? (roster.get(c.id) || []) : []);
        const b = el('button', 'dc-chan');
        b.classList.toggle('is-active', isActive);
        const ico = el('span', 'dc-chan-ico'); ico.innerHTML = ICONS.join;   // static, trusted SVG
        b.append(ico, el('span', 'dc-chan-name', c.name || ''));
        if (members.length) b.appendChild(el('span', 'dc-chan-count', String(members.length)));
        b.addEventListener('click', () => runAction(b, { type: 'discordJoin', channel: c.id }));
        frag.appendChild(b);
        // Who's inside — a compact member strip under the channel row.
        if (members.length) {
          const strip = el('div', 'dc-chan-members');
          members.forEach(m => strip.appendChild(memberChip(m)));
          frag.appendChild(strip);
        }
      });
    });
    list.replaceChildren(frag);
  }

  function paint() {
    const linked = connected === true;
    const live = !!(voice && voice.ok);
    const inChan = live && voice.channel;
    tiles().forEach(tile => {
      const mount = tile.querySelector('.discord-widget-mount');
      if (!mount) return;
      ensure(mount);
      applyLabels(mount);   // keep static labels in the current UI language
      mount.querySelector('.dc-wrap').classList.toggle('dc-off', !linked);
      mount.querySelector('.dc-user').textContent = linked ? (username || '') : '';

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
      if (launch) launch.hidden = !(linked && voice && voice.ok === false);

      // Tabs: reflect the active tab (controls / channels) across this widget's tiles.
      mount.querySelectorAll('.dc-tab').forEach(tb => tb.classList.toggle('is-active', tb.dataset.dtab === activeTab));
      mount.querySelectorAll('.dc-panel').forEach(p => { p.hidden = p.dataset.dtab !== activeTab; });

      // Mute
      const mute = mount.querySelector('.dc-mute');
      const muted = !!(live && voice.mute);
      mute.classList.toggle('is-on', muted);
      mute.querySelector('.dc-btn-ico').innerHTML = muted ? ICONS.micOff : ICONS.micOn;
      mute.querySelector('.dc-btn-lbl').textContent = muted ? t('twitch_mic_unmute', 'Unmute') : t('twitch_mic_mute', 'Mute');
      // Deafen
      const deaf = mount.querySelector('.dc-deaf');
      const deafened = !!(live && voice.deaf);
      deaf.classList.toggle('is-on', deafened);
      deaf.querySelector('.dc-btn-ico').innerHTML = deafened ? ICONS.deafOff : ICONS.deafOn;
      deaf.querySelector('.dc-btn-lbl').textContent = deafened ? t('discord_w_undeafen', 'Undeafen') : t('discord_w_deafen', 'Deafen');
      // Push-to-talk / voice activity (label shows the CURRENT mode)
      const ptt = mount.querySelector('.dc-ptt');
      const isPtt = !!(live && voice.mode === 'PUSH_TO_TALK');
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
      if (inVal) inVal.textContent = (live && voice.inputVolume != null) ? String(voice.inputVolume) : '—';
      const outVal = mount.querySelector('.dc-vol-out .dc-vol-val');
      if (outVal) outVal.textContent = (live && voice.outputVolume != null) ? String(voice.outputVolume) : '—';

      // Audio chips
      mount.querySelectorAll('.dc-chip').forEach(chip => {
        const on = !!(live && voice.features && voice.features[chip.dataset.feature]);
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
        }
      }

      paintChannels(mount);
    });
    syncRosterPolling();   // start/stop the Channels-tab roster poll to match the current view
  }

  // Voice-channel list — fetched once when linked (deduped across the multi-pass
  // layout init), then cached. Degrades to [] when Discord is offline.
  function loadChannels() {
    if (channelsInflight) return channelsInflight;
    channelsInflight = api('/stream/discord/channels').then(d => {
      channels = (d && d.ok && Array.isArray(d.channels)) ? d.channels : [];
    }).catch(() => { channels = []; }).finally(() => { channelsInflight = null; });
    return channelsInflight;
  }

  async function pullVoice() {
    const v = await api('/stream/discord/voice');
    voice = (v && typeof v === 'object') ? v : null;
  }

  // Fetch the per-channel roster (who's in each voice channel) into a Map. Keeps the
  // previous roster on a transient failure so the strip doesn't flicker empty.
  function loadRoster() {
    if (rosterInflight) return rosterInflight;
    rosterInflight = api('/stream/discord/roster').then(d => {
      if (d && d.ok && Array.isArray(d.channels)) {
        const map = new Map();
        d.channels.forEach(c => { if (c && c.id) map.set(String(c.id), Array.isArray(c.members) ? c.members : []); });
        roster = map;
      }
    }).catch(() => { /* keep last roster on a transient blip */ })
      .finally(() => { rosterInflight = null; });
    return rosterInflight;
  }

  // Poll the roster ONLY while the Channels tab is open, Discord is linked, the page
  // is visible and a tile is placed — so the per-channel GET_CHANNEL reads never run
  // when nobody's looking (keeps the integration lightweight).
  function rosterWanted() {
    return activeTab === 'channels' && connected === true && !document.hidden && tiles().length > 0;
  }

  function syncRosterPolling() {
    if (rosterWanted()) {
      if (rosterTimer) return;                          // already polling
      rosterTimer = setInterval(() => { loadRoster().then(paint); }, ROSTER_MS);
      loadRoster().then(paint);                         // instant first fill on open
    } else if (rosterTimer) {
      clearInterval(rosterTimer); rosterTimer = null;
      roster = null;                                    // drop stale membership; reopening refetches
    }
  }

  // One-shot seed on mount: status + voice + channels for an instant first paint.
  // After this, live changes arrive via onSSE() — the widget never polls.
  async function seed() {
    if (!tiles().length) return;
    const s = await api('/stream/discord/status');
    if (s) { connected = !!s.connected; username = s.login || ''; }
    if (connected) {
      await pullVoice();
      // Load the channel list once Discord is actually reachable (voice.ok). If it
      // drops (app closed), forget the cached list so it reloads when it returns.
      if (voice && voice.ok) { if (channels === null) await loadChannels(); }
      else channels = null;
    } else {
      voice = null; channels = null;
    }
    paint();
  }

  // Live push from the server's voice-event watch: fresh {connected, login, voice}.
  // Zero work happens here until Discord actually changes something.
  function onSSE(data) {
    if (!data || typeof data !== 'object') return;
    connected = !!data.connected;
    username = data.login || '';
    voice = (data.voice && typeof data.voice === 'object') ? data.voice : null;
    if (connected && voice && voice.ok) { if (channels === null) { loadChannels().then(paint); } }
    else if (!connected) { channels = null; }
    paint();
  }

  function renderWidgets() {
    // No tiles placed → park state so a later re-add re-seeds from scratch, and stop
    // the roster poll (syncRosterPolling sees no tiles → clears its timer).
    if (!tiles().length) { seeded = false; syncRosterPolling(); return; }
    paint();                                       // instant paint from cache
    if (!seeded) { seeded = true; seed(); }        // deduped across the multi-pass layout init
  }

  // Re-evaluate the roster poll when the page is hidden/shown (stop while hidden).
  document.addEventListener('visibilitychange', syncRosterPolling);

  window.DiscordWidget = { renderWidgets, onSSE };
})();
