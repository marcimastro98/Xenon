// Bit's chat for the site's picture, on the chat's own renderer. The answers are the ones
// a real turn gave on a test server, on a real replay and real frame times: only the game's
// name is invented, as everywhere on the site.

const GAME = 'Cyberfall';
const TURN = [
  ['user', 'Save the last 42 seconds to my Desktop'],
  ['assistant', `The last 42 seconds are saved to your Desktop as "${GAME} Replay 2026-10-30 22-52-21.mp4". The clip came out at about 44 seconds.`],
  ['user', "How's my FPS?"],
  ['assistant', `${GAME} is running at about 239 FPS on average, close to your display's 240 Hz. The 1% low is 151 FPS, and the 0.1% low is 61 FPS, so there are occasional short dips. The worst frame took about 20 ms, which is brief enough that you probably won't notice it.`],
];

const BALANCE = { ok: true, balance: 260, included: 260, monthly: 300, topup: 0 };

export function bitChat() {
  return {
    answers: { '/api/ai/xenon/balance': BALANCE },
    stage: `(async () => {
      hubSettings.aiProvider = 'xenon';
      updateMediaChatKeyState();
      await XenonCredits.refresh(true);
      document.querySelector('.tabgroup-tab[data-member="chat"]').click();
      await new Promise((done) => setTimeout(done, 400));
      _aiDropWelcome();
      document.getElementById('ai-chat').replaceChildren();
      for (const [role, text] of ${JSON.stringify(TURN)}) _aiAppendBubble(role, text);
    })()`,
  };
}
