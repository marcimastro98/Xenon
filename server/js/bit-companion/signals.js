'use strict';
// What the person's own Bit has to tell, without ever opening text by itself (plan §3, the lesson of
// Clippy): Claude Code or Codex finished or asking, an event in ten minutes, a timer that ended, a disk
// almost full. Each shows as a small sign over every own Bit (signs.js, on the desktop too) and in words
// at the top of its pocket (pocket.js) when the person taps it. A sign stays until it is seen (the pocket
// opened) or grows old; one asking lasts while it asks.
// Kept in localStorage, so the Xenon menu's window, where the desktop Bit's pocket opens, has the same
// ones; each change is told to the page as 'xenon-bit-signals'. Fed by moments.js with the stream's
// events: no poll, no timer.
(() => {
  const KEY = 'xenon.bit.signals';
  const DISK_KEY = 'xenon.bit.diskDay';
  const DISK_FULL = 95;   // percent used
  const MIN = 60000;
  // How long each lasts unseen; ask has no age (it lasts while asking).
  const TTL = Object.freeze({ done: 60 * MIN, soon: 15 * MIN, bell: 10 * MIN, disk: 12 * 60 * MIN });
  const ORDER = Object.freeze(['ask', 'bell', 'soon', 'done', 'disk']);   // the first one shows
  const WHO = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });
  const TEXT_MAX = 80;
  const agents = { claude: null, codex: null };   // source -> Map(session id -> 'running' | 'idle' | 'asks')
  const asking = { claude: false, codex: false };
  const waiting = { claude: new Set(), codex: new Set() };   // sessions that finished and still wait for the person

  const text = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  const store = () => { try { return window.localStorage; } catch { return null; } };

  // Only what this file writes: a kind it knows, a time, and short words.
  function clean(raw) {
    if (!raw || !ORDER.includes(raw.kind) || !Number.isFinite(raw.at)) return null;
    const vars = {};
    for (const [k, v] of Object.entries(raw.vars && typeof raw.vars === 'object' ? raw.vars : {})) vars[k] = text(v);
    return { kind: raw.kind, at: raw.at, vars };
  }

  function read() {
    try {
      const list = JSON.parse(store()?.getItem(KEY) || '[]');
      return Array.isArray(list) ? list.map(clean).filter(Boolean) : [];
    } catch { return []; }
  }

  let list = read();
  const fresh = (s, now) => s.kind === 'ask' || now - s.at < TTL[s.kind];

  // A sign that runs out is taken down then, not at the next piece of news.
  let expiry = 0;
  function watch() {
    if (typeof setTimeout !== 'function') return;
    clearTimeout(expiry);
    const now = Date.now();
    const ends = list.filter((s) => s.kind !== 'ask' && fresh(s, now)).map((s) => s.at + TTL[s.kind] - now);
    if (!ends.length) return;
    expiry = setTimeout(() => { dispatchEvent(new CustomEvent('xenon-bit-signals')); watch(); }, Math.min(...ends) + 50);
  }

  function told() {
    try { store()?.setItem(KEY, JSON.stringify(list)); } catch { /* full or blocked: this page still has them */ }
    dispatchEvent(new CustomEvent('xenon-bit-signals'));
    watch();
  }

  function put(kind, vars) {
    list = list.filter((s) => s.kind !== kind).concat({ kind, at: Date.now(), vars });
    told();
  }

  function drop(kinds) {
    const next = list.filter((s) => !kinds.includes(s.kind));
    if (next.length !== list.length) { list = next; told(); }
  }

  /** The signs to show now, the most pressing first. */
  function all(now = Date.now()) {
    return list.filter((s) => fresh(s, now)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  }

  // Claude Code and Codex, read as moments.js reads them: any session waiting asks; a session that went
  // from running to idle finished, unless it was closed or its sub-agents still work (the turn paused for
  // them). The flag stays only while a session that finished still waits: back at work, it comes down.
  const agentState = (s) => (s.waitFor || s.state === 'waiting' ? 'asks' : s.state === 'running' ? 'running' : 'idle');
  const helping = (s) => Array.isArray(s.subagents) && s.subagents.some((a) => a && a.status === 'running');
  const resting = (s) => agentState(s) === 'idle' && !s.ended && !helping(s);
  // Whether the source that raised the flag has been heard by this page (Codex may never be linked).
  const heardWho = () => {
    const who = list.find((s) => s.kind === 'done')?.vars.who;
    const source = Object.keys(WHO).find((k) => WHO[k] === who);
    return !source || agents[source] !== null;
  };
  function agent(source, d) {
    const sessions = Array.isArray(d.live?.sessions) ? d.live.sessions.filter((s) => s && s.id != null) : null;
    if (!sessions) return;
    const before = agents[source];
    agents[source] = new Map(sessions.map((s) => [String(s.id), agentState(s)]));
    asking[source] = sessions.some((s) => agentState(s) === 'asks');
    if (asking[source] && !list.some((s) => s.kind === 'ask')) put('ask', { who: WHO[source] });
    else if (!asking.claude && !asking.codex) drop(['ask']);
    const finished = before ? sessions.filter((s) => before.get(String(s.id)) === 'running' && resting(s)) : [];
    // A page opened after the flag went up does not know which session raised it: the ones resting now.
    const known = before ? waiting[source] : new Set(list.some((s) => s.kind === 'done') ? sessions.filter(resting).map((s) => String(s.id)) : []);
    const still = new Set(sessions.filter((s) => resting(s) && known.has(String(s.id))).map((s) => String(s.id)));
    for (const s of finished) still.add(String(s.id));
    waiting[source] = still;
    if (finished.length) put('done', { who: WHO[source] });
    else if (!waiting.claude.size && !waiting.codex.size && heardWho()) drop(['done']);
  }

  // A disk this full is told once a day, the fullest one.
  function system(d) {
    const rows = (Array.isArray(d.disks) ? d.disks : []).filter((r) => r && Number(r.percent) >= DISK_FULL);
    if (!rows.length) return;
    const day = new Date().toDateString();
    try { if (store()?.getItem(DISK_KEY) === day) return; store()?.setItem(DISK_KEY, day); } catch { return; }
    const top = rows.reduce((a, b) => (Number(b.percent) > Number(a.percent) ? b : a));
    put('disk', { drive: text(top.drive || top.label), pct: String(Math.round(Number(top.percent))) });
  }

  const HANDLERS = {
    claude: (d) => agent('claude', d),
    codex: (d) => agent('codex', d),
    calendar_reminder: (d) => put('soon', { title: text(d.title) }),
    timer_done: (d) => put('bell', { label: text(d.label) }),
    system,
  };

  /** One event of the stream, as it came (moments.js hands them over). */
  function heard(name, raw) {
    const fn = HANDLERS[name];
    if (!fn) return;
    let d = null;
    try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
    if (d && typeof d === 'object') fn(d);
  }

  // Another window of Xenon saw them or heard a new one.
  addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    list = read();
    dispatchEvent(new CustomEvent('xenon-bit-signals'));
    watch();
  });
  watch();

  window.BitSignals = Object.freeze({
    heard, all, top: () => all()[0] || null,
    /** The pocket opened: what it showed is seen; one asking stays while it asks. */
    seen: () => drop(['done', 'soon', 'bell', 'disk']),
  });
})();
