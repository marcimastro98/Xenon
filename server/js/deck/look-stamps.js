// What a deck's look writes on its tile for the stylesheet to read: the look a profile ends up
// with, the cues of lit and dimmed keys, how see-through the deck is, and the mount of a deck that
// sits in a tab group.
'use strict';

(() => {
  function deckLookFor(cfg, profileId) {
    const M = window.DeckModel;
    if (M && typeof M.effectiveDeckLook === 'function') return M.effectiveDeckLook(cfg, profileId);
    return { capStyle: cfg.capStyle, keyShape: cfg.keyShape, plate: cfg.plate, transparency: cfg.transparency, wellImage: cfg.wellImage, mediaStyle: cfg.mediaStyle };
  }

  // The single place that turns the stored 0-100 transparency into the custom
  // properties DeckPanel.css fades on, so the style preview and the real deck can
  // never disagree about what a value means. Both surfaces are painted on their
  // own layer precisely so this can stay one number: an `opacity` on .deck-device
  // would take the keys with it.
  // Deck-wide on/off cues (Aspetto Deck): a lit ring on every key that is on,
  // and every state-following key dimmed while off. CSS keys off these.
  function stampDeckLitCues(root, look) {
    if (look && look.litRing) root.dataset.litring = '1'; else delete root.dataset.litring;
    if (look && look.dimOff) root.dataset.dimoff = '1'; else delete root.dataset.dimoff;
    if (look && look.themeColors) root.dataset.themecolors = '1'; else delete root.dataset.themecolors;
  }

  function stampDeckAlpha(root, look) {
    const t = Math.max(0, Math.min(100, Number(look && look.transparency) || 0));
    const alpha = String((100 - t) / 100);
    root.style.setProperty('--deck-plate-alpha', alpha);
    root.style.setProperty('--deck-well-alpha', alpha);
    // The mount a tab-group tile paints IS the chassis, so it follows the chassis
    // rather than only the slider: the "Nessuna" faceplate removes the body
    // outright, and leaving the mount behind reproduced exactly the box that
    // finish exists to get rid of.
    root.style.setProperty('--deck-mount-alpha', (look && look.plate === 'none') ? '0' : alpha);
  }

  // A Deck inside a tab-group repaints the HOSTING tile as its chassis mount
  // (.panel.tabgroup.deck-tab-active), so that tile has to fade with the device or
  // the slider looks broken: the chassis goes and the mount takes its place. The
  // tile is an ANCESTOR of the .deck-root carrying the value, and a custom property
  // only inherits downward, so it is stamped directly. dashboard-tabgroups.js does
  // the same when it rebuilds the bar, which covers the case this call cannot see:
  // a group tile built fresh around a member that was MOVED into it rather than
  // re-rendered.
  function stampDeckMount(tile) {
    if (!tile || !tile.querySelector) return;
    const root = tile.querySelector('.deck-root');
    // A Deck with no faceplate draws no body, so the dashboard tile around it must
    // not draw its drop shadow either: under bare keys it is a dark strip along an
    // empty edge (DeckPanel.css, [data-deck-bare]). Set on the Deck's own tile, or
    // on the group tile that mounts it, whichever is the direct child of the grid
    // item, so the stylesheet needs no deep :has() walk.
    const bare = !!(root && root.dataset.plate === 'none');
    tile.toggleAttribute('data-deck-bare', bare);
    const mount = tile.closest ? tile.closest('.panel.tabgroup') : null;
    if (!mount) return;
    mount.style.setProperty('--deck-mount-alpha', (root && root.style.getPropertyValue('--deck-mount-alpha')) || '1');
    mount.toggleAttribute('data-deck-bare', bare);
    mount.toggleAttribute('data-deck-themeplate', !!(root && root.dataset.plate === 'theme'));
  }

  window.DeckLookStamps = { deckLookFor, stampDeckLitCues, stampDeckAlpha, stampDeckMount };
})();
