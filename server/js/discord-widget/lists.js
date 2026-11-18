// How the Discord tile orders what it lists: the pinned voice channels taken out on top in the
// order they were starred, the rest grouped by server, which channels are pinned and which servers
// are folded as the settings remember them, and the time of a notification.
'use strict';

(() => {
  // Pinned channels come out as their own group at the TOP, above the per-server
  // ones, and are removed from the server group they came from. Shown in one
  // place only: a row repeated under both headings would duplicate its member
  // strip too, and "why is this channel twice?" is a worse question than "where
  // did it go?" — which the star on the row already answers.
  //
  // Pure, so the ordering can be checked without a browser or a Discord account.
  // Favourites keep the order the user starred them in, not Discord's: the point
  // is to put the one you always join first, and re-sorting them by name would
  // take that back.
  function splitFavourites(list, favIds) {
    const fav = Array.isArray(favIds) ? favIds : [];
    const byId = new Map((list || []).map((c) => [String(c && c.id), c]));
    const pinned = fav.map((id) => byId.get(String(id))).filter(Boolean);
    const pinnedIds = new Set(pinned.map((c) => String(c.id)));
    const rest = (list || []).filter((c) => !pinnedIds.has(String(c && c.id)));
    return { pinned, rest };
  }

  function favIds() {
    const v = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.discordFavChannels : null;
    return Array.isArray(v) ? v : [];
  }

  function isFav(id) { return favIds().includes(String(id)); }

  // Group the flat channel list by server, preserving first-seen order so the
  // list reads the same way every render. Keyed by guild id where there is one:
  // that is what the collapsed state is remembered by, and it also tells two
  // servers with the SAME NAME apart, which grouping by name silently merged.
  // Falls back to the name so a payload from an older engine still groups.
  //
  // Pure, so the grouping can be checked without a browser or a Discord account.
  function groupByGuild(list) {
    const groups = new Map();
    (list || []).forEach(c => {
      const id = String((c && c.guildId) || '');
      const name = (c && c.guild) || '';
      const key = id || ('name:' + name);
      if (!groups.has(key)) groups.set(key, { id, name, channels: [] });
      groups.get(key).channels.push(c);
    });
    return groups;
  }

  // Asked for on Discord: "It would be nice to be able to collapse the Discord
  // servers underneath the Discord Channels feature so your not forever
  // scrolling." Someone in a dozen servers scrolls past every one of them to
  // reach the two they actually join.
  //
  // Stored with the rest of the settings rather than in this module, so it holds
  // across a reload, a sign-out and the other surfaces — the same request asked
  // for it to be remembered "on future uses". A server with no id cannot be
  // remembered and so is never collapsible; today every server has one.
  function collapsedIds() {
    const v = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.discordCollapsedGuilds : null;
    return Array.isArray(v) ? v : [];
  }

  function isCollapsed(guildId) { return !!guildId && collapsedIds().includes(String(guildId)); }

  function fmtNotifTime(at) {
    if (!Number.isFinite(at)) return '';
    try { return new Date(at).toLocaleTimeString([], timeParts()); }
    catch { return ''; }
  }

  window.DiscordWidgetLists = {
    splitFavourites, favIds, isFav, groupByGuild, collapsedIds, isCollapsed, fmtNotifTime,
  };
})();
