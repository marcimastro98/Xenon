'use strict';
// Windows only. The OS media list takes the player buttons, but its service can wedge
// (every call times out) and many players never join it, so a press was lost without a
// word. Then the app heard playing is told directly, by a message to its window. The
// keyboard's media key comes last: with the service wedged it reaches nobody and still
// reports success (measured on Spotify), so it is only for an app that took no message.

const MEDIA_KEYS = Object.freeze({ playpause: 0xB3, next: 0xB0, previous: 0xB1 });
// WM_APPCOMMAND values.
const APP_COMMANDS = Object.freeze({ playpause: 14, next: 11, previous: 12 });

/** Presses the key for `action`; `runScript` takes the script's arguments. */
async function pressMediaKey(action, runScript) {
  const key = MEDIA_KEYS[action];
  if (!key) return { ok: false, error: 'bad_action' };
  await runScript(['-Key', String(key)]);
  return { ok: true, pressed: true };
}

/** Tells `app` (a process name) directly; true only if a window of it took the command. */
async function tellApp(action, app, runScript) {
  const command = APP_COMMANDS[action];
  if (!command || !app) return false;
  try {
    const out = await runScript(['-Command', String(command), '-App', app]);
    return Boolean(out) && out.ok === true;
  } catch {
    return false;
  }
}

// The list first, unless it failed or does not know the player: a wedged one answers
// after its whole timeout. One way only: two would pause and restart the same song.
function createMediaSender({ request, tell, press, listResting }) {
  return async function send(action) {
    const answer = listResting() ? null : await request(action).catch(() => null);
    if (answer && answer.ok === true) return answer;
    if (await tell(action)) return { ok: true, told: true };
    return press(action);
  };
}

module.exports = { MEDIA_KEYS, APP_COMMANDS, pressMediaKey, tellApp, createMediaSender };
