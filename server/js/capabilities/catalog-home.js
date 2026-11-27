'use strict';
// The home cameras (server/smart-home/): a Deck key that puts one camera over every open
// dashboard, live for two minutes. Bit has its own camera tool (home_camera, camera-look.js),
// so there is no AI entry here. Same shape as capability-catalog.js, which appends them; the
// page loads this file just before it.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CapabilityCatalogHome = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  const CAPABILITIES = [
    {
      type: 'homeCamera', group: 'xenon', labelKey: 'deck_act_homeCamera',
      // A camera's name as Settings shows it, or part of it; empty = where someone last rang, else the first.
      params: [{ name: 'camera', kind: 'text', maxLen: 80, optional: true, labelKey: 'deck_param_home_camera' }],
      capability: { domain: 'layers', risk: 'safe', requires: 'homeCameras' },
    },
  ];

  return { CAPABILITIES };
});
