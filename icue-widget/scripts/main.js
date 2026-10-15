'use strict';
// The Xenon widget is a frame around the dashboard the Xenon app already
// serves on this PC. Nothing of the dashboard is copied in here: the widget
// finds Xenon, shows it, and does the three things a frame cannot do alone
// inside iCUE (see js/icue-host.js in the dashboard for the other half):
// hand over the keyboard, open links in the browser, and say plainly when
// Xenon is not running.
const XENON = 'http://127.0.0.1:3030';
const DOWNLOAD_URL = 'https://xenon-app.com/';
const PING_OFFLINE_MS = 5000;
const PING_ONLINE_MS = 15000;
const PING_TIMEOUT_MS = 3000;
const MISSES_BEFORE_OFFLINE = 2;
const ICUE_WAIT_MS = 1500;
const READY_WAIT_MS = 2000;
// Messages shared with js/icue-host.js in the dashboard.
const MSG = {
  hello: 'xenon:hello',
  widget: 'xenon:widget',
  ready: 'xenon:ready',
  keyboard: 'xenon:keyboard',
  open: 'xenon:open',
};

const frame = document.getElementById('xenon');
const panel = document.getElementById('panel');
const panelTitle = document.getElementById('panel-title');
const panelLine = document.getElementById('panel-line');
const panelAction = document.getElementById('panel-action');

// modern: this Xenon has said hello at least once, so it answers checks.
// helloThisLoad: the page now in the frame said hello. alive: it answered
// the last check.
const state = { shown: null, misses: 0, timer: 0, probe: 0, modern: false, helloThisLoad: false, alive: false };

// ── Finding Xenon ───────────────────────────────────────────────────────
// /status answers JSONP for exactly this: a widget page has a file:// origin
// and the Xenon server refuses its fetch() calls.
function ping() {
  return new Promise((resolve) => {
    const cb = '__xenonPing' + Date.now();
    const script = document.createElement('script');
    const timer = setTimeout(() => done(false), PING_TIMEOUT_MS);
    function done(ok) {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      resolve(ok);
    }
    window[cb] = () => done(true);
    script.onerror = () => done(false);
    script.src = XENON + '/status?cb=' + cb;
    document.head.append(script);
  });
}

async function check() {
  const up = await ping();
  if (state.shown === 'preview') return;
  const recovered = up && state.misses > 0;
  state.misses = up ? 0 : state.misses + 1;
  if (up && state.shown === 'dashboard') verifyFrame(recovered);
  else if (up) showDashboard();
  // Xenon restarts for a few seconds when it updates; one miss is not an outage.
  else if (state.shown !== 'dashboard' || state.misses >= MISSES_BEFORE_OFFLINE) showOffline();
  schedule(state.shown === 'dashboard' ? PING_ONLINE_MS : PING_OFFLINE_MS);
}

function schedule(ms) {
  clearTimeout(state.timer);
  state.timer = setTimeout(check, ms);
}

// ── What the widget shows ───────────────────────────────────────────────
function showDashboard() {
  state.shown = 'dashboard';
  loadFrame();
  frame.hidden = false;
  panel.hidden = true;
}

function loadFrame() {
  state.helloThisLoad = false;
  frame.src = XENON + '/';
}

// A frame that loaded while Xenon was restarting is stuck on the browser's
// error page, and the dashboard's own reconnecting cannot run there. A live
// dashboard answers the check; an older one cannot, so for those the frame
// reloads once after Xenon was briefly unreachable.
function verifyFrame(recovered) {
  if (!state.modern) {
    if (recovered) loadFrame();
    return;
  }
  state.alive = false;
  frame.contentWindow.postMessage({ type: MSG.widget }, XENON);
  clearTimeout(state.probe);
  state.probe = setTimeout(() => {
    if (state.shown === 'dashboard' && !state.alive) loadFrame();
  }, READY_WAIT_MS);
}

// Unloading the frame stops the dashboard retrying a server that is gone;
// it loads fresh when Xenon is back.
function showOffline() {
  if (state.shown === 'offline') return;
  state.shown = 'offline';
  unloadFrame();
  showPanel('Xenon is not running', 'Open Xenon on this PC and it shows up here by itself.', 'Get Xenon');
}

// The iCUE app draws a second, preview copy of every widget. A second live
// dashboard there would cost as much as the real one, for a thumbnail.
function showPreview() {
  state.shown = 'preview';
  clearTimeout(state.timer);
  unloadFrame();
  showPanel('Xenon', 'Your Xenon dashboard shows here on the Xeneon Edge.', null);
}

function unloadFrame() {
  clearTimeout(state.probe);
  frame.hidden = true;
  frame.removeAttribute('src');
}

async function showPanel(title, line, action) {
  const [t, l, a] = await Promise.all([icueText(title), icueText(line), action ? icueText(action) : null]);
  panelTitle.textContent = t;
  panelLine.textContent = l;
  panelAction.hidden = !a;
  if (a) panelAction.textContent = a;
  panel.hidden = false;
}

panelAction.addEventListener('click', () => icueOpenLink(DOWNLOAD_URL));

// ── Talking to the dashboard ────────────────────────────────────────────
function fromDashboard(e) {
  return e.source === frame.contentWindow && e.origin === XENON && e.data && typeof e.data.type === 'string';
}

function safeWebUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch (err) { return null; }
}

window.addEventListener('message', (e) => {
  if (!fromDashboard(e)) return;
  const { type } = e.data;
  if (type === MSG.hello) {
    state.modern = true;
    state.helloThisLoad = true;
    frame.contentWindow.postMessage({ type: MSG.widget }, XENON);
  } else if (type === MSG.ready) {
    state.alive = true;
  } else if (type === MSG.keyboard) {
    icueGrantKeyboard();
  } else if (type === MSG.open) {
    const url = safeWebUrl(e.data.url);
    if (url) icueOpenLink(url);
  }
});

// A dashboard older than the hello cannot say a text field was focused. The
// next best signal is focus entering the frame at all; it also fires on
// buttons, which is why it only covers those older versions.
window.addEventListener('blur', () => {
  setTimeout(() => {
    if (!state.helloThisLoad && document.activeElement === frame) icueGrantKeyboard();
  }, 0);
});

// ── Start ───────────────────────────────────────────────────────────────
// Whether this copy is the preview is only known once iCUE is ready, so this
// runs again when it is (index.html binds it to onICUEInitialized). In a
// plain browser iCUE never answers: after a moment the widget just starts.
let previewHooked = false;
function startWidget() {
  if (!previewHooked && icueDataProvider()) {
    previewHooked = true;
    icueOnPreviewChange(startWidget);
  }
  if (icueIsPreview()) showPreview();
  else if (state.shown === null || state.shown === 'preview') {
    state.shown = null;
    check();
  }
}

if (typeof iCUE_initialized !== 'undefined' && iCUE_initialized) startWidget();
setTimeout(startWidget, ICUE_WAIT_MS);
