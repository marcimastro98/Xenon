'use strict';
// "Is it a game?" asked once. A game played in a window can draw exactly like a
// desktop app, so neither the full-screen rule nor the windowed hint finds it
// (gamedetect.js) and the user saw no FPS and no game mode. Treating every such
// app as a game would bring back launcher trailers and video calls, so Xenon
// asks instead: when the same app stays in front, in a window, drawing at a game
// rate for ASK_AFTER_MS, the dashboard or the alerts window shows one card with
// "It's a game" and "Not a game". Both answers land in the user's lists
// (gameAlways / gameIgnore), so the question never comes back for that app.
//
// Careful by design, because a wrong card is worse than none:
// - only while no game is detected, never for a full-screen window;
// - never for the built-in non-games, the windowed ones (players, editors,
//   chat), launchers and video-call apps (SKIP_RE), or an app on either list;
// - only with frames of the app in front itself (game-guess/front-frames.js),
//   so the frames of an app in the background never count;
// - a short break in its frames (a loading screen) keeps the count, a longer
//   one or another app in front starts it again;
// - once per app per run: a card left unanswered asks again only after a restart.
// Frame data comes from PresentMon, so on macOS and Linux it never asks; the
// two lists in Settings work there all the same.
//
// Rides on the system tick (server.js), which runs only while a screen listens.

const ASK_AFTER_MS = 20000;
const BREAK_MS = 4000;
const MIN_FPS = 24;

// Launchers and stores (their trailers play in a window), video calls, the
// GPU vendors' apps, live wallpapers, and Windows' own frame hosts. Exact names
// where a short word could be part of a game's name.
const SKIP_RE = /battle\.net|epicgameslauncher|eadesktop|ubisoftconnect|galaxyclient|riotclient|leagueclient|playnite|xboxpcapp|amazongames|heroic|lutris|webex|lghub|radeonsoftware|nvidia app|wallpaper(?:32|64)|lively|applicationframehost|systemsettings|textinputhost|^(?:origin|upc|itch|zoom|skype|bottles)$/i;

const bare = (name) => String(name || '').trim().toLowerCase().replace(/\.exe$/, '');

// deps: { front() → { process, fullscreen, ignored, listed }|null, frontPid() → number,
//         frames() → { pid, fps }|null, gaming() → bool, windowedNonGame(name) → bool,
//         broadcast(payload), now() }
function createGameGuess(deps) {
  const d = deps || {};
  const now = typeof d.now === 'function' ? d.now : Date.now;
  const asked = new Set();
  let streak = null; // { name, since, seen }

  const call = (fn, ...args) => { try { return typeof fn === 'function' ? fn(...args) : null; } catch { return null; } };

  // The app in front when it may be a game drawing like a desktop app, else ''.
  function candidate() {
    if (call(d.gaming) === true) return '';
    const w = call(d.front);
    if (!w || w.fullscreen === true || w.ignored === true || w.listed === true) return '';
    const name = bare(w.process);
    if (!name || name === '?' || asked.has(name) || SKIP_RE.test(name) || call(d.windowedNonGame, name) === true) return '';
    const f = call(d.frames);
    const pid = String(call(d.frontPid) || '');
    if (!f || !pid || String(f.pid) !== pid || !(f.fps >= MIN_FPS)) return '';
    return name;
  }

  // Every system tick. Returns the payload when it asked.
  function onTick() {
    const t = now();
    const name = candidate();
    if (!name) {
      if (streak && t - streak.seen > BREAK_MS) streak = null;
      return null;
    }
    if (!streak || streak.name !== name || t - streak.seen > BREAK_MS) streak = { name, since: t, seen: t };
    streak.seen = t;
    if (t - streak.since < ASK_AFTER_MS) return null;
    asked.add(name);
    streak = null;
    const payload = { process: name };
    call(d.broadcast, payload);
    return payload;
  }

  return { onTick };
}

module.exports = { createGameGuess, ASK_AFTER_MS, BREAK_MS, MIN_FPS, SKIP_RE };
