// The Channels tab of a Discord tile: the voice channels grouped by server, the pinned ones on top,
// and who is in each.
'use strict';

window.DiscordWidgetChannelList = (wrapper) => {
  const {
    el, discordState, runAction, toggleFav, toggleGuild, toggleAllGuilds, memberChip, memberShape,
  } = wrapper;

  const {
    splitFavourites, favIds, isFav, groupByGuild, collapsedIds, isCollapsed,
  } = window.DiscordWidgetLists;
  const { t } = window.DiscordWidgetTabs;
  const { syncMemberStates } = window.DiscordWidgetMemberState;
  const { ICONS } = window.DiscordWidgetIcons;

  // The Channels tab: the joinable voice channels grouped by server, using the full
  // widget height. The current call's members/speaking live in the Controls tab.
  // "Only starred" (asked on Discord): a small tile shows just the channels you use.
  const favOnly = () => typeof hubSettings === 'object' && hubSettings?.discordFavOnly === true;
  // The tapped tile repaints at once; any other Discord tile on its next paint.
  function toggleFavOnly(mount) {
    if (typeof saveTileSetting !== 'function') return;
    saveTileSetting({ discordFavOnly: !favOnly() }).then((ok) => { if (!ok) paintChannels(mount); });
    paintChannels(mount);
  }
  // Starred servers: every channel of one counts as a favourite. The server moves up under the
  // starred channels and stays under "Only starred", kept as a server with its heading so its
  // star (the way to unstar it) and its fold stay reachable.
  const favGuildIds = () => {
    const v = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.discordFavGuilds : null;
    return Array.isArray(v) ? v : [];
  };
  const isFavGuild = (guildId) => !!guildId && favGuildIds().includes(String(guildId));
  // The server groups split into the starred ones, in the order they were starred (like the
  // channels), and the others in the list's own order.
  const splitStarredGuilds = (groups, ids) => {
    const starred = ids.map(String).map((id) => groups.find((g) => g.id && String(g.id) === id)).filter(Boolean);
    return { starred, others: groups.filter((g) => !starred.includes(g)) };
  };
  // A new starred server goes to the bottom of the starred ones, as a channel does.
  function toggleFavGuild(guildId, mount) {
    const key = String(guildId || '');
    if (!key || typeof saveTileSetting !== 'function') return;
    const cur = favGuildIds();
    const next = cur.includes(key) ? cur.filter((x) => x !== key) : cur.concat([key]);
    saveTileSetting({ discordFavGuilds: next }).then((ok) => { if (!ok) paintChannels(mount); });
    paintChannels(mount);
  }
  const barButton = (label, onClick, cls) => {
    const b = el('button', 'dc-guild-all-btn' + (cls ? ' ' + cls : ''));
    b.type = 'button';
    b.title = label;
    b.addEventListener('click', onClick);
    return b;
  };

  function paintChannels(mount) {
    const list = mount.querySelector('.dc-chan-list');
    if (!list) return;
    const linked = discordState.connected === true;
    const activeId = discordState.voice && discordState.voice.channel ? discordState.voice.channel.id : '';
    const membersFor = (c) => (c.id === activeId && discordState.voice && Array.isArray(discordState.voice.members))
      ? discordState.voice.members : (discordState.roster ? (discordState.roster.get(c.id) || []) : []);
    // Skip the full rebuild (channel rows + member strips) when nothing observable
    // changed — paintChannels runs on every 6s roster tick and is usually identical.
    const sig = !linked ? 'x' : (!discordState.channels || !discordState.channels.length) ? 'e'
      : discordState.channels.map(c => c.id + ':' + (c.name || '') + ':' + (c.id === activeId ? 1 : 0) + ':'
          // Who is in each channel, not what they are doing: speaking and
          // muting are applied to the chips in place below, so a voice push
          // several times a second does not rebuild (and re-load) every avatar.
          + membersFor(c).map(m => memberShape(m, false)).join(',')
        ).join('|')
      // The pinned list is part of what is drawn, so it belongs in the signature:
      // without it, starring a channel would change nothing until the next tick
      // that happened to move a member.
      + '#' + favIds().join(',')
      // Collapsing a server changes what is drawn and nothing else, so without
      // it in the signature the tap would repaint nothing until a member moved.
      + '#' + collapsedIds().join(',')
      + '#' + favGuildIds().join(',')
      + '#' + favOnly();
    if (list.dataset.dcSig === sig) {
      if (linked && discordState.channels && discordState.channels.length) {
        syncMemberStates(list, discordState.channels.flatMap(c => membersFor(c)));
      }
      return;
    }
    list.dataset.dcSig = sig;
    if (!linked) { list.replaceChildren(el('div', 'dc-chan-empty', t('twitch_notlinked', 'Not linked'))); return; }
    if (!discordState.channels || !discordState.channels.length) {
      list.replaceChildren(el('div', 'dc-chan-empty', t('discord_w_no_channels', 'No voice channels')));
      return;
    }
    const frag = document.createDocumentFragment();

    // One channel row: the join button and the star are SIBLINGS inside a
    // wrapper, never nested. A button inside a button is invalid and only one of
    // the two would be reachable — the same reason soundTile() below is built
    // this way.
    const channelRow = (c) => {
      const isActive = c.id === activeId;
      // Members: the live voice state (with speaking) for the channel you're in,
      // the polled roster for every other channel. Either may be absent.
      const members = (isActive && discordState.voice && Array.isArray(discordState.voice.members))
        ? discordState.voice.members
        : (discordState.roster ? (discordState.roster.get(c.id) || []) : []);
      const row = el('div', 'dc-chan-row');
      const b = el('button', 'dc-chan');
      b.type = 'button';
      b.classList.toggle('is-active', isActive);
      const ico = el('span', 'dc-chan-ico'); ico.innerHTML = ICONS.join;   // static, trusted SVG
      b.append(ico, el('span', 'dc-chan-name', c.name || ''));
      if (members.length) b.appendChild(el('span', 'dc-chan-count', String(members.length)));
      b.addEventListener('click', () => runAction(b, { type: 'discordJoin', channel: c.id }));
      const pinned = isFav(c.id);
      const star = el('button', 'dc-chan-fav');
      star.type = 'button';
      star.classList.toggle('is-on', pinned);
      star.innerHTML = ICONS.star;                                          // static, trusted SVG
      const label = pinned
        ? t('discord_w_unfavourite', 'Remove from favourites')
        : t('discord_w_favourite', 'Pin to the top');
      star.title = label;
      star.setAttribute('aria-label', label);
      star.setAttribute('aria-pressed', String(pinned));
      star.addEventListener('click', (ev) => { ev.stopPropagation(); toggleFav(c.id); });
      row.append(b, star);
      frag.appendChild(row);
      // Who's inside — a compact member strip under the channel row.
      if (members.length) {
        const strip = el('div', 'dc-chan-members');
        members.forEach(m => strip.appendChild(memberChip(m)));
        frag.appendChild(strip);
      }
    };

    // A server heading that opens and closes its channels. The caret, the name
    // and the count are spans inside ONE button rather than a button beside a
    // label: the whole bar is the target, which is what a finger on the Edge
    // needs, and there is nothing next to it to mis-hit.
    const guildHeader = (g) => {
      const collapsed = isCollapsed(g.id);
      const h = el('button', 'dc-guild');
      h.type = 'button';
      h.classList.toggle('is-collapsed', collapsed);
      const caret = el('span', 'dc-guild-caret');
      caret.innerHTML = ICONS.caret;                                        // static, trusted SVG
      h.append(caret, el('span', 'dc-guild-name', g.name || ''));
      // The count is what a closed server still tells you: how much is in there.
      h.appendChild(el('span', 'dc-guild-count', String(g.channels.length)));
      h.setAttribute('aria-expanded', String(!collapsed));
      const label = collapsed
        ? t('discord_w_expand_server', 'Show channels')
        : t('discord_w_collapse_server', 'Hide channels');
      h.title = label;
      h.setAttribute('aria-label', (g.name || '') + ' — ' + label);
      h.addEventListener('click', () => toggleGuild(g.id));
      // The server's star sits BESIDE the heading, never inside it (a button in a
      // button is invalid), so starring never folds the server and vice versa.
      const row = el('div', 'dc-guild-row');
      row.append(h, guildStar(g));
      return row;
    };

    const guildStar = (g) => {
      const starred = isFavGuild(g.id);
      const star = el('button', 'dc-chan-fav dc-guild-fav');
      star.type = 'button';
      star.classList.toggle('is-on', starred);
      star.innerHTML = ICONS.star;                                          // static, trusted SVG
      const label = starred
        ? t('discord_w_unstar_server', 'Remove server from favourites')
        : t('discord_w_star_server', 'Add server to favourites');
      star.title = label;
      star.setAttribute('aria-label', (g.name || '') + ' — ' + label);
      star.setAttribute('aria-pressed', String(starred));
      star.addEventListener('click', (ev) => { ev.stopPropagation(); toggleFavGuild(g.id, mount); });
      return star;
    };

    const { pinned, rest } = splitFavourites(discordState.channels, favIds());
    // Starred servers come first, right under the starred channels.
    const split = splitStarredGuilds(Array.from(groupByGuild(rest).values()), favGuildIds());
    // Favourites is not a server and never collapses: it is the shortcut PAST
    // the scrolling, so hiding it would work against the thing being asked for.
    if (pinned.length) {
      frag.appendChild(el('div', 'dc-guild dc-guild--fav', t('discord_w_favourites', 'Favourites')));
      pinned.forEach(channelRow);
    }
    // "Only starred" keeps the starred channels and the starred servers.
    const anyStarred = pinned.length > 0 || split.starred.length > 0;
    const onlyFav = favOnly() && anyStarred;
    const groups = onlyFav ? split.starred : split.starred.concat(split.others);
    const ids = groups.map(g => g.id).filter(Boolean);
    const bar = el('div', 'dc-guild-all');
    if (anyStarred) {
      const label = onlyFav ? t('discord_w_show_all', 'Show all') : t('discord_w_only_starred', 'Only starred');
      const b = barButton(label, () => toggleFavOnly(mount), 'dc-fav-only');
      b.setAttribute('aria-pressed', String(onlyFav));
      b.append(el('span', null, label));
      bar.appendChild(b);
    }
    // Collapse/expand everything shown. Only from two servers up: with one, it is
    // the header's own caret wearing a different hat.
    if (ids.length > 1) {
      const allShut = ids.every(isCollapsed);
      const b = barButton('', () => toggleAllGuilds(ids));
      b.classList.toggle('is-collapsed', allShut);
      const caret = el('span', 'dc-guild-caret');
      caret.innerHTML = ICONS.caret;                                        // static, trusted SVG
      const label = allShut
        ? t('discord_w_expand_all', 'Expand all')
        : t('discord_w_collapse_all', 'Collapse all');
      b.append(caret, el('span', null, label));
      b.title = label;
      bar.appendChild(b);
    }
    if (bar.childElementCount) frag.appendChild(bar);
    groups.forEach((g) => {
      // A group with no id cannot be remembered, so it is drawn the way it
      // always was: a plain heading, always open.
      if (!g.id) {
        if (g.name) frag.appendChild(el('div', 'dc-guild dc-guild--plain', g.name));
        g.channels.forEach(channelRow);
        return;
      }
      frag.appendChild(guildHeader(g));
      if (!isCollapsed(g.id)) g.channels.forEach(channelRow);
    });
    list.replaceChildren(frag);
  }

  return { paintChannels };
};
