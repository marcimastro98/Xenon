// Checks the themes a user imported before they are saved with the settings: at most 24, and
// when they are too big together their pictures go, not the themes.

const { sanitizeBgFps } = require('../js/custom-bg.js');
const contentInstalls = require('../js/store-catalog/content-installs.js');

// The card with its background rebuilt from known keys and no pictures; the rest of the card
// stays the client-owned passthrough it always was.
function withoutPictures(card) {
  const cb = card.bgCustom;
  return {
    ...card,
    bgCustom: {
      enabled: !!cb.enabled,
      name: typeof cb.name === 'string' ? cb.name : '',
      code: typeof cb.code === 'string' ? cb.code : '',
      assets: {},
      fps: sanitizeBgFps(cb.fps),
      ...(cb.imported === true ? { imported: true } : {}),
      ...(contentInstalls.INSTALL_ID_RE.test(String(cb.installId || '')) ? { installId: String(cb.installId) } : {}),
    },
  };
}

const hasPictures = (card) => !!(card && typeof card === 'object' && card.bgCustom && typeof card.bgCustom === 'object'
  && card.bgCustom.assets && typeof card.bgCustom.assets === 'object' && Object.keys(card.bgCustom.assets).length);

// Client-owned imported themes: bounded round-trip (the client is authoritative
// and re-validates every field on load). A theme may embed a small font ref but
// not the font bytes, so the cap can stay tight.
function sanitizeCustomThemes(value) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value);
    // A theme can carry a code-defined animated background and its pictures (up to ~1.4 MB a
    // card). Past the cap the heaviest cards lose their pictures first, one at a time, so a
    // gallery with one big photo theme too many keeps every other card's background whole.
    const CAP = 4000000;
    const all = JSON.parse(json);
    const cards = all.slice(0, 24);
    // Counted again only when cards were cut off: a big gallery is turned to text once, not twice.
    let size = all.length === cards.length ? json.length : JSON.stringify(cards).length;
    if (size <= CAP) return cards;
    const weights = cards.map((card, i) => ({ i, bytes: hasPictures(card) ? JSON.stringify(card.bgCustom.assets).length : 0 }))
      .filter((w) => w.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    for (const { i, bytes } of weights) {
      if (size <= CAP) break;
      cards[i] = withoutPictures(cards[i]);
      size -= bytes - 2;   // the assets became {}
    }
    // Re-check against the SAME cap: codes alone can't legitimately exceed it.
    return JSON.stringify(cards).length > CAP ? [] : cards;
  } catch { return []; }
}


module.exports = { sanitizeCustomThemes };
