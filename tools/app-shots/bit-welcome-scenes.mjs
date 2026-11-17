// Bit's empty chat (js/bit-welcome.js) in a language: the hello and the four
// starters, the first one asking what Xenon can do. scenes.mjs spreads these in.
/* global setLang, hubSettings, updateMediaChatKeyState, BitChatFull, _aiRenderWelcomeIfEmpty */

async function welcome({ lang = 'it' } = {}) {
  setLang(lang);
  hubSettings.aiProvider = 'xenon';
  updateMediaChatKeyState();
  // The chat where it is, or in its sheet when the layout has no chat tile.
  BitChatFull.ask('');
  _aiRenderWelcomeIfEmpty();
  await new Promise((r) => setTimeout(r, 600));
  return BitChatFull.isOpen() ? '.bit-sheet' : '#media-pane-chat';
}

const BALANCE = { ok: true, balance: 300, included: 300, monthly: 300, topup: 0 };
const scene = (lang, sizes) => ({ sizes, crop: true, routes: { '/api/ai/xenon/balance': BALANCE }, open: welcome, arg: { lang } });

export const bitWelcomeScenes = {
  'bit-welcome-it': scene('it', ['desk', 'phone', 'edge']),
  'bit-welcome-de': scene('de', ['desk']),
  'bit-welcome-ja': scene('ja', ['edge']),
};
