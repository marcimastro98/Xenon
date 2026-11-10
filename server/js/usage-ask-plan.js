'use strict';

// What the first question offers on this PC and what an answer does. Pure, so the dialog
// (js/usage-ask.js) and the tests read the same rules. A display is the shell's own:
// { id, name, width, height, x, y, primary, edge }.
(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = node
    ? factory(require('./usage-mode.js'), require('./screen-name.js'))
    : factory(root.UsageMode, root.ScreenName);
  if (node) module.exports = api;
  if (root) root.UsageAskPlan = api;
})(typeof window !== 'undefined' ? window : globalThis, function (UsageMode, ScreenName) {
  const PHONE = 'phone';
  // Someone who asks for widgets has to see widgets, and a new install has none. They go
  // behind the apps, where a desktop widget lives, so none covers what the person is doing.
  const STARTERS = Object.freeze(['weather', 'media', 'system']);
  const SPOT = Object.freeze({ surface: 'desktop', position: 'top-right', size: 'medium' });

  const several = (list) => list.length >= 2;
  const mainOf = (list) => list.find((d) => d.primary) || list[0] || null;
  const showsDashboard = (mode) => mode === 'both' || mode === 'dashboard';

  function advice(list) {
    return UsageMode.recommended({ screens: list.length, edge: list.some((d) => d.edge) });
  }

  // The recommended answer first. With one screen the way to give the dashboard a place of
  // its own is a phone, so the phone takes the third row.
  function cards(list) {
    const modes = several(list) ? ['both', 'widgets', 'dashboard'] : ['widgets', 'dashboard', PHONE];
    const first = advice(list);
    return [first, ...modes.filter((m) => m !== first)];
  }

  // Where the dashboard goes unless the person taps another screen: the Edge, made for it,
  // else a screen it can have to itself. A display with no id can never be remembered.
  function dashScreen(list) {
    const all = list.filter((d) => d.id);
    const pick = all.find((d) => d.edge) || all.find((d) => !d.primary) || all[0];
    return pick ? pick.id : '';
  }

  // Where the widgets go: the main screen, or the next one when the dashboard took it.
  function deskScreen(list, dashId) {
    const main = mainOf(list);
    if (!main) return '';
    if (main.id !== dashId) return main.id;
    const other = list.find((d) => d.id && d.id !== dashId);
    return other ? other.id : main.id;
  }

  // The screen the dashboard takes for this answer. With one screen it takes none: it is a
  // window there, and the shell needs no place.
  const dashOf = (mode, list, dash) => (showsDashboard(mode) && several(list) ? dash : '');

  // What each screen shows with this answer, in the order of the list.
  function scene({ mode, list, dash }) {
    const placed = dashOf(mode, list, dash);
    const desk = deskScreen(list, placed);
    return list.map((d) => {
      if (mode === 'dashboard' && !several(list)) return 'window';
      if (placed && d.id === placed) return 'dash';
      return mode !== 'dashboard' && d.id === desk ? 'widgets' : 'plain';
    });
  }

  // The answer in the words of the app: usageMode, and the choice of screen. The phone is
  // recorded as 'both' and nothing on this PC moves (see choosePhone in surface-picker.js).
  function answer({ mode, list, dash }) {
    const phone = mode === PHONE;
    const screen = list.find((d) => d.id && d.id === dashOf(mode, list, dash)) || null;
    const surface = screen
      ? { kind: 'screen', monitor: screen.id, label: screen.label || '' }
      : { kind: phone ? 'both' : 'auto', monitor: '', label: '' };
    const dashId = screen ? screen.id : '';
    return { usage: phone ? 'both' : mode, phone, dash: dashId, desk: deskScreen(list, dashId), surface };
  }

  // The first widgets, as the actions the server runs. No monitor means the main screen.
  function starters(plan, list) {
    if (plan.usage === 'dashboard') return [];
    const main = mainOf(list);
    const there = main && plan.desk && plan.desk !== main.id ? { monitor: plan.desk } : {};
    return STARTERS.map((widget) => ({ type: 'layerPlace', widget, ...SPOT, ...there }));
  }

  function nameOf(display, list) {
    const { name, size } = ScreenName.screenName(display, list);
    return name || size;
  }

  return Object.freeze({ PHONE, several, advice, cards, dashScreen, deskScreen, scene, answer, starters, nameOf });
});
