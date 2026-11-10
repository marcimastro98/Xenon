// What each scene opens. `routes` mock the APIs it needs, `open` runs in the
// page and returns the selector to measure (or null for the whole page).
// `open` uses the dashboard's globals by their bare names: some are top-level
// `let`s (hubSettings), which are not properties of window.
/* global hubSettings, setAppearance, applyHubSettings, openSettings, openDayModal, XenonCredits, XenonCreditsSettings, CommunityGallery, SparksMail, BitMessages,
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

// Store widgets installed on this PC, none approved yet (the settings copy is
// empty), one with a newer version in the catalog, one made by the user.
const INSTALLED_PACKAGES = {
  ok: true, api: 1, invalid: [], skipped: 0,
  packages: [
    { id: 'orbit-clock', name: 'Orbit Clock', version: '1.0.2', author: 'Studio North', origin: 'import', exportable: false, catalogVersion: '1.0.2' },
    { id: 'rain-radar', name: 'Rain Radar', version: '2.1.0', author: 'Pixel Harbor', origin: 'import', exportable: false, catalogVersion: '2.1.0' },
    { id: 'focus-timer', name: 'Focus Timer', version: '1.4.0', author: 'Kite Labs', origin: 'import', exportable: false, catalogVersion: '1.4.0' },
    { id: 'desk-notes', name: 'Desk Notes', version: '0.3.0', origin: 'local', exportable: true },
  ],
};
const INSTALLED_CATALOG = {
  ok: true,
  entries: [{ id: 'orbit-clock', pkgId: 'orbit-clock', kind: 'widget', name: 'Orbit Clock', version: '1.1.0', shots: 0 }],
};
const CALL_SIZES = ['desk', 'phone', 'phone-side', 'small-side'];
const INSTALLED_ROUTES ={ '/sdk/widgets': INSTALLED_PACKAGES, '/api/community/catalog': INSTALLED_CATALOG };

// The balance where it shows, the Store rail and the Settings head, for each thing it can say.
const chipInStore = async () => {
  CommunityGallery.open();
  await new Promise((r) => setTimeout(r, 900));
  return '.cst-rail';
};
const chipInSettings = async () => {
  openSettings('ai');
  await new Promise((r) => setTimeout(r, 900));
  return '.settings-nav-footer';
};
const CHIP_STATES = { buy: { ok: false, error: 'no_code' }, low: BALANCE_LOW, full: BALANCE_FULL, offline: { ok: false, error: 'network' } };
const chipScenes = Object.fromEntries(Object.entries(CHIP_STATES).flatMap(([state, balance]) => [
  [`chip-${state}-store`, { routes: { '/api/ai/xenon/balance': balance }, crop: true, open: chipInStore }],
  [`chip-${state}-settings`, { routes: { '/api/ai/xenon/balance': balance }, crop: true, open: chipInSettings }],
]));

// The Deck key editor's action list on Liquid Glass: a step added, the list opened, Capture
// unfolded, scrolled so rows pass under its search box.
async function deckPicker() {
  // The look comes from a mocked address: `open` is sent to the page as text, without its scene.
  const look = await (await fetch('/api/shots/look')).json();
  hubSettings.styleMode = 'liquid';
  if (look.appearance) setAppearance(look.appearance); else applyHubSettings();
  window.DeckEditor.open({ onSave() {}, onDelete() {} });
  await new Promise((r) => setTimeout(r, 500));
  document.querySelector('.deck-ed-addstep').click();
  await new Promise((r) => setTimeout(r, 200));
  document.querySelector('.deck-ed-modal select[data-cs-search]').previousElementSibling.querySelector('.cs-trigger').click();
  await new Promise((r) => setTimeout(r, 300));
  const panel = [...document.querySelectorAll('.cs-panel')].find((p) => p.getBoundingClientRect().height > 0);
  const capture = [...panel.querySelectorAll('.cs-group-btn')].find((b) => /Capture|Cattura/.test(b.textContent));
  if (capture) capture.click();
  panel.scrollTop = 160;
  await new Promise((r) => setTimeout(r, 200));
  return null;
}

// The State tab of an Instant Replay key: it follows Replay, or (unlit) keeps one face.
async function deckKeyState() {
  const look = await (await fetch('/api/shots/look')).json();
  hubSettings.styleMode = 'liquid';
  applyHubSettings();
  const key = { id: 'k', kind: 'action', title: 'Replay', triggers: { tap: { type: 'replay' } } };
  if (look.unlit) key.unlit = true;
  window.DeckEditor.open({ key, onSave() {}, onDelete() {} });
  await new Promise((r) => setTimeout(r, 500));
  const tab = [...document.querySelectorAll('.deck-ed-tab')].find((b) => /^(Stato|State)$/.test(b.textContent.trim()));
  if (tab) tab.click();
  await new Promise((r) => setTimeout(r, 400));
  return null;
}

export const SCENES = {
  ...chipScenes,
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
  // The Store's Sparks view.
  'sparks-store': {
    routes: { '/api/ai/xenon/balance': BALANCE_LOW, '/api/community/supporter': { saved: true } },
    open: async () => {
      hubSettings.aiProvider = 'xenon';
      await XenonCredits.refresh(true);
      CommunityGallery.open('__sparks');
      await new Promise((r) => setTimeout(r, 1200));
      return '.sparks-shop';
    },
  },
  // Bit's card about the Scintille.
  'sparks-mail': {
    routes: { '/api/ai/xenon/balance': BALANCE_LOW },
    open: async () => {
      hubSettings.aiProvider = 'xenon';
      await XenonCredits.refresh(true);
      BitMessages.preview(SparksMail.messageFor(XenonCredits.level(), Date.now()));
      return '.bm-card';
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
  // The Store's Installed page with widgets still waiting for their permissions.
  installed: {
    routes: INSTALLED_ROUTES,
    open: async () => {
      CommunityGallery.open('__installed');
      for (let i = 0; i < 40 && !document.querySelector('.inst-row'); i++) await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => setTimeout(r, 600));
      return '.cst-overlay';
    },
  },
  // The same update seen from outside the Store: the dashboard, then Settings. The
  // count is painted 4 s after boot (`open` runs in the page, so the wait is inline).
  'updates-dashboard': { routes: INSTALLED_ROUTES, open: async () => { await new Promise((r) => setTimeout(r, 4500)); return null; } },
  'updates-settings': {
    routes: INSTALLED_ROUTES,
    open: async () => {
      await new Promise((r) => setTimeout(r, 4500));
      openSettings('general');
      await new Promise((r) => setTimeout(r, 900));
      return null;
    },
  },
  // The guided tour on its first and last stop (`tour`, `tour-last`).
  tour: { open: async () => { window.Onboarding.start(); await new Promise((r) => setTimeout(r, 700)); return null; } },
  'tour-last': {
    open: async () => {
      window.Onboarding.start();
      for (let i = 0; i < 3; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      return null;
    },
  },
  // Send to PC, then the same sheet halfway down a pull (the phone's swipe to close).
  'send-sheet': { open: async () => { window.TransferWidget.openSheet(); await new Promise((r) => setTimeout(r, 700)); return null; } },
  'send-sheet-pull': {
    open: async () => {
      window.TransferWidget.openSheet();
      await new Promise((r) => setTimeout(r, 700));
      const panel = document.querySelector('.xfer-sheet');
      panel.classList.add('is-pulled');
      panel.style.setProperty('--xfer-pull', '140px');
      return null;
    },
  },
  // The colour picker driven by the keyboard: the hue strip focused and moved.
  'color-keys': {
    open: async () => {
      window.ColorPicker.open({ anchor: document.querySelector('.qbtn-settings'), value: '#6ee787', onPick() {} });
      await new Promise((r) => setTimeout(r, 300));
      const hue = document.querySelector('.cp-hue');
      hue.focus();
      for (let i = 0; i < 5; i++) hue.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }));
      hue.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return '.cp-pop';
    },
  },
  // The day window's time picker driven by the keyboard: opened, hour moved, then the minutes.
  'time-keys': {
    open: async () => {
      openDayModal(new Date().toISOString().slice(0, 10));
      await new Promise((r) => setTimeout(r, 400));
      const btn = document.getElementById('time-picker-btn');
      btn.focus();
      btn.click();
      const key = (k) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
      key('ArrowDown');
      key('ArrowDown');
      document.getElementById('tp-minutes').querySelector('.tp-item.selected').focus();
      key('ArrowUp');
      await new Promise((r) => setTimeout(r, 200));
      return null;
    },
  },
  // The ringing card, on a phone both ways up: one that can be answered, one that
  // cannot (its honest line shows). Close has to be there in every shape.
  // (`open` is sent to the page as text, so each scene spells its caps out.)
  call: {
    sizes: CALL_SIZES,
    open: async () => {
      window.CallModal.onCalls({ calls: [{ id: 'shot', source: 'phone', appName: 'Phone', caller: 'Sam Rivera', caps: { answer: true, decline: true, open: true }, endsAt: Date.now() + 60000 }] });
      await new Promise((r) => setTimeout(r, 400));
      return '.call-card';
    },
  },
  'call-note': {
    sizes: CALL_SIZES,
    open: async () => {
      window.CallModal.onCalls({ calls: [{ id: 'shot', source: 'phone', appName: 'Phone', caller: 'Sam Rivera', caps: { open: true }, endsAt: Date.now() + 60000 }] });
      await new Promise((r) => setTimeout(r, 400));
      return '.call-card';
    },
  },
  // Trying the new look: the card that stays on the dashboard while the look is on.
  'look-card': {
    sizes: ['desk', 'phone', 'small-phone'],
    open: async () => {
      window.LookTrial.run({
        tr: (k) => window.t(k),
        mountBit: (host) => (window.Xenon && window.Xenon.bitPlayer ? window.Xenon.bitPlayer.mount(host, { mood: 'idle', fidgets: false, label: 'Bit' }) : null),
        stepOut() {}, comeBack() {},
      });
      for (let i = 0; i < 40 && !document.querySelector('.wn-look'); i++) await new Promise((r) => setTimeout(r, 150));
      await new Promise((r) => setTimeout(r, 900));
      return null;
    },
  },
  // The Deck key editor's action list on Liquid Glass, scrolled so rows pass under
  // its search box, then searched: the box must hide them and the chosen row is not green.
  'deck-picker': { open: deckPicker },
  'deck-picker-light': { routes: { '/api/shots/look': { appearance: 'light' } }, open: deckPicker },
  'deck-key-state': { routes: { '/api/shots/look': {} }, open: deckKeyState },
  'deck-key-one-face': { routes: { '/api/shots/look': { unlit: true } }, open: deckKeyState },
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
