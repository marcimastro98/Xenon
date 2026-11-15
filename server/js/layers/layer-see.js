'use strict';

// "When do you see it?": the one question a person answers about a widget. The answer
// is read from what is stored (surface, show, when) and written back onto it: nothing
// new is saved, and a mix the answers cannot say stays as it is, shown as "custom".
(function (root, factory) {
  const api = factory(root && root.LayerWhen ? root.LayerWhen : typeof require === 'function' ? require('./layer-when.js') : null);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayerSee = api;
})(typeof window !== 'undefined' ? window : globalThis, function (LayerWhen) {
  const CHOICES = Object.freeze(['always', 'desktop', 'game', 'app']);
  // The filter over the map: "now" is what the screen shows at this moment.
  const VIEWS = Object.freeze(['now', 'always', 'game', 'app', 'desktop']);
  // The list is split by the answer, in this order.
  const GROUPS = Object.freeze(['always', 'game', 'app', 'desktop', 'other']);

  const ruleOf = (w) => w.when || LayerWhen.fromShow(w.show);

  function seeOf(w) {
    if (w.surface === 'anchor') return 'app';
    const rule = ruleOf(w);
    if (!rule) return w.surface === 'desktop' ? 'desktop' : 'always';
    if (LayerWhen.toShow(rule) === 'gaming') return w.surface === 'overlay' ? 'game' : 'custom';
    return 'other';
  }

  // The words for an answer, as a string key or plain text: the tag on a frame, the line
  // in the menu. "Other" names the situation; more than one, or "not while", is custom.
  function labelOf(w) {
    const see = seeOf(w);
    if (see === 'app') return w.anchor ? { key: 'see_on_app', vars: { app: LayerWhen.appName(w.anchor.app) } } : { key: 'see_app' };
    if (see !== 'other') return { key: 'see_' + see };
    const rule = ruleOf(w);
    if (rule.hide) return { key: 'see_custom' };
    if (rule.any.length > 1) return { key: 'xmenu_when_many', vars: { n: rule.any.length } };
    const [one] = rule.any;
    return one.app ? { text: LayerWhen.appName(one.app) } : { key: 'xmenu_sit_' + one.c };
  }

  // The change that gives a widget this answer. "app" asks which one first, so it has none.
  function changeFor(see) {
    if (see === 'always') return { surface: 'overlay', show: 'always' };
    if (see === 'desktop') return { surface: 'desktop', show: 'always' };
    if (see === 'game') return { surface: 'overlay', show: 'gaming' };
    return null;
  }

  // The sizes it can take, small to large: the words over a game grow with their box,
  // and a pin or a Deck key has one size of its own.
  function sizesOf(w) {
    if (w.widget === 'pin' || w.widget === 'key') return [];
    return w.widget === 'perf' && w.surface === 'overlay' ? ['hud', 'small', 'medium'] : ['small', 'medium', 'large'];
  }

  // The group of the list it goes under: a mix sits with the other situations.
  function groupOf(w) {
    const see = seeOf(w);
    return see === 'custom' ? 'other' : see;
  }

  // Whether a widget is seen in a view of the map: "always" is there in every situation.
  function inView(w, view, shownNow) {
    if (view === 'now') return shownNow;
    const see = seeOf(w);
    return see === view || see === 'always';
  }

  // What a new widget starts as: the readings are for a game, the player for music.
  function firstFor(widget) {
    if (widget === 'perf') return { surface: 'overlay', show: 'gaming' };
    if (widget === 'media') return { surface: 'overlay', when: 'music' };
    return { surface: 'overlay', show: 'always' };
  }

  // The words for what a new widget starts as, for the card that adds it.
  function firstLabel(widget) {
    const first = firstFor(widget);
    return labelOf({ ...first, when: first.when ? LayerWhen.parse(first.when) : undefined });
  }

  return Object.freeze({ CHOICES, VIEWS, GROUPS, seeOf, groupOf, labelOf, sizesOf, changeFor, inView, firstFor, firstLabel });
});
