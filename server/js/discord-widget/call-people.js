// The people of the call in a Discord tile: one chip per person with their picture, the row that
// turns one of them up or down for you, and the title of the call.
'use strict';

window.DiscordWidgetCallPeople = (wrapper) => {
  const { el, discordState, runAction, paint, avatarBad, NOTIF_ICON_BAD_MAX } = wrapper;

  const { t } = window.DiscordWidgetTabs;
  const { applyMemberState, syncMemberStates } = window.DiscordWidgetMemberState;
  const { ICONS } = window.DiscordWidgetIcons;

  // ── Turning one person up or down ─────────────────────────────────────────
  function callMembers() {
    return (discordState.voice && Array.isArray(discordState.voice.members)) ? discordState.voice.members : [];
  }
  // Your own row is not one of these: Discord has no per-user setting for your
  // own account (your levels are the mic/output rows above), and the server
  // answers `self_not_supported` — so the row simply isn't a button.
  function canAdjust(m) {
    return !!(m && m.id && discordState.voice && discordState.voice.channel && m.id !== (discordState.voice.selfId || ''));
  }

  // A member chip: their Discord avatar and name, with Discord's own cues: a
  // green ring on the avatar while they speak, a struck-through microphone or
  // headphones after the name when they muted or deafened themselves. Names are dynamic Discord data, so textContent (via el),
  // never innerHTML; the avatar address is built server-side from checked values
  // (server/discord/rpc-shapes.js avatarUrl). Reused by the current-call strip and the
  // per-channel roster.
  //
  // The chip is built once and its live state is applied separately
  // (applyMemberState): voice pushes arrive several times a second while people
  // talk, and rebuilding the chips on each one re-created every <img>, which is
  // what made the avatars in the notification feed blink before.
  function memberChip(m, adjustable) {
    const chip = el(adjustable ? 'button' : 'span', 'dc-member');
    chip.dataset.member = m.id || '';
    if (adjustable) {
      chip.type = 'button';
      chip.classList.add('is-adjustable');
      chip.classList.toggle('is-open', discordState.openMember === m.id);
      chip.addEventListener('click', () => {
        discordState.openMember = (discordState.openMember === m.id) ? '' : m.id;
        paint();
      });
    }
    // The state glyph follows the name, where Discord's own voice list puts it,
    // at a size that reads: on the 20px avatar it was a badge nobody could make
    // out. It holds both glyphs and CSS shows the one that applies, so muting
    // changes a class instead of the markup.
    const state = el('span', 'dc-member-state');
    state.setAttribute('aria-hidden', 'true');
    state.innerHTML = '<span class="dc-state-mic">' + ICONS.micOff + '</span><span class="dc-state-deaf">' + ICONS.deafOff + '</span>';   // static, trusted SVG
    chip.append(memberAvatar(m), el('span', 'dc-member-name', m.name || '—'), state);
    applyMemberState(chip, m);
    return chip;
  }

  // The round avatar: the picture over the person's initial, so a picture that
  // cannot load (offline, a blocked CDN) still leaves a tidy circle, never a
  // broken-image icon.
  function memberAvatar(m) {
    const av = el('span', 'dc-av');
    // Decoration for sighted users: the name beside it says who it is, and a
    // screen reader reading the initial too would say "G Giulia".
    av.setAttribute('aria-hidden', 'true');
    const first = Array.from(String(m.name || '').trim())[0] || '?';
    av.appendChild(el('span', 'dc-av-initial', first.toLocaleUpperCase()));
    if (m.avatar && !avatarBad.has(m.avatar)) {
      const img = document.createElement('img');
      img.className = 'dc-av-img';
      img.alt = '';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = m.avatar;
      img.addEventListener('error', () => {
        if (avatarBad.size >= NOTIF_ICON_BAD_MAX) avatarBad.clear();
        avatarBad.add(m.avatar);
        img.remove();
      }, { once: true });
      av.appendChild(img);
    }
    return av;
  }

  // What a chip is built from. A change here rebuilds the chips; anything else
  // is applied to the chips that are already there.
  function memberShape(m, adjustable) {
    return (m.id || '') + '\u0001' + (m.name || '') + '\u0001' + (m.avatar || '') + '\u0001'
      + (adjustable ? (discordState.openMember === m.id ? 'o' : 'a') : '');
  }

  // Fill a container with member chips for the current call.
  function fillMembers(box) {
    const members = callMembers();
    const shape = members.map(m => memberShape(m, canAdjust(m))).join('\u0002') + '#' + (document.documentElement.lang || '');
    if (box.dataset.dcShape !== shape) {
      box.dataset.dcShape = shape;
      const frag = document.createDocumentFragment();
      members.forEach(m => frag.appendChild(memberChip(m, canAdjust(m))));
      box.replaceChildren(frag);
      return;
    }
    syncMemberStates(box, members);
  }

  // One row, no prose: a speaker you can tap to mute them just for you, a slider,
  // and the number. The name is not repeated — you tapped it a moment ago and it
  // is lit up directly above. Every label survives as a tooltip, so the row is
  // still readable to a screen reader and still translated.
  const USER_VOL_MAX = 200;   // Discord's own ceiling for a per-person level
  const VOL_STEP = 5;

  function buildMemberCtl(m) {
    const row = el('div', 'dc-mctl-row');

    const mute = el('button', 'dc-mctl-mute');
    mute.type = 'button';
    mute.addEventListener('click', () => runAction(mute, { type: 'discordUserMute', user: discordState.openMember, mode: 'toggle' }));

    const range = el('input', 'dc-mctl-range');
    range.type = 'range'; range.min = '0'; range.max = String(USER_VOL_MAX); range.step = String(VOL_STEP);
    const val = el('span', 'dc-mctl-val');

    // Dragging must not talk to Discord on every pixel: the number follows the
    // thumb locally, and the level is written once, when the finger lifts. The
    // flag also stops the SSE repaint from yanking the thumb out from under it.
    range.addEventListener('pointerdown', () => { discordState.dragging = true; });
    range.addEventListener('input', () => { val.textContent = range.value; paintFill(range); row.classList.remove('is-unknown'); });
    const commit = () => {
      if (!discordState.dragging) return;
      discordState.dragging = false;
      runAction(range, { type: 'discordUserVol', user: discordState.openMember, mode: 'set', value: range.value });
    };
    range.addEventListener('change', commit);
    range.addEventListener('pointercancel', () => { discordState.dragging = false; });
    // Keyboard: arrows fire `change` per press on some engines and not others,
    // so commit on release as well rather than leaving the level unwritten.
    range.addEventListener('keyup', () => { if (!discordState.dragging) runAction(range, { type: 'discordUserVol', user: discordState.openMember, mode: 'set', value: range.value }); });

    row.append(mute, range, val);
    return row;
  }

  // The Liquid fader has no handle: it paints the level from --fill, a share of its range.
  function paintFill(range) {
    const share = (Number(range.value) / (Number(range.max) || 100)) * 100;
    range.style.setProperty('--fill', `${Math.max(0, Math.min(100, share))}%`);
  }

  // Values only — called on every paint, including the SSE pushes, so the row
  // follows Discord without being rebuilt under the user's finger.
  function refreshMemberCtl(row, m) {
    const mute = row.querySelector('.dc-mctl-mute');
    const range = row.querySelector('.dc-mctl-range');
    const val = row.querySelector('.dc-mctl-val');
    const label = t(m.localMute ? 'dc_member_unmute' : 'dc_member_mute', m.localMute ? 'Unmute for me' : 'Mute for me');
    mute.classList.toggle('on', !!m.localMute);
    mute.innerHTML = m.localMute ? ICONS.spkOff : ICONS.join;   // static, trusted SVG
    mute.title = label;
    mute.setAttribute('aria-label', label);
    range.title = t('dc_member_vol', 'Volume for you');
    range.setAttribute('aria-label', (m.name || '') + ' — ' + range.title);
    if (discordState.dragging) return;   // their finger is on it; Discord's copy can wait
    // A volume Discord does not report is not 100. The thumb has to sit
    // somewhere, so it rests at the default and the row says the value is not
    // known — a number would be a guess at a setting the machine may not be in.
    const known = m.volume != null;
    row.classList.toggle('is-unknown', !known);
    range.value = String(known ? m.volume : 100);
    paintFill(range);
    val.textContent = known ? String(m.volume) : '—';
  }

  // The controls for the person whose name is open, or nothing.
  function fillMemberCtl(box) {
    const m = discordState.openMember ? callMembers().find(x => x.id === discordState.openMember) : null;
    // They left, or you did: close rather than leave controls pointing at nobody.
    if (!m || !canAdjust(m)) { discordState.openMember = ''; discordState.dragging = false; box.replaceChildren(); box.hidden = true; box.dataset.dcFor = ''; return; }
    box.hidden = false;
    if (box.dataset.dcFor !== m.id || !box.firstChild) {
      discordState.dragging = false;
      box.replaceChildren(buildMemberCtl(m));
      box.dataset.dcFor = m.id;
    }
    refreshMemberCtl(box.firstChild, m);
  }

  // Title for the channel/call you're in: the channel name, or (for a nameless DM/
  // group call) the participant names, or a generic "in call" label.
  function callTitle() {
    if (!discordState.voice || !discordState.voice.channel) return '';
    if (discordState.voice.channel.name) return discordState.voice.channel.name;
    const names = (discordState.voice.members || []).map(m => m.name).filter(Boolean);
    return names.length ? names.slice(0, 3).join(', ') : t('discord_w_call', 'In call');
  }

  return { memberChip, memberShape, fillMembers, fillMemberCtl, callTitle };
};
