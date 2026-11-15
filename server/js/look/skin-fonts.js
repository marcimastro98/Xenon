'use strict';

// The display faces of Retro, Comic and the pet come from Google. Linked in <head>, their
// stylesheet would hold the first paint until Google answers, or until the connection gives
// up on a network that blocks it. Added from here it holds nothing, and a look that uses
// them shows its fallback until they land. The font files are fetched only when a look
// uses them.
(() => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&family=Bangers&family=Comic+Neue:wght@400;700&display=swap';
  document.head.append(link);
})();
