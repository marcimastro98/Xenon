// What the page check asks a page to do before it reads it, for two scripts that load
// other scripts only when the app has a reason to (`loaders` in browser-consumers.json).
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
