'use strict';
// "Only while I listen to music": the rule of a widget or a page as a row of the Xenon
// menu, and the words it leaves on the widget's line. js/xenon-menu-when.js draws it. Pure.

const LayerWhen = require('./js/layer-when.js');
const { k } = require('./menu-rows.js');

// The everyday ones first: a person reads this list once, from the top.
const ORDER = Object.freeze(['game', 'music', 'live', 'recording', 'call', 'app', 'appOpen', 'timer', 'dnd', 'busy', 'idle', 'battery', 'time']);

const label = (c) => k('xmenu_sit_' + c);

// What this PC cannot tell: the situation goes away and one line says why.
function unreadable(st) {
  const probes = st.probes || {};
  const gone = new Map();
  if (!probes.situationCall) gone.set('call', 'xmenu_when_why_call');
  if (!probes.situationFront) {
    gone.set('app', 'xmenu_when_why_front');
    gone.set('appOpen', 'xmenu_when_why_front');
  }
  // A desktop PC has no battery and nobody looks for one: gone, with nothing to explain.
  if (!(st.power && st.power.battery)) gone.set('battery', '');
  return gone;
}

function whenRow(id, rule, set, st, page) {
  const gone = unreadable(st);
  const inRule = new Set((rule ? rule.any : []).map((r) => r.c));
  // A rule brought from another PC stays in sight, or it could never be taken away.
  const shown = ORDER.filter((c) => !gone.has(c) || inRule.has(c));
  const hidden = ORDER.filter((c) => !shown.includes(c)).map((c) => gone.get(c));
  return {
    kind: 'when', id, label: k('xmenu_when'), rule, set,
    situations: shown.map((c) => ({ c, label: label(c) })),
    missing: [...new Set(hidden)].filter(Boolean).map((why) => k(why)),
    ...(page ? { page: true } : {}),
  };
}

const widgetRule = (w) => w.when || LayerWhen.fromShow(w.show);

function widgetWhenRow(id, box, st) {
  return whenRow(id, widgetRule(box), { type: 'layerMove', target: box.id }, st, false);
}

const pageRule = (pg) => pg.when || (pg.gaming ? LayerWhen.fromShow('gaming') : null);

function pageWhenRow(pg, st) {
  return whenRow('pageWhen', pageRule(pg), { type: 'layerPageEdit', mode: 'when', page: pg.id }, st, true);
}

const named = (r) => (r.app ? { text: LayerWhen.appName(r.app) } : label(r.c));

// The widget's line in the list: nothing for "always".
function whenFact(w) {
  const rule = widgetRule(w);
  if (!rule) return [];
  const show = LayerWhen.toShow(rule);
  if (show) return [k('xmenu_when_' + show)];
  const what = rule.any.length > 1 ? k('xmenu_when_many', { n: rule.any.length }) : named(rule.any[0]);
  return [{ pair: [k(rule.hide ? 'xmenu_when_hide' : 'xmenu_when_only'), what] }];
}

// The line under a page's name: who brings it to the screen.
function pageFact(pg) {
  const rule = pageRule(pg);
  if (!rule) return [k('xmenu_page_by_hand')];
  return [{ pair: [k('xmenu_page_by_itself'), rule.any.length > 1 ? k('xmenu_when_many', { n: rule.any.length }) : named(rule.any[0])] }];
}

module.exports = { widgetWhenRow, pageWhenRow, whenFact, pageFact };
