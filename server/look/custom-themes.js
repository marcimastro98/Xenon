// Checks the themes a user imported before they are saved with the settings: at most 24, and
// when they are too big together their pictures go, not the themes.

const { sanitizeBgFps } = require('../js/custom-bg.js');
const contentInstalls = require('../js/content-installs.js');

// Client-owned imported themes: bounded round-trip (the client is authoritative
// and re-validates every field on load). A theme may embed a small font ref but
// not the font bytes, so the cap can stay tight.
function sanitizeCustomThemes(value) {
  if (!Array.isArray(value)) return [];
  try {
    const json = JSON.stringify(value);
    // A theme can carry a code-defined animated background (bgCustom.code, up to
    // 20 KB client-side) and, since assets landed, its bundled images (up to
    // ~900 KB per card). Size the cap for the 24-card ceiling with a few
    // asset-heavy cards; past it, DEGRADE by stripping the images (keeping every
    // theme + its code) instead of dropping the whole gallery on the round-trip.
    const CAP = 4000000;
    const cards = JSON.parse(json).slice(0, 24);
    if (json.length <= CAP) return cards;
    const slim = cards.map((card) => {
      if (card && typeof card === 'object' && card.bgCustom && typeof card.bgCustom === 'object') {
        // bgCustom rebuilt with known keys only (assets dropped); the rest of
        // the card stays the client-owned passthrough it always was.
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
      return card;
    });
    // Re-check against the SAME cap — codes alone can't legitimately exceed it.
    return JSON.stringify(slim).length > CAP ? [] : slim;
  } catch { return []; }
}


module.exports = { sanitizeCustomThemes };
