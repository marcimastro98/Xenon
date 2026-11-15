// What the page check asks a page to do before it reads it, for three scripts that load
// other scripts only when the app has a reason to (`loaders` in browser-consumers.json),
// and what it asks a page whose window changed size.
// Each function runs in the page, so it uses nothing from this file.

// Performance Mode with no dashboard (js/driver-perf.js): the driver page loads the
// scripts of its list once the mode is on or a session runs. Asked here through the
// script's own `load`, with a stand-in for what the page hands it, so that nothing is
// read from or saved to the copy's settings: the list is loaded, in the list's order.
export function loadPerformanceMode() {
  const perf = window.DriverPerf.create({ win: window, doc: document, read: () => ({}), post: () => Promise.resolve(null) });
  return perf.load().then(() => (perf.loaded() ? 'loaded' : 'loaded, and no PerfMode'), (error) => `not loaded: ${error?.message || error?.type || error}`);
}

// The editor of a layer window (js/layer-host.js): the window asks for the scripts of
// its list when the engine says edit mode is on, which the check turned on before it
// opened the page. This waits until the last of them has run and the editor draws.
export function editorStarted() {
  const WAIT_MS = 15000;
  const STEP_MS = 100;
  const drawn = () => Boolean(window.LayerEdit && document.querySelector('.layer-edit-bar'));
  return new Promise((resolve) => {
    const began = Date.now();
    const look = () => {
      if (drawn()) resolve('started');
      else if (Date.now() - began > WAIT_MS) resolve(`not started: ${window.LayerEdit ? 'the editor is there and draws nothing' : 'no editor'}, editing ${window.LayerHost?.editing()}`);
      else setTimeout(look, STEP_MS);
    };
    look();
  });
}

// The Game Companion card of the alerts window (js/ai/screen-companion.js): the window loads the card's scripts the
// first time a key, its shortcut or the voice opens it. Opened here the way the engine's message does, with a game
// that is not running. Whether the card then shows follows the settings of the copy; its scripts are loaded either way.
export function openCompanion() {
  const told = (shown) => (window.GameCompanion ? `loaded, ${shown ? 'shown' : 'not shown'}` : 'not loaded');
  return window.ScreenCompanion.open({ game: 'sample.exe' }).then(told, (error) => `not loaded: ${error?.message || error}`);
}

// The rows that pick a more compact look when space runs out (js/fit-row.js), as the page shows them. Asked before
// and after the window is made narrower, so that a row which stopped following its width is a difference.
//
// The level itself is not the answer: it depends on what the row holds that day. The system tabs end with how long
// the PC has been up, and at 1280 wide "Up for 21h 17m" rests at level 1 where "Up for 32h 30m" rests at level 2, so
// two recordings made at different hours disagreed about a row that was right both times. What does not depend on
// the day is asked: whether the row left its roomy look (`compact`), whether the level it rests at is the lowest
// one that fits what it holds now (`lowest`, worked out the way fit-row.js does and put back), and whether anything
// is cut off. A fit takes a frame and may cause another, so the answer is read every frame until it has been the
// same for STILL frames in a row, FRAMES at most.
export async function fitRows() {
  const STILL = 5;
  const FRAMES = 120;
  const lowestOf = (row, levels) => {
    const now = row.dataset.fit;
    let found = levels - 1;
    for (let level = 0; level < levels; level += 1) {
      row.dataset.fit = String(level);
      if (!window.FitRow.overflows(row)) { found = level; break; }
    }
    row.dataset.fit = now;
    return String(found);
  };
  const read = () => [...document.querySelectorAll('[data-fit-levels]')].filter((row) => row.clientWidth > 0 && row.dataset.fit !== undefined).map((row) => ({
    row: String(row.className), of: row.closest('[data-dashboard-widget]')?.getAttribute('data-dashboard-widget') ?? null,
    levels: row.dataset.fitLevels, compact: row.dataset.fit !== '0', lowest: row.dataset.fit === lowestOf(row, Number(row.dataset.fitLevels) + 1),
    cutOff: window.FitRow.overflows(row),
  }));
  let answer = [];
  let last = '';
  for (let frames = 0, still = 0; frames < FRAMES && still < STILL; frames += 1) {
    answer = read();
    const text = JSON.stringify(answer);
    still = text === last ? still + 1 : 1;
    last = text;
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  return answer;
}
