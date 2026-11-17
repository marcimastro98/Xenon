// The first-run question in the app that draws widgets, on an invented monitor and Xeneon
// Edge (tools/app-shots/scenes.mjs spreads these in). `step: 'key'` goes on to its last
// step, "press the key"; `late` waits past the 20 s after which the step offers another
// key; `done` is the moment after the press. Run inside the page, so it takes its options
// as the scene's `arg`, never from a closure.

async function firstRun({ step = '', late = false, done = false } = {}) {
  const DISPLAYS = [
    { id: 'M1', name: 'DELL U2723QE', primary: true, width: 2560, height: 1440, x: 0, y: 0 },
    { id: 'M2', name: 'XENEON EDGE', edge: true, width: 2560, height: 720, x: 0, y: 1440 },
  ];
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  window.SurfacePicker?.close?.();
  window.__XENON_NATIVE__ = true;
  window.__XENON_NATIVE_CAPS__ = { layers: true, menu: true };
  window.XenonNative = { displayState: () => ({ displays: DISPLAYS, fullscreen: false }), chooseScreen() {} };
  if (window.UsageAskKey && late) window.UsageAskKey.LATE_MS = 300;
  window.UsageAsk.maybeStart();
  await pause(1200);
  if (step === 'key') document.querySelector('.ua-go').click();
  await pause(late ? 1500 : 1200);
  // What the server's SSE `screen_menu` says when the key opens Xenon.
  if (done) { window.UsageAskKey.onMenu({ open: true, section: 'screens' }); await pause(400); }
  return null;
}

export const firstRunScenes = {
  'first-run': { sizes: ['desk', 'phone', 'edge'], open: firstRun, arg: {} },
  'first-run-key': { sizes: ['desk', 'phone', 'edge'], open: firstRun, arg: { step: 'key' } },
  'first-run-key-late': { sizes: ['desk', 'phone'], open: firstRun, arg: { step: 'key', late: true } },
  'first-run-key-done': { sizes: ['desk', 'edge'], open: firstRun, arg: { step: 'key', done: true } },
};
