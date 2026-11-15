// The Soundboard tab of a Discord tile: one tile per sound, with the button that plays it in the
// call and the one that lets you hear it first.
'use strict';

window.DiscordWidgetSoundTiles = (wrapper) => {
  const { el, discordState, runAction, previewSound } = wrapper;

  const { t } = window.DiscordWidgetTabs;
  const { ICONS } = window.DiscordWidgetIcons;

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

  return { paintSoundboard };
};
