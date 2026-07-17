'use strict';
// GitHub Stars — reference widget for the Xenon widget SDK (API v1).
//
// Shows a GitHub repository's live star count as a tile, and projects the
// same compact count as a small persistent badge next to the clock (SDK
// `badge` capability, manifest.json "badge": true). The repo is user
// config, kept in the widget's own SDK storage ("storage": true) so it
// survives reloads and shows immediately (no blank flash) while the first
// poll of a session is in flight. The star count itself is fetched through
// the host-mediated network proxy (POST /sdk/fetch, manifest
// "hosts": ["api.github.com"]) since the sandboxed frame has no network of
// its own.
// Full protocol reference: docs/WIDGET_SDK.md in the Xenon repository.
(function () {
  const $ = (id) => document.getElementById(id);
  let reqId = 0;

  const POLL_MS = 15 * 60 * 1000;         // well under GitHub's unauthenticated 60/hr limit
  const STALE_AFTER_MS = 60 * 60 * 1000;  // flag the meta line once an hour passes with no fresh fetch
  // GitHub's own star gold. Kept in step with --gs-star in widget.css: the tile
  // styles its star in CSS, the badge chip is host-rendered and takes the colour
  // in the payload — same star, so the two must not drift.
  const STAR_GOLD = '#f5c518';

  function send(msg) {
    window.parent.postMessage({ xenonSdk: 1, ...msg }, '*');
  }

  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent || '#1ed760');
    root.style.setProperty('--bg', theme.background || '#070808');
    root.style.setProperty('--text', theme.text || '#f0f3f1');
    root.dataset.appearance = theme.appearance === 'light' ? 'light' : 'dark';
  }

  // "owner/repo" shape check — a UX guard against firing a fetch for garbage
  // input, not a security boundary (the real boundary is the manifest host
  // allowlist + the /sdk/fetch broker, enforced host-side regardless).
  function okPart(p) {
    return p.length > 0 && p.length <= 64 && /^[A-Za-z0-9._-]+$/.test(p);
  }
  function isValidRepo(s) {
    if (typeof s !== 'string') return false;
    const parts = s.split('/');
    return parts.length === 2 && okPart(parts[0]) && okPart(parts[1]);
  }

  // ── State ─────────────────────────────────────────────────
  let hasStorage = false;
  let repo = '';
  let count = null;   // last known star count, or null if never fetched
  let updatedAt = 0;  // ms epoch of the last SUCCESSFUL fetch
  let pollTimer = 0;
  let metaTimer = 0;

  // ── Persistence (SDK storage, granted via manifest storage:true) ──
  const pendingStores = new Map();
  function storeOp(op) {
    if (!hasStorage) return Promise.resolve({ ok: false, error: 'not_granted' });
    return new Promise((resolve) => {
      const id = ++reqId;
      pendingStores.set(id, resolve);
      send({ type: 'store', id, op });
    });
  }
  const sGet = (key) => storeOp({ op: 'get', key });
  const sSet = (key, value) => storeOp({ op: 'set', key, value });

  let saveTimer = 0;
  function saveCfg() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { sSet('cfg', { repo, count, updatedAt }); }, 400);
  }

  // ── Fetch (SDK network proxy, granted via manifest hosts) ──
  const pendingFetches = new Map();
  function doFetch(url) {
    return new Promise((resolve) => {
      const id = ++reqId;
      pendingFetches.set(id, resolve);
      send({ type: 'fetch', id, url, method: 'GET', headers: { Accept: 'application/json' } });
    });
  }

  // ── Compact count formatting: 1234 -> "1.2k", 12345 -> "12k", 1234567 -> "1.2M" ──
  function fmtCount(n) {
    if (!Number.isFinite(n)) return '--';
    if (n < 1000) return String(n);
    if (n < 10000) return (Math.round(n / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1000000) return Math.round(n / 1000) + 'k';
    return (Math.round(n / 100000) / 10).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  function fmtAgo(ts) {
    if (!ts) return 'loading...';
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    if (mins < 1) return 'updated just now';
    if (mins < 60) return 'updated ' + mins + 'm ago';
    return 'updated ' + Math.round(mins / 60) + 'h ago';
  }

  // ── Rendering ─────────────────────────────────────────────
  function renderSetup() {
    $('setup').hidden = false;
    $('count').hidden = true;
    $('repo').value = repo;
    $('err').textContent = '';
    // Nothing configured yet → nothing to remove.
    $('remove').hidden = !repo;
  }

  // Forget the repo and drop the badge. The badge outlives this tile (the host
  // keeps a hidden service frame alive for it), so this is the user's explicit
  // way out — short of uninstalling the package.
  function removeBadge() {
    repo = '';
    count = null;
    updatedAt = 0;
    clearInterval(pollTimer);
    pollTimer = 0;
    clearTimeout(saveTimer);
    sSet('cfg', { repo: '', count: null, updatedAt: 0 });
    send({ type: 'badge', op: 'clear' });
    renderSetup();
  }

  // The chip is icon + value: the host renders the star in the colour we name
  // here (GitHub's own gold) and the count in the topbar's text colour, so the
  // badge reads as ours without the host having to guess a colour from the text.
  function pushBadge() {
    if (count == null) { send({ type: 'badge', op: 'clear' }); return; }
    send({
      type: 'badge', op: 'set',
      text: fmtCount(count),
      icon: '★',
      color: STAR_GOLD,
      tooltip: repo + ' — GitHub stars',
    });
  }

  function refreshMeta() {
    const meta = $('meta');
    if (!meta || $('count').hidden) return;
    meta.textContent = fmtAgo(updatedAt);
    meta.classList.toggle('is-stale', !!(updatedAt && (Date.now() - updatedAt) > STALE_AFTER_MS));
  }

  function renderCount() {
    $('setup').hidden = true;
    $('count').hidden = false;
    $('repolbl').textContent = repo;
    $('num').textContent = count == null ? '--' : fmtCount(count);
    refreshMeta();
    pushBadge();
  }

  function syncMetaTicker() {
    clearInterval(metaTimer);
    metaTimer = setInterval(refreshMeta, 60000);
  }

  // ── Polling ───────────────────────────────────────────────
  async function poll() {
    if (!repo) return;
    const r = await doFetch('https://api.github.com/repos/' + repo);
    if (!r || !r.ok || r.status !== 200) return;   // keep showing the last known count
    let data;
    try { data = JSON.parse(r.body); } catch { return; }
    const n = Number(data && data.stargazers_count);
    if (!Number.isFinite(n)) return;
    count = n;
    updatedAt = Date.now();
    saveCfg();
    renderCount();
  }

  function schedulePoll() {
    clearInterval(pollTimer);
    if (!repo) return;
    poll();   // immediate first fetch — don't make the user wait a poll interval
    pollTimer = setInterval(poll, POLL_MS);
  }

  function setRepo(next) {
    repo = next;
    count = null;
    updatedAt = 0;
    renderCount();
    saveCfg();
    schedulePoll();
  }

  // ── Setup wiring ──────────────────────────────────────────
  $('save').addEventListener('click', () => {
    const val = $('repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\/+$/, '');
    if (!isValidRepo(val)) {
      $('err').textContent = 'Enter it as owner/repo, e.g. torvalds/linux';
      return;
    }
    setRepo(val);
  });
  $('repo').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('save').click();
  });
  $('reconfigure').addEventListener('click', renderSetup);
  $('remove').addEventListener('click', removeBadge);

  // ── Bridge ────────────────────────────────────────────────
  async function restore() {
    if (!hasStorage) { renderSetup(); return; }
    const r = await sGet('cfg');
    const c = r && r.ok && r.value && typeof r.value === 'object' ? r.value : null;
    if (c && isValidRepo(c.repo)) {
      repo = c.repo;
      count = Number.isFinite(Number(c.count)) ? Number(c.count) : null;
      updatedAt = Number(c.updatedAt) || 0;
      renderCount();
      syncMetaTicker();
      schedulePoll();
    } else {
      renderSetup();
    }
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || m.xenonSdk !== 1) return;
    if (m.type === 'init') {
      applyTheme(m.theme);
      hasStorage = m.storage === true;
      restore();
    } else if (m.type === 'theme') {
      applyTheme(m.theme);
    } else if (m.type === 'size') {
      const scale = Math.max(0.6, Math.min(2, (m.width || 240) / 240));
      document.documentElement.style.setProperty('--gs-scale', String(scale));
    } else if (m.type === 'store_result') {
      const done = pendingStores.get(m.id);
      if (done) { pendingStores.delete(m.id); done(m); }
    } else if (m.type === 'fetch_result') {
      const done = pendingFetches.get(m.id);
      if (done) { pendingFetches.delete(m.id); done(m); }
    }
  });

  send({ type: 'hello' });
})();
