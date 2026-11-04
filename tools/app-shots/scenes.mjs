// What each scene opens. `routes` mock the APIs it needs, `open` runs in the
// page and returns the selector to measure (or null for the whole page).
// `open` uses the dashboard's globals by their bare names: some are top-level
// `let`s (hubSettings), which are not properties of window.
/* global hubSettings, openSettings, XenonCredits, XenonCreditsSettings, CommunityGallery, SparksMail, BitMail,
   setLang, _aiDropWelcome, _aiAppendBubble, updateMediaChatKeyState */

const BALANCE_LOW = { ok: true, balance: 40, included: 40, monthly: 300, topup: 0, email: 'm***@gmail.com' };
const BALANCE_FULL = { ...BALANCE_LOW, balance: 260, included: 260 };

// A pass trial that ended yesterday, with three real Store entries used, so the
// end card loads their real pictures, plus Lyrics, which takes the website's.
const TRIAL_ENDED = {
  ok: true, state: 'ended', endsAt: Date.parse('2026-10-26T12:00:00Z'), endDone: true,
  tried: [
    { entryId: 'pit-wall', name: 'Pit Wall', kind: 'bundle', widgetIds: [], tiles: [] },
    { entryId: 'lakeside', name: 'Lakeside', kind: 'theme', widgetIds: [], tiles: [] },
    { entryId: 'atelier-78', name: 'Atelier 78', kind: 'bundle', widgetIds: [], tiles: [] },
    { entryId: 'feature-lyrics', name: 'Lyrics', kind: 'feature', widgetIds: [], tiles: [] },
  ],
};
const TRIAL_CATALOG = {
  entries: [
    { id: 'pit-wall', kind: 'bundle', shots: 4 }, { id: 'lakeside', kind: 'theme', shots: 4 },
    { id: 'atelier-78', kind: 'bundle', shots: 4 }, { id: 'feature-lyrics', kind: 'feature', shots: 0 },
  ],
};

export const SCENES = {
  // Settings → Bit with a low balance: the three packs.
  'sparks-settings': {
    routes: { '/api/ai/xenon/balance': BALANCE_LOW },
    open: async () => {
      hubSettings.aiProvider = 'xenon';
      openSettings('ai');
      await new Promise((r) => setTimeout(r, 400));
      await XenonCredits.refresh(true);
      XenonCreditsSettings.render();
      document.getElementById('xai-packs').scrollIntoView({ block: 'center' });
      return '#xai-packs';
    },
  },
  // The Store's Supporters panel with a saved code: packs under the perks.
  'sparks-store': {
    routes: { '/api/ai/xenon/balance': BALANCE_LOW, '/api/community/supporter': { saved: true } },
    open: async () => {
      hubSettings.aiProvider = 'xenon';
      await XenonCredits.refresh(true);
      CommunityGallery.openSupporters();
      await new Promise((r) => setTimeout(r, 1200));
      const box = document.querySelector('.cgal-info-sparks');
      if (box) box.scrollIntoView({ block: 'center' });
      return '.cgal-info-sparks';
    },
  },
  // Bit's mail with the Scintille letter open.
  'sparks-mail': {
    routes: { '/api/ai/xenon/balance': BALANCE_LOW },
    open: async () => {
      hubSettings.aiProvider = 'xenon';
      await XenonCredits.refresh(true);
      const l = SparksMail.letterFor(XenonCredits.level(), Date.now());
      BitMail.open(l && l.id);
      return '.bitmail';
    },
  },
  // Bit's chat in English, drawn by the chat's own renderer with answers written
  // here: a check of the chat's look only, never a picture for the site. The
  // site shows real answers, shot from a real turn on a test server.
  'bit-chat': {
    routes: { '/api/ai/xenon/balance': BALANCE_FULL },
    crop: true,
    open: async () => {
      setLang('en');
      hubSettings.aiProvider = 'xenon';
      updateMediaChatKeyState();
      document.querySelector('.tabgroup-tab[data-member="chat"]').click();
      await new Promise((r) => setTimeout(r, 400));
      _aiDropWelcome();
      _aiAppendBubble('user', 'Save the last 42 seconds to my Desktop');
      _aiAppendBubble('assistant', 'Saved to your Desktop. The replay keeps 30 seconds, so the clip is 30 seconds long. Want me to keep 60 from now on?');
      _aiAppendBubble('user', 'Why is my game stuttering?');
      _aiAppendBubble('assistant', 'One CPU core is at 100% and the GPU is waiting for it.');
      return '.panel.tabgroup:has(.chat-panel)';
    },
  },
  // The pass trial's end card: what was used in pictures, one way to keep it.
  // trial-pass-ui.js boots 8 s after load and opens the card by itself.
  'trial-end': {
    routes: {
      '/api/community/trial': TRIAL_ENDED, '/api/community/trial/check': TRIAL_ENDED,
      '/api/community/supporter': { saved: false }, '/api/community/catalog': TRIAL_CATALOG,
    },
    open: async () => {
      for (let i = 0; i < 60 && !document.querySelector('.trial-end-gets img'); i++) await new Promise((r) => setTimeout(r, 250));
      await new Promise((r) => setTimeout(r, 1500));
      return '.preset-modal';
    },
  },
};
