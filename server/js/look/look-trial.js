'use strict';
// "Try it on my screen", the new look's sheet of What's New: the person's own dashboard in
// Liquid Glass for as long as they like, and a card to keep it or go back. An update keeps the
// look it found, so this only ever runs on their tap, and the look they had is saved first as a
// card of the gallery, where it stays whatever they decide.
(function () {
  const LOOK = 'liquid';
  const WALLPAPER = 'assets/wallpapers/dusk.webp';
  // What the server keeps of the gallery (sanitizeCustomThemes). One card past the count would be
  // gone after a restart, one past the size would cost every card its pictures.
  const MAX_CARDS = 24;
  const MAX_BYTES = 4000000;

  let running = false;

  const alreadySaved = () => getCustomThemes().some(themeMatchesLive);

  function galleryHasRoom() {
    const cards = getCustomThemes();
    return cards.length < MAX_CARDS
      && JSON.stringify([...cards, snapshotCurrentTheme()]).length <= MAX_BYTES;
  }

  function offered() {
    if (window.__xenonRemote || typeof applyThemeById !== 'function') return false;
    return hubSettings.styleMode !== LOOK && (alreadySaved() || galleryHasRoom());
  }

  // The id of a card that holds the look on screen now. addThemeCard answers null when one exists.
  function saveCurrentLook(name) {
    const card = addThemeCard(snapshotCurrentTheme(), name);
    return card ? card.id : getCustomThemes().find(themeMatchesLive).id;
  }

  // The melt photographs the new look as soon as it is applied: no half-painted wallpaper in it.
  function wallpaperReady() {
    const picture = new Image();
    picture.src = WALLPAPER;
    return picture.decode().catch(() => { /* the look still applies, on its base colour */ });
  }

  function key(className, text, onClick) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = className;
    node.textContent = text;
    node.addEventListener('click', onClick);
    return node;
  }

  // Not a dialog: the point is to use the dashboard while it stays on screen.
  function showCard({ tr, mountBit, decide }) {
    const card = document.createElement('div');
    card.className = 'wn-look';
    card.setAttribute('role', 'group');
    card.setAttribute('aria-label', tr('wn_look_line'));
    const face = document.createElement('div');
    face.className = 'wn-look-bit';
    const line = document.createElement('p');
    line.className = 'wn-look-line';
    line.textContent = tr('wn_look_line');
    const keys = document.createElement('div');
    keys.className = 'wn-look-keys';
    const keep = key('wn-look-keep', tr('wn_look_keep'), () => decide(true));
    keys.append(key('wn-look-back', tr('wn_look_back'), () => decide(false)), keep);
    card.append(face, line, keys);
    document.body.append(card);
    const bit = mountBit(face);
    if (bit) bit.play('hello');
    keep.focus();
    return () => {
      card.remove();
      if (bit) bit.destroy();
    };
  }

  // stepOut() takes the sheets away; comeBack(kept) brings them back on the next one.
  async function run({ tr, mountBit, stepOut, comeBack }) {
    if (running) return;
    running = true;
    await wallpaperReady();
    const before = saveCurrentLook(tr('wn_look_saved'));
    await window.XenonMelt(() => {
      applyThemeById(LOOK);
      stepOut();
    });
    let decided = false;
    const removeCard = showCard({
      tr,
      mountBit,
      decide: async (kept) => {
        if (decided) return;
        decided = true;
        await window.XenonMelt(() => {
          removeCard();
          if (!kept) applyThemeById(before);
          comeBack(kept);
        });
        running = false;
      },
    });
  }

  window.LookTrial = Object.freeze({ offered, run });
})();
