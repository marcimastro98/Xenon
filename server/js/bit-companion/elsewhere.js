'use strict';
// The own Bit's day on a page that shows no Bit of the dashboard's: the pump's screen (pump-widget.html),
// whose browser is not the app's and shares nothing with it. From the same live stream moments.js hears,
// it knows what Bit does at rest (coding while Claude Code or Codex work, gaming while the person plays),
// a move asked from the chat, a Deck key or a phone (bit_play), the person talking with Bit in the chat or
// by voice (bit_talk: it listens, thinks and talks too), and it feeds signals.js the events its signs
// come from: the SDK `bit` stream says there what it says on the dashboard. No poll and no timer.
(() => {
  const SIGNAL_EVENTS = ['claude', 'codex', 'calendar_reminder', 'timer_done', 'system']; // signals.js
  const ID = /^[a-z][a-zA-Z0-9-]{0,31}$/;
  const running = { claude: false, codex: false }; // a session of theirs works now
  let gaming = false;
  let played = null; // { clip, at }
  // The talk with Bit now ('listen', 'think', 'talk'; moments.js the same), let go after TALK_MS without news.
  const TALKS = ['listen', 'think', 'talk'];
  const TALK_MS = 120000;
  let talk = { state: '', at: 0 };
  const talking = () => (talk.state && Date.now() - talk.at < TALK_MS ? talk.state : '');

  // As moments.js reads a session: waiting for the person is asking, not working.
  const works = (s) => !!s && !s.waitFor && s.state === 'running';

  const HEARD = {
    status: (d) => { if (d.gaming != null || d.gameRunning != null) gaming = !!d.gaming; },
    claude: (d) => { if (Array.isArray(d.live?.sessions)) running.claude = d.live.sessions.some(works); },
    codex: (d) => { if (Array.isArray(d.live?.sessions)) running.codex = d.live.sessions.some(works); },
    bit_talk: (d) => { talk = { state: TALKS.includes(d.state) ? d.state : '', at: Date.now() }; },
    bit_play: (d) => { if (typeof d.clip === 'string' && ID.test(d.clip)) played = { clip: d.clip, at: Date.now() }; },
  };

  /** What Bit does between moments, as moments.js rest() says it on the dashboard. */
  const rest = () => talking() || (gaming ? 'gamer' : running.claude || running.codex ? 'code' : window.BitSignals?.top() ? 'tell' : 'idle');

  /** The page's live stream (an EventSource): one listener and one parse per event name. */
  function listen(es) {
    for (const name of new Set([...Object.keys(HEARD), ...SIGNAL_EVENTS])) {
      es.addEventListener(name, (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch { return; } // a broken event changes nothing
        if (!d || typeof d !== 'object') return;
        HEARD[name]?.(d);
        if (SIGNAL_EVENTS.includes(name)) window.BitSignals?.heard(name, d);
      });
    }
  }

  window.BitElsewhere = Object.freeze({ listen, rest, lastPlayed: () => played });
})();
