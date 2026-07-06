'use strict';
// Claude Code usage widget — "Xenon Pulse". A living reactor whose core is tinted
// to the model currently running (Opus = clay, Fable = violet, Sonnet = teal,
// Haiku = green — the colour encodes which brain is working), whose ring gauges
// the weekly budget remaining (or, with no budget set, the week's energy against
// its own recent peak), with particles streaming from your active project into
// the core and a pulse while Claude is live. Around it: quiet, tabular readouts —
// today, this week, cache-efficiency and the equivalent API value — plus a
// cache-vs-fresh daily series, a per-project split and a per-model split.
//
// Data source is LOCAL: the server reads ~/.claude transcripts (no key, no
// network) and pushes an aggregate over SSE ('claude' → onSSE), seeded once on
// mount (GET /api/claude). There is no official Anthropic API for a plan's
// remaining quota, so the "remaining" ceiling is whatever budget the user sets
// (Settings → Xenon AI); until then the reactor runs in energy mode. All
// project/model strings render through textContent (they come off the filesystem).
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let payload = null;       // { usage, budget, tile } — null until seeded
  let seeded = false, seedInflight = false;
  let editing = false;      // budget editor open?
  let customOpen = false;   // custom-budget input revealed inside the editor
  const anims = [];         // live reactor controllers → torn down on every repaint
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="claude"]')).filter(n => n.closest('.pager-page'));
  }

  // ── model → hue. Encodes which model produced the work, not decoration. ──
  const MODEL_COLORS = Object.freeze({ opus: '#D97757', fable: '#A98BE0', mythos: '#A98BE0', sonnet: '#3FB9C4', haiku: '#79C267' });
  function modelHue(model) {
    const m = String(model || '');
    for (const key in MODEL_COLORS) if (m.indexOf('claude-' + key) === 0 || m.indexOf(key) === 0) return MODEL_COLORS[key];
    return 'var(--accent)';
  }
  // Concrete rgb for canvas (canvas can't read CSS vars); falls back to accent-rgb.
  function hueRgb(model) {
    const hex = modelHue(model);
    if (hex.charAt(0) === '#') {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim();
    const p = v.split(',').map(s => parseInt(s, 10));
    return (p.length === 3 && p.every(Number.isFinite)) ? p : [217, 119, 87];
  }
  function shortModel(model) {
    return String(model || '').replace(/^claude-/, '').replace(/-\d{6,}$/, '') || 'unknown';
  }

  // ── formatting ──
  function hTok(n) {
    n = Math.max(0, Math.round(n || 0));
    if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e11 ? 0 : 2).replace(/\.0+$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }
  function hCost(n) {
    n = Math.max(0, n || 0);
    if (n >= 1000) return '$' + Math.round(n).toLocaleString();
    if (n >= 10) return '$' + n.toFixed(0);
    return '$' + n.toFixed(n >= 1 ? 1 : 2);
  }
  function ago(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + 's';
    const m = Math.round(s / 60); if (m < 60) return m + 'm';
    const h = Math.round(m / 60); if (h < 24) return h + 'h';
    return Math.round(h / 24) + 'g';
  }

  // ── the fill fraction the reactor gauges ──
  // Budget set → remaining/budget (a fuel cell that depletes). No budget → the
  // week's tokens against its own recent peak (energy that charges up). Each mode
  // labels its centre so the ring is never ambiguous.
  function maxRolling7(daily) {
    let best = 0, run = 0;
    for (let i = 0; i < daily.length; i++) {
      run += daily[i].tokens;
      if (i >= 7) run -= daily[i - 7].tokens;
      if (run > best) best = run;
    }
    return best;
  }
  function reactorState() {
    const u = payload && payload.usage;
    const b = payload && payload.budget;
    const week = u ? u.week.tokens : 0;
    const weekly = b ? b.weekly : 0;
    if (weekly > 0) {
      const remaining = Math.max(0, weekly - week);
      const frac = Math.max(0, Math.min(1, remaining / weekly));
      return {
        mode: 'budget', frac,
        big: Math.round(frac * 100) + '%',
        label: t('claude_remaining', 'remaining'),
        sub: hTok(remaining) + ' / ' + hTok(weekly),
        over: week > weekly,
      };
    }
    const ref = Math.max(week, u ? maxRolling7(u.daily) : 0, 1);
    return {
      mode: 'energy', frac: Math.max(0.04, Math.min(1, week / ref)),
      big: hTok(week),
      label: t('claude_this_week', 'this week'),
      sub: t('claude_set_budget', 'set a budget →'),
      over: false,
    };
  }

  // ── the reactor (canvas) ──────────────────────────────────────────────────
  // Animation cost is deliberately bounded: it runs at ~30fps, only while the
  // tile is on screen, and it FREEZES to a static frame the moment the dashboard
  // goes idle (body.ambient-idle) or the tab hides — the same signal the animated
  // background uses, so on a hybrid-GPU machine the reactor stops copying frames
  // to the Edge when nobody's watching. reduced-motion → a single static frame.
  const WAKE_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];
  let wakeInstalled = false;
  function bodyIdle() { return document.hidden || document.body.classList.contains('ambient-idle'); }
  function installWake() {
    if (wakeInstalled) return; wakeInstalled = true;
    const resume = () => { if (reduceMotion || bodyIdle()) return; for (const a of anims) { if (a.frozen && a.visible && a.frame) { a.frozen = false; a.raf = requestAnimationFrame(a.frame); } } };
    for (const ev of WAKE_EVENTS) window.addEventListener(ev, resume, { passive: true });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resume(); });
  }

  function reactor(streams, coreRgb, state, live) {
    const box = el('div', 'cw-reactor');
    const canvas = el('canvas', 'cw-reactor-canvas');
    box.appendChild(canvas);

    // Centre overlay (crisp DOM text over the canvas).
    const centre = el('div', 'cw-reactor-centre');
    if (live && live.active) {
      const dot = el('span', 'cw-reactor-live');
      if (live.count > 1) dot.appendChild(el('span', 'cw-reactor-livecount', String(live.count)));
      centre.appendChild(dot);
    }
    centre.appendChild(el('div', 'cw-reactor-big' + (state.over ? ' is-over' : '') + (state.spark ? ' cw-reactor-big--spark' : ''), state.big));
    centre.appendChild(el('div', 'cw-reactor-label', state.label));
    if (state.sub) centre.appendChild(el('div', 'cw-reactor-sub', state.sub));
    box.appendChild(centre);

    // The whole reactor is a big touch target that opens the budget chooser.
    const hit = el('button', 'cw-reactor-hit'); hit.type = 'button';
    hit.setAttribute('aria-label', t('claude_budget_edit', 'Set weekly budget'));
    hit.addEventListener('click', openBudget);
    box.appendChild(hit);

    startReactor(canvas, streams, coreRgb, state);
    return box;
  }

  // Torn down (rAF cancelled, observer disconnected) on every repaint so nothing
  // leaks. Particles are coloured per concurrent session, so several instances
  // feeding the core show as several colours streaming in.
  function startReactor(canvas, streams, coreRgb, state) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    installWake();
    const ctrl = { canvas, raf: 0, io: null, visible: true, frozen: false, particles: [], lastDraw: 0, frame: null, w: 0, h: 0, dpr: 0 };
    anims.push(ctrl);

    const cols = (streams && streams.length) ? streams : [coreRgb];
    const N = 28;
    for (let i = 0; i < N; i++) {
      ctrl.particles.push({ a: Math.random() * Math.PI * 2, r: 0.48 + Math.random() * 0.62, sp: 0.0016 + Math.random() * 0.003, sz: 0.8 + Math.random() * 1.2, col: cols[i % cols.length] });
    }

    function size() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth || 160, h = canvas.clientHeight || 160;
      // Assigning canvas.width reallocates the backing store (and clears the
      // canvas) even when unchanged — only touch it when the box resized.
      if (w !== ctrl.w || h !== ctrl.h || dpr !== ctrl.dpr) {
        ctrl.w = w; ctrl.h = h; ctrl.dpr = dpr;
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      return { w, h };
    }

    function draw(now, animated) {
      const { w, h } = size();
      const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 6;
      ctx.clearRect(0, 0, w, h);
      const [cr, cg, cb] = coreRgb;
      const live = payload && payload.usage && payload.usage.live && payload.usage.live.active;
      const speed = animated ? (live ? 1.5 : 0.65) : 0;
      const coreR = R * 0.5;

      // outer glow halo
      const halo = ctx.createRadialGradient(cx, cy, coreR * 0.6, cx, cy, R);
      halo.addColorStop(0, `rgba(${cr},${cg},${cb},0)`);
      halo.addColorStop(0.72, `rgba(${cr},${cg},${cb},0.06)`);
      halo.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();

      // particles streaming inward — each carries its session's model colour
      for (const p of ctrl.particles) {
        if (speed) { p.r -= p.sp * speed * 16; if (p.r < 0.46) { p.r = 1.02; p.a = Math.random() * Math.PI * 2; } }
        const rad = p.r * R, x = cx + Math.cos(p.a) * rad, y = cy + Math.sin(p.a) * rad;
        const fade = Math.max(0, Math.min(1, (p.r - 0.46) / 0.56));
        const [pr, pg, pb] = p.col;
        ctx.beginPath(); ctx.arc(x, y, p.sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${pr},${pg},${pb},${0.08 + fade * 0.55})`; ctx.fill();
      }

      // plasma core: hot white centre → model colour, gently breathing
      const pulse = animated ? (0.82 + Math.sin(now / (live ? 440 : 900)) * 0.07) : 0.86;
      const grad = ctx.createRadialGradient(cx, cy, 1, cx, cy, coreR);
      grad.addColorStop(0, `rgba(255,255,255,${0.5 * pulse})`);
      grad.addColorStop(0.28, `rgba(${cr},${cg},${cb},${0.95 * pulse})`);
      grad.addColorStop(0.7, `rgba(${cr},${cg},${cb},${0.3 * pulse})`);
      grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fillStyle = grad; ctx.fill();

      // slow rotating conic shimmer over the core
      if (animated && ctx.createConicGradient) {
        const con = ctx.createConicGradient((now / 2600) % (Math.PI * 2), cx, cy);
        con.addColorStop(0, 'rgba(255,255,255,0)');
        con.addColorStop(0.07, 'rgba(255,255,255,0.16)');
        con.addColorStop(0.15, 'rgba(255,255,255,0)');
        con.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.save(); ctx.globalCompositeOperation = 'overlay';
        ctx.beginPath(); ctx.arc(cx, cy, coreR, 0, Math.PI * 2); ctx.fillStyle = con; ctx.fill(); ctx.restore();
      }

      // gauge ring: track + progress arc with a glowing cap
      const start = -Math.PI / 2, end = start + Math.PI * 2 * state.frac;
      const lw = Math.max(3, R * 0.1);
      ctx.lineWidth = lw; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(cx, cy, R - lw / 2, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.12)`; ctx.stroke();
      if (state.frac > 0.001) {
        ctx.beginPath(); ctx.arc(cx, cy, R - lw / 2, start, end);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.95)`;
        ctx.shadowColor = `rgba(${cr},${cg},${cb},0.9)`; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0;
        const ex = cx + Math.cos(end) * (R - lw / 2), ey = cy + Math.sin(end) * (R - lw / 2);
        ctx.beginPath(); ctx.arc(ex, ey, lw * 0.42, 0, Math.PI * 2);
        ctx.shadowColor = `rgba(${cr},${cg},${cb},1)`; ctx.shadowBlur = 8; ctx.fillStyle = '#fff'; ctx.fill(); ctx.shadowBlur = 0;
      }
    }

    function frame(now) {
      if (!ctrl.visible || bodyIdle()) { draw(now || 0, false); ctrl.raf = 0; ctrl.frozen = true; return; }
      if (now - ctrl.lastDraw >= 32) { ctrl.lastDraw = now; draw(now, true); } // ~30fps
      ctrl.raf = requestAnimationFrame(frame);
    }
    ctrl.frame = frame;

    ctrl.io = new IntersectionObserver((entries) => {
      const vis = entries.some(e => e.isIntersecting);
      const was = ctrl.visible; ctrl.visible = vis;
      if (vis && (was === false || ctrl.frozen) && !reduceMotion && !bodyIdle()) { ctrl.frozen = false; ctrl.raf = requestAnimationFrame(frame); }
      else if (!vis && ctrl.raf) { cancelAnimationFrame(ctrl.raf); ctrl.raf = 0; ctrl.frozen = true; }
    }, { threshold: 0.05 });
    ctrl.io.observe(canvas);

    if (reduceMotion || bodyIdle()) { draw(0, false); ctrl.frozen = true; }
    else ctrl.raf = requestAnimationFrame(frame);
  }

  function teardownAnims() {
    while (anims.length) {
      const a = anims.pop();
      if (a.raf) cancelAnimationFrame(a.raf);
      if (a.io) a.io.disconnect();
    }
  }

  // ── readouts + sections (quiet, tabular) ──────────────────────────────────
  function stat(label, value, accent) {
    const s = el('div', 'cw-stat' + (accent ? ' cw-stat--accent' : ''));
    s.appendChild(el('div', 'cw-stat-val', value));
    s.appendChild(el('div', 'cw-stat-key', label));
    return s;
  }

  function statsGrid(u) {
    const g = el('div', 'cw-stats');
    g.appendChild(stat(t('claude_today', 'Today'), hTok(u.today.tokens)));
    g.appendChild(stat(t('claude_week', 'This week'), hTok(u.week.tokens)));
    g.appendChild(stat(t('claude_cache', 'Cache hit'), Math.round((u.cacheHitRate || 0) * 100) + '%'));
    g.appendChild(stat(t('claude_api_value', 'API value'), hCost(u.total.cost), true));
    return g;
  }

  // The concurrent sessions — one row per Claude Code instance running now, each
  // with its project · branch, what it's working on (last prompt), the model and
  // a live pulse. Idle → a single quiet "last active" row.
  function sessionsList(u) {
    const box = el('div', 'cw-sessions');
    const sessions = u.sessions || [];
    if (!sessions.length) {
      const row = el('div', 'cw-live');
      row.appendChild(el('span', 'cw-live-dot'));
      const main = el('div', 'cw-live-main');
      main.appendChild(el('span', 'cw-live-proj', t('claude_idle', 'Idle')));
      row.appendChild(main);
      if (u.live && u.live.at) { const m = el('div', 'cw-live-meta'); m.appendChild(el('span', 'cw-live-when', ago(u.live.ageMs) + ' ' + t('claude_ago', 'ago'))); row.appendChild(m); }
      box.appendChild(row);
      return box;
    }
    if (sessions.length > 1) {
      const hd = el('div', 'cw-sessions-head');
      hd.appendChild(el('span', 'cw-sessions-dot'));
      hd.appendChild(el('span', 'cw-sessions-count', sessions.length + ' ' + t('claude_running', 'running')));
      box.appendChild(hd);
    }
    sessions.forEach(s => box.appendChild(sessionRow(s)));
    return box;
  }
  function sessionRow(s) {
    const row = el('div', 'cw-live is-live');
    row.appendChild(el('span', 'cw-live-dot'));
    const main = el('div', 'cw-live-main-col');
    const line = el('div', 'cw-live-top');
    line.appendChild(el('span', 'cw-live-proj', s.project || '?'));
    if (s.branch) { line.appendChild(el('span', 'cw-live-sep', '·')); line.appendChild(el('span', 'cw-live-branch', s.branch)); }
    main.appendChild(line);
    if (s.task) main.appendChild(el('div', 'cw-live-task', s.task));
    row.appendChild(main);
    const meta = el('div', 'cw-live-meta');
    if (s.model) { const chip = el('span', 'cw-model-chip'); chip.style.setProperty('--m', modelHue(s.model)); chip.textContent = shortModel(s.model); meta.appendChild(chip); }
    meta.appendChild(el('span', 'cw-live-when', t('claude_live_now', 'live now')));
    row.appendChild(meta);
    return row;
  }

  // Daily cache-vs-fresh bars. Fresh (paid) tokens stack on top of cache-read
  // (cheap) tokens, so a tall mostly-cache bar reads as an efficient day.
  function sparks(u) {
    const wrap = el('div', 'cw-spark');
    wrap.appendChild(sectionTitle(t('claude_last30', 'Last 30 days'), t('claude_cache_legend', 'cache · fresh')));
    const chart = el('div', 'cw-spark-bars');
    const max = u.daily.reduce((m, d) => Math.max(m, d.tokens), 0) || 1;
    const todayIdx = u.daily.length - 1;
    u.daily.forEach((d, i) => {
      const col = el('div', 'cw-bar' + (i === todayIdx ? ' is-today' : ''));
      col.title = d.day + ' · ' + hTok(d.tokens);
      const h = d.tokens > 0 ? Math.max(3, Math.round((d.tokens / max) * 100)) : 0;
      const cacheFrac = d.tokens > 0 ? Math.max(0, Math.min(1, d.cacheRead / d.tokens)) : 0;
      const stack = el('div', 'cw-bar-stack'); stack.style.height = h + '%';
      const cache = el('div', 'cw-bar-cache'); cache.style.height = Math.round(cacheFrac * 100) + '%';
      stack.appendChild(cache);
      col.appendChild(stack);
      chart.appendChild(col);
    });
    wrap.appendChild(chart);
    return wrap;
  }

  function projectBars(u) {
    if (!u.projects.length) return null;
    const wrap = el('div', 'cw-projects');
    wrap.appendChild(sectionTitle(t('claude_projects', 'Projects'), ''));
    const total = u.projects.reduce((s, p) => s + p.tokens, 0) || 1;
    const top = u.projects[0].tokens || 1;
    u.projects.slice(0, 5).forEach(p => {
      const row = el('div', 'cw-proj');
      row.appendChild(el('span', 'cw-proj-name', p.name));
      const track = el('div', 'cw-proj-track');
      const bar = el('div', 'cw-proj-bar'); bar.style.width = Math.max(4, Math.round((p.tokens / top) * 100)) + '%';
      track.appendChild(bar);
      row.appendChild(track);
      row.appendChild(el('span', 'cw-proj-val', Math.round((p.tokens / total) * 100) + '%'));
      wrap.appendChild(row);
    });
    return wrap;
  }

  function modelSplit(u) {
    if (!u.models.length) return null;
    const wrap = el('div', 'cw-models');
    const total = u.models.reduce((s, m) => s + m.tokens, 0) || 1;
    const bar = el('div', 'cw-model-bar');
    u.models.forEach(m => {
      if (m.tokens <= 0) return;
      const seg = el('div', 'cw-model-seg');
      seg.style.width = (m.tokens / total * 100) + '%';
      seg.style.background = modelHue(m.model);
      seg.title = shortModel(m.model) + ' · ' + hTok(m.tokens);
      bar.appendChild(seg);
    });
    wrap.appendChild(bar);
    const legend = el('div', 'cw-model-legend');
    u.models.slice(0, 4).forEach(m => {
      if (m.tokens <= 0) return;
      const it = el('span', 'cw-model-leg');
      const dot = el('span', 'cw-model-legdot'); dot.style.background = modelHue(m.model);
      it.appendChild(dot);
      it.appendChild(el('span', 'cw-model-legname', shortModel(m.model)));
      it.appendChild(el('span', 'cw-model-legval', hTok(m.tokens)));
      legend.appendChild(it);
    });
    wrap.appendChild(legend);
    return wrap;
  }

  function sectionTitle(text, hint) {
    const s = el('div', 'cw-section');
    s.appendChild(el('span', 'cw-section-t', text));
    if (hint) s.appendChild(el('span', 'cw-section-hint', hint));
    return s;
  }

  // ── empty state ───────────────────────────────────────────────────────────
  // A resting reactor: a thin arc, the Xenon spark at the core and no live pulse.
  // The centre reads "standing by → start Claude Code"; the ring still animates
  // gently so the tile feels alive and inviting, not broken.
  function emptyReactorState() {
    return {
      mode: 'energy', frac: 0.06, spark: true,
      big: '✦',
      label: t('claude_ready', 'standing by'),
      sub: t('claude_awaiting', 'start Claude Code'),
      over: false,
    };
  }
  function buildEmpty(wrap, u) {
    wrap.classList.add('cw-wrap--empty');
    // No model has run yet → tint everything to the dashboard accent.
    wrap.style.setProperty('--cw-accent', 'var(--accent)');
    const coreRgb = hueRgb(null);
    const top = el('div', 'cw-top');
    top.appendChild(reactor([coreRgb], coreRgb, emptyReactorState(), null));
    const col = el('div', 'cw-top-col');
    col.appendChild(statsGrid(u)); // all zeros — mirrors the live layout
    top.appendChild(col);
    wrap.appendChild(top);

    const hint = el('div', 'cw-empty-hint');
    hint.appendChild(el('div', 'cw-empty-hint-t', t('claude_empty_title', 'Waiting for Claude Code')));
    hint.appendChild(el('div', 'cw-empty-hint-d', t('claude_empty_desc', 'Start a Claude Code session on this PC — your usage, projects and models will light up the reactor here.')));
    wrap.appendChild(hint);
  }

  // ── render ────────────────────────────────────────────────────────────────
  function build() {
    const wrap = el('div', 'cw-wrap');
    if (editing) { wrap.appendChild(budgetEditor()); return wrap; }
    const u = payload && payload.usage;

    if (!u) { wrap.appendChild(el('div', 'cw-state', t('claude_reading', 'Reading local Claude Code sessions…'))); return wrap; }
    // No usage yet → a dormant reactor + zeroed readouts + an inviting explainer,
    // so the tile reads as "standing by" rather than an empty box. Same top layout
    // as the live view, so it stays continuous when the first session lights it up.
    if (!u.total.reqs) { buildEmpty(wrap, u); return wrap; }

    const state = reactorState();
    const live = u.live;
    const sessions = u.sessions || [];
    const dominant = (live && live.active ? live.model : (u.models[0] && u.models[0].model));
    const coreRgb = hueRgb(dominant);
    // Particles carry each running session's own model colour into the core.
    const streamRgbs = sessions.length ? sessions.map(s => hueRgb(s.model)) : [coreRgb];
    // Tie the whole widget to Claude's colours: the accents follow the running model.
    wrap.style.setProperty('--cw-accent', modelHue(dominant));

    const top = el('div', 'cw-top');
    top.appendChild(reactor(streamRgbs, coreRgb, state, live));
    const col = el('div', 'cw-top-col');
    col.appendChild(statsGrid(u));
    top.appendChild(col);
    wrap.appendChild(top);
    // Concurrent sessions, full width (a narrow column would truncate them).
    wrap.appendChild(sessionsList(u));

    // Lower sections — revealed by container queries when the tile is tall enough.
    const more = el('div', 'cw-more');
    more.appendChild(sparks(u));
    const proj = projectBars(u); if (proj) more.appendChild(proj);
    const models = modelSplit(u); if (models) more.appendChild(models);
    wrap.appendChild(more);

    return wrap;
  }

  // ── budget editor ─────────────────────────────────────────────────────────
  const PLAN_OPTIONS = [
    { key: 'auto',  plan: 'custom', labelKey: 'claude_plan_auto',  fb: 'Auto' },
    { key: 'pro',   plan: 'pro',    labelKey: 'claude_plan_pro',   fb: 'Pro' },
    { key: 'max5',  plan: 'max5',   labelKey: 'claude_plan_max5',  fb: 'Max 5×' },
    { key: 'max20', plan: 'max20',  labelKey: 'claude_plan_max20', fb: 'Max 20×' },
  ];
  function currentPlanKey() {
    const b = payload && payload.budget;
    if (!b) return 'auto';
    if (b.weeklyTokenBudget > 0) return 'custom';
    if (b.plan === 'pro' || b.plan === 'max5' || b.plan === 'max20') return b.plan;
    return 'auto';
  }
  function openBudget() { editing = true; customOpen = currentPlanKey() === 'custom'; paint(); }
  function closeBudget() { editing = false; paint(); }
  async function postBudget(patch) {
    const d = await api('/api/claude/budget', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    if (d && d.ok && d.budget) { if (payload) payload.budget = d.budget; editing = false; paint(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('claude_budget_fail', 'Could not save budget') });
  }
  function budgetEditor() {
    const wrap = el('div', 'cw-budget-editor');
    const head = el('div', 'cw-budget-head');
    head.appendChild(el('div', 'cw-budget-title', t('claude_budget_title', 'Weekly budget')));
    const back = el('button', 'cw-budget-back'); back.type = 'button'; back.setAttribute('aria-label', t('back', 'Back'));
    back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    back.addEventListener('click', closeBudget);
    head.appendChild(back);
    wrap.appendChild(head);

    wrap.appendChild(el('div', 'cw-budget-hint', t('claude_budget_hint', 'No official API exposes a plan’s remaining quota, so pick the weekly ceiling the reactor gauges against — an estimate you can tune.')));

    const cur = currentPlanKey();
    const chips = el('div', 'cw-plan-chips');
    PLAN_OPTIONS.forEach(o => {
      const c = el('button', 'cw-plan' + (cur === o.key && !customOpen ? ' is-sel' : '')); c.type = 'button';
      c.textContent = t(o.labelKey, o.fb);
      c.addEventListener('click', () => postBudget({ plan: o.plan, weeklyTokenBudget: 0 }));
      chips.appendChild(c);
    });
    const customChip = el('button', 'cw-plan' + (customOpen ? ' is-sel' : '')); customChip.type = 'button';
    customChip.textContent = t('claude_plan_custom', 'Custom');
    customChip.addEventListener('click', () => { customOpen = true; paint(); });
    chips.appendChild(customChip);
    wrap.appendChild(chips);

    if (customOpen) {
      const row = el('div', 'cw-custom');
      const input = el('input', 'cw-custom-input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.placeholder = '500';
      const b = payload && payload.budget;
      if (b && b.weeklyTokenBudget > 0) input.value = String(Math.round(b.weeklyTokenBudget / 1e6));
      row.appendChild(input);
      row.appendChild(el('span', 'cw-custom-unit', t('claude_custom_unit', 'M tokens / week')));
      const save = el('button', 'cw-custom-save'); save.type = 'button'; save.textContent = t('claude_budget_save', 'Save');
      const commit = () => {
        const m = parseInt(input.value, 10);
        if (!Number.isFinite(m) || m <= 0) { input.focus(); return; }
        postBudget({ plan: 'custom', weeklyTokenBudget: m * 1e6 });
      };
      save.addEventListener('click', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
      row.appendChild(save);
      wrap.appendChild(row);
      requestAnimationFrame(() => { try { input.focus(); } catch {} });
    }
    return wrap;
  }

  function paint() {
    teardownAnims();
    tiles().forEach(tile => {
      const mount = tile.querySelector('.claude-widget-mount');
      if (mount) mount.replaceChildren(build());
    });
  }

  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try { const d = await api('/api/claude'); if (d) payload = d; }
    finally { seedInflight = false; }
    paint();
  }

  // ── public API ──
  function renderWidgets() {
    if (!tiles().length) { seeded = false; teardownAnims(); return; }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }
  function onSSE(data) {
    if (!data || !data.usage) return;
    payload = data;
    paint();
  }

  window.ClaudeWidget = { renderWidgets, onSSE };
})();
