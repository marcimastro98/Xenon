// What a widget sees of a pulled stream's answer: the server's reply rebuilt field by field, so
// whatever else the server may add later never reaches a sandboxed frame. Pure functions of the
// reply (custom-widget.js fetches it); a reply that is not a success becomes `{ ok: false, error }`.
'use strict';

(() => {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const one = (v, list) => (list.includes(v) ? v : null);

  // How the way to the internet is doing, stretch by stretch (server/net-path/, GET /api/net-path):
  // the link, the router, the provider's first hop, the internet.
  function netPath(d) {
    if (!d || typeof d !== 'object' || d.ok !== true) {
      return { ok: false, error: d && (d.error === 'not_granted' || d.error === 'unavailable') ? d.error : 'failed' };
    }
    const stretch = (s) => (s && typeof s === 'object' ? {
      now: num(s.now), ms: num(s.ms), min: num(s.min), jitter: num(s.jitter),
      loss: num(s.loss), lossNow: num(s.lossNow), n: num(s.n) || 0,
    } : null);
    const t = d.traffic && typeof d.traffic === 'object' ? d.traffic : null;
    return {
      ok: true,
      link: one(d.link, ['wifi', 'wired', 'mobile', 'vpn']),
      linkMbps: num(d.linkMbps), signal: num(d.signal), dbm: num(d.dbm),
      router: stretch(d.router), provider: stretch(d.provider), internet: stretch(d.internet),
      traffic: t ? { downBps: num(t.downBps), upBps: num(t.upBps) } : null,
    };
  }

  // How the fans are (server/airflow/, GET /airflow): the state, the mode, the reason and every
  // fan with its speed and who drives it. Nothing in it sets a speed: the `fans` actions change
  // the mode only.
  const AIRFLOW_STATES = ['checking', 'unavailable', 'off', 'watching', 'pc', 'driving'];
  const AIRFLOW_MODES = ['auto', 'quiet', 'balanced', 'cool', 'pc'];
  const MAX_FANS = 32;

  function airflow(d) {
    if (!d || typeof d !== 'object' || d.ok !== true) {
      return { ok: false, error: d && d.error === 'unavailable' ? 'unavailable' : 'failed' };
    }
    const whole = (v) => (num(v) != null && v >= 0 ? Math.round(v) : null);
    const code = (v) => (typeof v === 'string' && /^[a-z][a-z-]{0,23}$/.test(v) ? v : null);
    const fans = (Array.isArray(d.fans) ? d.fans : []).slice(0, MAX_FANS).filter((f) => f && typeof f === 'object').map((f) => ({
      id: typeof f.id === 'string' ? f.id.slice(0, 96) : '',
      name: typeof f.name === 'string' ? f.name.slice(0, 48) : '',
      kind: one(f.kind, ['fan', 'pump']) || 'fan',
      place: code(f.place), rpm: whole(f.rpm), duty: whole(f.duty),
      xenon: f.xenon === true, leave: f.leave === true, why: code(f.why),
    }));
    const check = d.check && typeof d.check === 'object' ? d.check : null;
    const db = d.shadow && typeof d.shadow === 'object' ? num(d.shadow.quieterDb) : null;
    return {
      ok: true,
      state: one(d.state, AIRFLOW_STATES),
      drive: one(d.drive, ['off', 'shadow', 'on']),
      mode: one(d.mode, AIRFLOW_MODES),
      why: code(d.why),
      fans,
      check: check ? { progress: Math.min(1, Math.max(0, Number(check.progress) || 0)) } : null,
      quieterDb: db == null ? null : Math.round(db * 10) / 10,
    };
  }

  // The person's own Bit (server/bit/, GET /api/bit): what a widget draws it from with the Bit
  // kit (docs/create/bit-kit.js), its genes without the seed, and the last move it played on the
  // dashboard. Never what it learned about the person (traits, days), or what it owns.
  const BIT_STAGES = ['egg', 'baby', 'young', 'adult', 'veteran', 'legend'];
  const GENES = ['palette', 'pattern', 'patternColor', 'tip', 'eyes', 'cheeks', 'temperament', 'quirk', 'voice'];
  const ID = /^[a-z][a-zA-Z0-9-]{0,31}$/;

  function bit(d, played) {
    if (!d || typeof d !== 'object' || d.ok !== true) return { ok: false, error: 'failed' };
    const g = d.genes && typeof d.genes === 'object' ? d.genes : null;
    if (d.hatched !== true || !g || GENES.some((k) => !ID.test(g[k]))) return { ok: true, hatched: false, stage: 'egg' };
    const move = played && typeof played === 'object' && ID.test(played.clip) && num(played.at) != null ? played : null;
    return {
      ok: true,
      hatched: true,
      stage: one(d.stage, BIT_STAGES) || 'baby',
      name: typeof d.name === 'string' ? d.name.slice(0, 24) : '',
      number: Number.isSafeInteger(d.number) && d.number > 0 ? d.number : null,
      founder: d.founder === true,
      // False when the person chose the classic Bit for the rest of the app (the Bit sheet).
      everywhere: d.everywhere !== false,
      genes: { classic: g.classic === true, shiny: g.shiny === true, ...Object.fromEntries(GENES.map((k) => [k, g[k]])) },
      worn: (Array.isArray(d.worn) ? d.worn : []).filter((id) => ID.test(id)).slice(0, 8),
      played: move ? { clip: move.clip, at: move.at } : null,
    };
  }

  window.CustomWidgetStreamReaders = { netPath, airflow, bit };
})();
