'use strict';

// When a widget or a page shows: a person's "only while I listen to music" or "not
// while I stream". One owner for the rule, read by the settings normalizer, the
// capabilities, the menu and the tests.
//
//   { hide?: true, any: [{ c: 'music' }, { c: 'app', app: 'obs64' }, ...] }
//
// One situation is enough, there is no "all of them": a person reads "when I play or
// stream" at a glance, and a mix of and/or is a programming job. Without `hide` the
// thing shows only then, with it the thing goes away then.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LayerWhen = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // Plain ones are a yes or a no; the others carry a value the person picks.
  const PLAIN = Object.freeze(['game', 'music', 'live', 'recording', 'call', 'timer', 'dnd', 'busy', 'idle']);
  const SITUATIONS = Object.freeze([...PLAIN, 'app', 'appOpen', 'battery', 'time']);
  const MAX_RULES = 8;
  const APP_MAX = 64;
  const BATTERY_LEVELS = Object.freeze([10, 20, 30, 50]);
  const EVERY_DAY = Object.freeze([0, 1, 2, 3, 4, 5, 6]);
  const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  const APP_RE = /^[\p{L}\p{N} ._+()-]+$/u;

  const appKey = (name) => String(name == null ? '' : name).trim().toLowerCase().replace(/\.(exe|app)$/, '').slice(0, APP_MAX);
  // A process name read as a name: "chrome" says Chrome. Only for the words on screen:
  // rules and anchors keep the real one, which is what windows are matched against.
  const appName = (name) => { const s = String(name == null ? '' : name); return s.charAt(0).toUpperCase() + s.slice(1); };
  const minutesOf = (hhmm) => {
    const m = TIME_RE.exec(String(hhmm || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const clock = (mins) => String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0');

  function cleanDays(raw) {
    const days = [...new Set((Array.isArray(raw) ? raw : []).map(Number))].filter((d) => EVERY_DAY.includes(d)).sort();
    return days.length && days.length < EVERY_DAY.length ? days : null;
  }

  function normalizeTime(raw) {
    const from = minutesOf(raw.from);
    const to = minutesOf(raw.to);
    if (from < 0 || to < 0 || from === to) return null;
    const days = cleanDays(raw.days);
    return { c: 'time', from: clock(from), to: clock(to), ...(days ? { days } : {}) };
  }

  function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (PLAIN.includes(raw.c)) return { c: raw.c };
    if (raw.c === 'app' || raw.c === 'appOpen') {
      const app = appKey(raw.app);
      return app && APP_RE.test(app) ? { c: raw.c, app } : null;
    }
    if (raw.c === 'battery') return { c: 'battery', below: BATTERY_LEVELS.includes(Number(raw.below)) ? Number(raw.below) : 20 };
    return raw.c === 'time' ? normalizeTime(raw) : null;
  }

  const ruleKey = (r) => (r.c === 'app' || r.c === 'appOpen' ? r.c + ':' + r.app : r.c);

  // Null means always: an empty rule must never hide anything. The same situation twice
  // keeps the first; a time span is one per widget, the row edits it in place.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.any)) return null;
    const seen = new Set();
    const any = [];
    for (const r of raw.any) {
      if (any.length >= MAX_RULES) break;
      const rule = normalizeRule(r);
      if (!rule || seen.has(ruleKey(rule))) continue;
      seen.add(ruleKey(rule));
      any.push(rule);
    }
    if (!any.length) return null;
    return raw.hide === true ? { hide: true, any } : { any };
  }

  // A span past midnight belongs to the day it started on.
  function inTime(rule, now) {
    const from = minutesOf(rule.from);
    const to = minutesOf(rule.to);
    const wrap = from > to;
    const inside = wrap ? now.minutes >= from || now.minutes < to : now.minutes >= from && now.minutes < to;
    if (!inside || !rule.days) return inside;
    const started = wrap && now.minutes < to ? (now.day + 6) % 7 : now.day;
    return rule.days.includes(started);
  }

  function ruleHolds(rule, facts) {
    if (rule.c === 'app') return facts.front === rule.app;
    if (rule.c === 'appOpen') return Array.isArray(facts.open) && facts.open.includes(rule.app);
    if (rule.c === 'battery') {
      const b = facts.battery;
      return !!b && !b.plugged && Number.isFinite(b.percent) && b.percent <= rule.below;
    }
    if (rule.c === 'time') return !!facts.now && inTime(rule, facts.now);
    return facts[rule.c] === true;
  }

  // Whether something under this rule shows, given the facts of the moment.
  function shows(when, facts) {
    if (!when) return true;
    const met = when.any.some((r) => ruleHolds(r, facts || {}));
    return when.hide ? !met : met;
  }

  // The facts a set of rules asks for, so nothing else is read.
  function factsNeeded(rules) {
    const need = new Set();
    for (const when of rules) {
      for (const r of (when && when.any) || []) need.add(r.c === 'app' ? 'front' : r.c === 'appOpen' ? 'open' : r.c === 'time' ? 'now' : r.c);
    }
    return need;
  }

  // The old "show" setting said the same thing about games: a rule that only speaks of
  // games goes back to it, so that case stays on the instant path that needs no server.
  function fromShow(show) {
    if (show === 'gaming') return { any: [{ c: 'game' }] };
    if (show === 'notGaming') return { hide: true, any: [{ c: 'game' }] };
    return null;
  }
  function toShow(when) {
    if (!when) return 'always';
    if (when.any.length !== 1 || when.any[0].c !== 'game') return null;
    return when.hide ? 'notGaming' : 'gaming';
  }

  function ruleText(r) {
    if (r.c === 'app' || r.c === 'appOpen') return r.c + ':' + r.app;
    if (r.c === 'battery') return 'battery:' + r.below;
    if (r.c === 'time') return 'time:' + r.from + '-' + r.to + (r.days ? ':' + r.days.join('') : '');
    return r.c;
  }

  function parseRule(word) {
    const [c, ...rest] = word.split(':');
    const value = rest.join(':');
    if (c === 'app' || c === 'appOpen') return { c, app: value };
    if (c === 'battery') return { c, below: value };
    if (c !== 'time') return { c };
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})(?::([0-6]{1,7}))?$/.exec(value);
    return m ? { c, from: m[1], to: m[2], days: m[3] ? [...m[3]].map(Number) : undefined } : null;
  }

  // The text form a Deck key, a menu button and Bit all use: "music, app:obs64", with
  // "hide:" in front to take the thing away instead. Undefined when a word is not a
  // situation, so a typo is an error and never a rule that hides a widget.
  function parse(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw || raw === 'always') return null;
    const hide = /^hide\s*:/.test(raw);
    const words = raw.replace(/^hide\s*:/, '').split(',').map((w) => w.trim()).filter(Boolean);
    const when = normalize({ hide, any: words.map(parseRule) });
    return when && when.any.length === words.length ? when : undefined;
  }

  function format(when) {
    if (!when) return 'always';
    return (when.hide ? 'hide:' : '') + when.any.map(ruleText).join(',');
  }

  return Object.freeze({
    PLAIN, SITUATIONS, MAX_RULES, BATTERY_LEVELS, EVERY_DAY, appKey, appName,
    normalize, shows, factsNeeded, fromShow, toShow, parse, format,
  });
});
