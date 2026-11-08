'use strict';
// The Xenon menu over the main screen (plan §20): the native shell opens a page
// over everything (/menu, js/screen-menu-page.js) while it is open. The server
// keeps only whether it is open and on which section, and tells the pages over
// SSE `screen_menu`; the dashboard, or the "widgets only" driver, turns that into
// a `menu:` surface for the shell (js/layers-shell.js). Runtime only: a restart
// closes it. Where no shell can draw it, opening it asks the open dashboards to
// show the same menu as a panel instead (SSE `xenon_menu_panel`).
//
// deps:
//   host       layers-host.js: menus() says a shell that can draw the menu is running
//   broadcast  ({ open, section }) → void, the SSE push for the shell surface
//   panel      ({ section }) → void, the SSE push that opens the dashboard panel
//   run        (action) → Promise<{ ok, error }>, the registry
//   failed     (error) → void, says a closing row's failure somewhere still on screen
//   delayMs    how long the menu's window gets to go before the action runs
//   capturing  () → boolean, Xenon is recording: the menu stays out of that video,
//              and is otherwise the user's to photograph
//   holding    () → boolean, the action started a mode that goes on after it (moving
//              widgets): the menu stays aside until holdEnded()
//
// A one-shot function (a screenshot, the colour picker) does not cost the menu:
// it steps aside, out of the picture, and comes back when the function ended, to
// say what happened (`aside` in the state, the page tells the shell).
//
// Away from a game the window is an ordinary one: minimized, or behind the app in
// use, the shell says so (`behind`), and asking for the menu then brings it
// forward instead of closing what the user cannot see (`front` counts the asks).

const DashboardOpen = require('./js/dashboard-open.js');

const SECTIONS = ['now', 'widgets', 'capture', 'keys', 'look', 'mode'];
// A key or a saved link from before the two widget sections became one.
const RENAMED = Object.freeze({ overlay: 'widgets' });
const CLOSE_FIRST_MS = 300;
const ASK_MAX_CHARS = 2000;

function cleanSection(value) {
  const id = RENAMED[value] || value;
  return SECTIONS.includes(id) ? id : 'now';
}

function createScreenMenu({ host, broadcast, panel, run, failed, delayMs = CLOSE_FIRST_MS, capturing, holding } = {}) {
  let open = false;
  let section = 'now';
  let hidden = false;
  let sheet = null;   // the screen this window opens alone, until it closes
  let ask = '';       // a Deck key's question for the chat that sheet opens, taken once
  let aside = false;  // out of the picture while a one-shot function runs
  let behind = false; // the shell's word: minimized or under another app
  let front = 0;      // how many times the open window was asked to come forward

  function available() {
    return !!(host && typeof host.menus === 'function' && host.menus());
  }

  const extras = () => ({ ...(sheet ? { sheet } : {}), ...(hidden ? { capturing: true } : {}), ...(aside ? { aside: true } : {}), ...(front ? { front } : {}) });

  function push() {
    if (typeof broadcast === 'function') broadcast({ open, section, ...extras() });
  }

  // Open only while a shell can show it: one that quit takes the menu with it.
  function get() {
    return { open: open && available(), section, ...extras() };
  }

  function comeForward() {
    if (open && behind) front += 1;
    behind = false;
  }

  function setBehind(value) {
    behind = open && value === true;
  }

  // → 'screen' (over the main screen), 'dashboard' (panel asked of the open
  // dashboards) or 'closed'.
  function show(next = {}) {
    const wanted = cleanSection(next.section);
    if (available()) {
      if (!open || wanted !== section || sheet || aside || behind) {
        if (!open) hidden = typeof capturing === 'function' && capturing() === true;
        comeForward();
        open = true;
        section = wanted;
        sheet = null;
        aside = false;
        push();
      }
      return 'screen';
    }
    if (typeof panel === 'function') panel({ section: wanted });
    return 'dashboard';
  }

  // Settings, the Store or the gallery alone in the menu's window (a tile's Set
  // up button, Bit), so it never brings the whole dashboard up. 'closed' when no
  // shell can show it: the caller opens the dashboard as before.
  function showSheet(req, question) {
    const clean = DashboardOpen.sheet(req);
    if (!clean || !available()) return 'closed';
    comeForward();
    open = true;
    hidden = false;
    aside = false;
    sheet = clean;
    ask = clean.open === 'chat' && typeof question === 'string' ? question.trim().slice(0, ASK_MAX_CHARS) : '';
    push();
    return 'screen';
  }

  function takeAsk() {
    const taken = ask;
    ask = '';
    return taken;
  }

  function close() {
    if (open) {
      open = false;
      sheet = null;
      aside = false;
      behind = false;
      push();
    }
    return 'closed';
  }

  async function runAction(action) {
    let error = '';
    try {
      const r = await run(action);
      if (!r || r.ok === false) error = (r && r.error) || 'unavailable';
    } catch {
      error = 'unavailable';
    }
    if (error && typeof failed === 'function') failed(error);
  }

  const isAction = (a) => !!a && typeof a === 'object' && !Array.isArray(a) && typeof run === 'function';

  function runSoon(work) {
    const timer = setTimeout(work, delayMs);
    if (timer.unref) timer.unref();
  }

  // A row that closes the menu over the screen. Its page goes with the window,
  // so the action is left here and runs once the menu is off the screen.
  function closeThenRun(action) {
    close();
    if (isAction(action)) runSoon(() => runAction(action));
    return 'closed';
  }

  function comeBack() {
    if (!aside) return;
    aside = false;
    if (open) push();
  }

  // A one-shot row. The window is already hidden by its page (a picture taken now
  // must not catch it); the menu stays open and returns once the action ended.
  function stepAside(action) {
    if (!open || !isAction(action)) return closeThenRun(action);
    aside = true;
    push();
    runSoon(async () => {
      await runAction(action);
      if (!(typeof holding === 'function' && holding())) comeBack();
    });
    return 'aside';
  }

  // The mode it stepped aside for ended. Timed out nobody may be there, or a game may
  // have started: the menu must not come up over it by itself.
  function holdEnded(byHand) {
    if (!aside) return;
    if (byHand) comeBack();
    else close();
  }

  // Back where it was: the key must not cost the user the section they left open.
  function toggle(next = {}) {
    if (!get().open || aside) return show(next);
    if (!behind) return close();
    comeForward();
    push();
    return 'screen';
  }

  return { available, get, show, showSheet, takeAsk, close, closeThenRun, stepAside, holdEnded, toggle, setBehind, isBehind: () => behind };
}

module.exports = { createScreenMenu, SECTIONS, cleanSection };
