'use strict';
// Football (Calcio) widget — a list of the user's favorite teams, each showing
// its latest result and next fixture with club crests, plus a detail view with
// recent results, upcoming fixtures and the live league table.
//
// Data is pushed over SSE ('football' → onSSE) and seeded once on mount
// (GET /api/football, which also returns the favorites list so every followed
// team shows — even before its fixtures resolve). Teams are added through a real
// SEARCH (GET /api/football/search): the user types a club name and picks it, so
// "napoli" resolves to the right team id. Favorites are persisted via
// POST /api/football/teams; standings are fetched on-demand
// (GET /api/football/standings). All external strings render through textContent;
// crest URLs are used as <img src> only when https (server already host-checks).
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let teamsData = null;     // null = not seeded yet; [] once seeded. Server payload (one per favorite)
  let favorites = [];       // [{id,name,badge,league,leagueId}] from the server — persists across SSE
  let tileCfg = { results: true, standings: true };
  let meta = { live: false, refreshedAt: 0 };
  let seeded = false, seedInflight = false;
  let view = { mode: 'list', teamId: '', favType: 'team' };
  const standingsCache = new Map(); // `${leagueId}|${season}` → data

  // A favorite is a team or a league/competition; key/dedup by type+id.
  function favKey(f) { return (f && f.type === 'league' ? 'L:' : 'T:') + (f && f.id); }
  function isLeague(td) { return !!(td && td.type === 'league'); }
  // Match perspective: a team entry is shown opponent-centric; a league entry has
  // no "my team", so matches show both sides plainly.
  function perspId(td) { return isLeague(td) ? '' : (td && td.id); }

  // ── search (add box) state ──
  let searchQuery = '';
  let searchResults = [];
  let searchBusy = false;
  let searchSeq = 0;
  let searchTimer = 0;
  let searchResultsFor = '';
  let resultsHost = null;

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="football"]')).filter(n => n.closest('.pager-page'));
  }

  // ── formatting helpers ──
  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
  }
  function crest(url, name, cls) {
    const wrap = el('div', 'fw-crest' + (cls ? ' ' + cls : ''));
    if (url && /^https:\/\//i.test(url)) {
      const img = el('img'); img.loading = 'lazy'; img.alt = ''; img.decoding = 'async'; img.src = url;
      img.addEventListener('error', () => { wrap.classList.add('is-empty'); wrap.textContent = initials(name); });
      wrap.appendChild(img);
    } else {
      wrap.classList.add('is-empty');
      wrap.textContent = initials(name);
    }
    return wrap;
  }
  function matchDate(ev) {
    if (!ev) return null;
    const iso = ev.ts || (ev.date ? ev.date + 'T' + (ev.time || '00:00:00') : '');
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  function whenShort(ev) {
    const d = matchDate(ev);
    if (!d) return '';
    try {
      const now = new Date();
      const days = Math.round((d - now) / 86400000);
      if (days >= 0 && days <= 6) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
    } catch { return ''; }
  }
  function whenLong(ev) {
    const d = matchDate(ev);
    if (!d) return '';
    try { return d.toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }
  function isHome(ev, teamId) { return ev && ev.homeId === teamId; }
  function oppName(ev, teamId) { return ev ? (isHome(ev, teamId) ? ev.away : ev.home) : ''; }
  function scoreText(ev) {
    if (!ev || ev.homeScore == null || ev.awayScore == null) return '';
    return ev.homeScore + '–' + ev.awayScore;
  }
  // Result from the followed team's perspective → 'w' | 'd' | 'l' | ''.
  function resultOf(ev, teamId) {
    if (!ev || ev.homeScore == null || ev.awayScore == null) return '';
    const home = isHome(ev, teamId);
    const mine = home ? ev.homeScore : ev.awayScore;
    const theirs = home ? ev.awayScore : ev.homeScore;
    if (mine > theirs) return 'w';
    if (mine < theirs) return 'l';
    return 'd';
  }
  function statusBadge(ev) {
    if (!ev) return null;
    if (ev.status === 'live') { const b = el('span', 'fw-live'); b.append(el('span', 'fw-live-dot'), el('span', null, ev.progress ? ev.progress : t('football_live', 'LIVE'))); return b; }
    if (ev.status === 'pp') return el('span', 'fw-badge fw-badge--pp', t('football_pp', 'Postp.'));
    return null;
  }

  // ── list ──
  function displayRows() {
    const byKey = new Map((teamsData || []).map(td => [favKey(td), td]));
    const list = favorites.length ? favorites : (teamsData || []);
    return list.map(f => byKey.get(favKey(f)) || { id: f.id, type: f.type, name: f.name || f.id, badge: f.badge, league: f.league, unresolved: true });
  }

  // A team row is opponent-centric ("vs Roma"); a league row shows both sides
  // ("Napoli–Roma") since there's no followed team.
  function sideLabel(ev, td) {
    const pid = perspId(td);
    if (pid && (ev.homeId === pid || ev.awayId === pid)) return oppName(ev, pid);
    return (ev.home || '') + ' – ' + (ev.away || '');
  }
  function matchCell(td) {
    const cell = el('div', 'fw-cell');
    const pid = perspId(td);
    const live = [td.last, td.next].find(e => e && e.status === 'live');
    const featured = live || td.last;
    if (featured) {
      const res = pid ? resultOf(featured, pid) : '';
      const line = el('div', 'fw-cell-res' + (res ? ' fw-res--' + res : ''));
      const lb = statusBadge(featured);
      if (lb) line.appendChild(lb);
      line.appendChild(el('span', 'fw-cell-opp', sideLabel(featured, td)));
      const sc = el('span', 'fw-score' + (featured.status === 'live' ? ' is-live' : ''), scoreText(featured) || '—');
      line.appendChild(sc);
      cell.appendChild(line);
    }
    const nx = td.next;
    if (nx && nx.status !== 'live' && nx.status !== 'ft' && nx !== featured) {
      const line = el('div', 'fw-cell-next');
      line.appendChild(el('span', 'fw-next-opp', '→ ' + sideLabel(nx, td)));
      const w = whenShort(nx);
      if (w) line.appendChild(el('span', 'fw-next-when', w));
      cell.appendChild(line);
    }
    if (!cell.childNodes.length) cell.appendChild(el('div', 'fw-cell-none', t('football_no_matches', 'No matches')));
    return cell;
  }

  function rowLeagueSub(td) { return isLeague(td) ? (t('football_competition', 'Competition') + (td.league && td.league !== td.name ? ' · ' + td.league : '')) : td.league; }
  function row(td) {
    if (td.unresolved) return unresolvedRow(td);
    const r = el('button', 'fw-row' + (isLeague(td) ? ' fw-row--league' : '')); r.type = 'button';
    r.appendChild(crest(td.badge, td.name, isLeague(td) ? 'fw-crest--league' : ''));
    const main = el('div', 'fw-row-main');
    main.appendChild(el('div', 'fw-row-name', td.name || td.id));
    const sub = rowLeagueSub(td);
    if (sub) main.appendChild(el('div', 'fw-row-league', sub));
    r.appendChild(main);
    r.appendChild(matchCell(td));
    r.appendChild(removeBtn(td));
    r.addEventListener('click', () => { view = { mode: 'detail', teamId: td.id, favType: td.type || 'team' }; paint(); loadStandingsFor(td); });
    return r;
  }
  function unresolvedRow(td) {
    const r = el('div', 'fw-row fw-row--dead');
    r.appendChild(crest(td.badge, td.name, isLeague(td) ? 'fw-crest--league' : ''));
    const main = el('div', 'fw-row-main');
    main.appendChild(el('div', 'fw-row-name', td.name || td.id));
    const sub = rowLeagueSub(td);
    if (sub) main.appendChild(el('div', 'fw-row-league', sub));
    r.appendChild(main);
    r.appendChild(el('div', 'fw-cell-none', t('football_no_data', 'No data')));
    r.appendChild(removeBtn(td, true));
    return r;
  }
  function removeBtn(td, always) {
    const b = el('button', 'fw-row-rm' + (always ? ' is-shown' : '')); b.type = 'button';
    b.setAttribute('aria-label', t('football_remove', 'Remove'));
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    b.addEventListener('click', (e) => { e.stopPropagation(); removeTeam(td.id, td.type); });
    return b;
  }

  // ── search add box (mirrors the Borsa widget) ──
  function addBox() {
    const box = el('div', 'fw-add');
    const field = el('div', 'fw-add-field');
    field.innerHTML = '<svg class="fw-add-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
    const input = el('input', 'fw-add-input');
    input.type = 'text';
    input.placeholder = t('football_search_ph', 'Search a club…');
    input.maxLength = 60; input.autocomplete = 'off'; input.spellcheck = false;
    input.value = searchQuery;
    field.appendChild(input);
    box.appendChild(field);

    const results = el('div', 'fw-results');
    box.appendChild(results);
    resultsHost = results;
    renderResults(results);

    input.addEventListener('input', () => { searchQuery = input.value; scheduleSearch(); });
    input.addEventListener('keydown', async (e) => {
      if (e.key === 'Escape') { searchQuery = ''; input.value = ''; searchResults = []; searchResultsFor = ''; searchBusy = false; refreshResults(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const raw = input.value.trim();
      if (!raw) return;
      if (searchResults.length && searchResultsFor === raw) { addTeam(searchResults[0]); return; }
      if (searchTimer) { clearTimeout(searchTimer); searchTimer = 0; }
      await runSearch(raw);
      if (searchResults.length && searchResultsFor === raw) addTeam(searchResults[0]);
    });
    // Keep focus + caret across a background repaint (SSE tick) while typing.
    const prev = document.activeElement;
    if (prev && prev.classList && prev.classList.contains('fw-add-input')) {
      let selS = null, selE = null;
      try { selS = prev.selectionStart; selE = prev.selectionEnd; } catch {}
      requestAnimationFrame(() => {
        try { input.focus(); const n = input.value.length; input.setSelectionRange(selS == null ? n : selS, selE == null ? n : selE); } catch {}
      });
    }
    return box;
  }
  function renderResults(host) {
    host.replaceChildren();
    const q = searchQuery.trim();
    if (!q) return;
    if (searchBusy && !searchResults.length) { host.appendChild(el('div', 'fw-result fw-result--info', t('football_searching', 'Searching…'))); return; }
    if (!searchResults.length) { host.appendChild(el('div', 'fw-result fw-result--info', t('football_no_results', 'No team or competition found'))); return; }
    const already = new Set((favorites.length ? favorites : (teamsData || [])).map(favKey));
    searchResults.forEach(r => {
      const league = r.type === 'league';
      const item = el('button', 'fw-result'); item.type = 'button';
      item.appendChild(crest(r.badge, r.name, 'fw-crest--sm' + (league ? ' fw-crest--league' : '')));
      const info = el('div', 'fw-result-info');
      info.appendChild(el('div', 'fw-result-name', r.name || r.id));
      const sub = el('div', 'fw-result-sub');
      if (r.league) sub.appendChild(el('span', 'fw-result-league', r.league));
      if (r.country) sub.appendChild(el('span', 'fw-result-country', r.country));
      info.appendChild(sub);
      item.appendChild(info);
      item.appendChild(el('span', 'fw-result-type', league ? t('football_competition', 'Competition') : t('football_club', 'Club')));
      if (already.has(favKey(r))) { item.classList.add('is-added'); item.appendChild(el('span', 'fw-result-added', '✓')); }
      item.addEventListener('click', () => addTeam(r));
      host.appendChild(item);
    });
  }
  function refreshResults() { if (resultsHost && resultsHost.isConnected) renderResults(resultsHost); }
  function scheduleSearch() {
    if (searchTimer) clearTimeout(searchTimer);
    const query = searchQuery.trim();
    if (!query) { searchResults = []; searchBusy = false; refreshResults(); return; }
    searchBusy = true;
    searchTimer = setTimeout(() => runSearch(query), 240);
    refreshResults();
  }
  async function runSearch(query) {
    const seq = ++searchSeq;
    const d = await api('/api/football/search?q=' + encodeURIComponent(query));
    if (seq !== searchSeq) return;
    searchResults = (d && Array.isArray(d.results)) ? d.results : [];
    searchResultsFor = query;
    searchBusy = false;
    refreshResults();
  }
  async function addTeam(r) {
    if (!r || !r.id) return;
    const ok = await postTeams('add', { id: r.id, type: r.type || 'team', name: r.name, badge: r.badge, league: r.league, leagueId: r.leagueId });
    if (ok) { searchQuery = ''; searchResults = []; searchSeq++; await refresh(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('football_add_fail', 'Could not add'), message: r.name || r.id });
  }
  async function removeTeam(id, type) {
    const ok = await postTeams('remove', { id, type: type || 'team' });
    if (ok) {
      if (view.mode === 'detail' && view.teamId === id) view = { mode: 'list', teamId: '', favType: 'team' };
      await refresh();
    } else if (window.XenonToast) {
      window.XenonToast.show({ type: 'error', title: t('football_add_fail', 'Could not update'), message: id });
    }
  }
  async function postTeams(action, payload) {
    const d = await api('/api/football/teams', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
    if (d && Array.isArray(d.teams)) favorites = d.teams;
    return !!(d && d.ok);
  }

  // ── detail view ──
  function detailView(mount) {
    const wantLeague = view.favType === 'league';
    const match = (x) => x && x.id === view.teamId && isLeague(x) === wantLeague;
    const td = (teamsData || []).find(match) || favorites.find(match) || { id: view.teamId, type: view.favType, name: view.teamId };
    const pid = perspId(td);
    const wrap = el('div', 'fw-detail');

    const head = el('div', 'fw-detail-head');
    const back = el('button', 'fw-back'); back.type = 'button'; back.setAttribute('aria-label', t('back', 'Back'));
    back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
    back.addEventListener('click', () => { view = { mode: 'list', teamId: '', favType: 'team' }; paint(); });
    head.appendChild(back);
    head.appendChild(crest(td.badge, td.name, 'fw-crest--lg' + (isLeague(td) ? ' fw-crest--league' : '')));
    const titleBox = el('div', 'fw-detail-title');
    titleBox.append(el('div', 'fw-detail-name', td.name || td.id));
    const dsub = isLeague(td) ? t('football_competition', 'Competition') : td.league;
    if (dsub) titleBox.append(el('div', 'fw-detail-league', dsub));
    head.appendChild(titleBox);
    const rm = el('button', 'fw-detail-rm'); rm.type = 'button'; rm.setAttribute('aria-label', t('football_remove', 'Remove'));
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    rm.addEventListener('click', () => removeTeam(td.id, td.type));
    head.appendChild(rm);
    wrap.appendChild(head);

    // Hero: the most relevant match (live > next upcoming > last result).
    const hero = heroMatch(td);
    if (hero) wrap.appendChild(matchHero(hero, pid));

    const body = el('div', 'fw-detail-body');

    // Recent results
    const last = (td.lastList || []).slice(0, 5);
    if (tileCfg.results !== false && last.length) {
      body.appendChild(sectionTitle(t('football_recent', 'Recent results')));
      const listWrap = el('div', 'fw-mini-list');
      last.forEach(ev => listWrap.appendChild(miniResult(ev, pid)));
      body.appendChild(listWrap);
    }
    // Upcoming fixtures
    const upcoming = (td.nextList || []).filter(e => e.status !== 'ft').slice(0, 5);
    if (upcoming.length) {
      body.appendChild(sectionTitle(t('football_upcoming', 'Upcoming')));
      const listWrap = el('div', 'fw-mini-list');
      upcoming.forEach(ev => listWrap.appendChild(miniFixture(ev, pid)));
      body.appendChild(listWrap);
    }
    // Standings
    if (tileCfg.standings !== false && td.leagueId) {
      const key = td.leagueId + '|' + (td.season || '');
      const table = standingsCache.get(key);
      body.appendChild(sectionTitle(table ? table.league || t('football_standings', 'Standings') : t('football_standings', 'Standings')));
      if (table) body.appendChild(standingsTable(table, pid));
      else body.appendChild(el('div', 'fw-mini-loading', t('football_loading', 'Loading…')));
    }
    wrap.appendChild(body);
    mount.replaceChildren(wrap);
  }

  function heroMatch(td) {
    const live = [td.next, td.last].find(e => e && e.status === 'live');
    if (live) return live;
    if (td.next && td.next.status !== 'ft') return td.next;
    return td.last || td.next || null;
  }
  function matchHero(ev, teamId) {
    const hero = el('div', 'fw-hero' + (ev.status === 'live' ? ' is-live' : ''));
    const top = el('div', 'fw-hero-top');
    const lb = statusBadge(ev);
    if (lb) top.appendChild(lb);
    else if (ev.status === 'ft') top.appendChild(el('span', 'fw-badge', t('football_ft', 'Full time')));
    else { const w = whenLong(ev); if (w) top.appendChild(el('span', 'fw-hero-when', w)); }
    if (ev.league) top.appendChild(el('span', 'fw-hero-league', ev.round ? ev.league + ' · ' + t('football_round', 'MD') + ' ' + ev.round : ev.league));
    hero.appendChild(top);

    const mid = el('div', 'fw-hero-mid');
    const side = (name, badge, mine) => { const s = el('div', 'fw-hero-side' + (mine ? ' is-mine' : '')); s.appendChild(crest(badge, name, 'fw-crest--lg')); s.appendChild(el('div', 'fw-hero-team', name)); return s; };
    mid.appendChild(side(ev.home, ev.homeBadge, ev.homeId === teamId));
    const centre = el('div', 'fw-hero-centre');
    if (ev.homeScore != null && ev.awayScore != null) centre.appendChild(el('div', 'fw-hero-score', ev.homeScore + ' – ' + ev.awayScore));
    else centre.appendChild(el('div', 'fw-hero-vs', t('football_vs', 'vs')));
    mid.appendChild(centre);
    mid.appendChild(side(ev.away, ev.awayBadge, ev.awayId === teamId));
    hero.appendChild(mid);

    if (ev.venue) hero.appendChild(el('div', 'fw-hero-venue', ev.venue));
    return hero;
  }
  function sectionTitle(text) { return el('div', 'fw-section', text); }
  // `teamId` empty → league context: show both teams, no W/D/L badge.
  function miniLabel(ev, teamId) {
    if (teamId && (ev.homeId === teamId || ev.awayId === teamId)) return oppName(ev, teamId);
    return (ev.home || '') + ' – ' + (ev.away || '');
  }
  function miniResult(ev, teamId) {
    const r = teamId ? resultOf(ev, teamId) : '';
    const row = el('div', 'fw-mini');
    row.appendChild(el('span', 'fw-wdl fw-wdl--' + (r || 'na'), r ? r.toUpperCase() : '·'));
    row.appendChild(el('span', 'fw-mini-opp', miniLabel(ev, teamId)));
    row.appendChild(el('span', 'fw-mini-score', scoreText(ev) || '—'));
    return row;
  }
  function miniFixture(ev, teamId) {
    const row = el('div', 'fw-mini');
    const oppCrest = teamId ? (isHome(ev, teamId) ? ev.awayBadge : ev.homeBadge) : ev.homeBadge;
    row.appendChild(crest(oppCrest, miniLabel(ev, teamId), 'fw-crest--sm'));
    row.appendChild(el('span', 'fw-mini-opp', miniLabel(ev, teamId)));
    const w = whenShort(ev);
    row.appendChild(el('span', 'fw-mini-when', w || (teamId && isHome(ev, teamId) ? t('football_home', 'H') : t('football_away', 'A'))));
    return row;
  }
  function standingsTable(table, teamId) {
    const box = el('div', 'fw-table');
    const head = el('div', 'fw-tr fw-tr--head');
    ['#', '', 'PG', 'DR', 'Pt'].forEach((h, i) => head.appendChild(el('span', 'fw-th fw-col-' + i, h)));
    box.appendChild(head);
    table.rows.slice(0, 24).forEach(r => {
      const tr = el('div', 'fw-tr' + (r.teamId === teamId ? ' is-mine' : ''));
      tr.appendChild(el('span', 'fw-td fw-col-0', r.rank != null ? String(r.rank) : ''));
      const teamCell = el('span', 'fw-td fw-col-1');
      teamCell.appendChild(crest(r.badge, r.team, 'fw-crest--xs'));
      teamCell.appendChild(el('span', 'fw-td-team', r.team));
      tr.appendChild(teamCell);
      tr.appendChild(el('span', 'fw-td fw-col-2', r.played != null ? String(r.played) : ''));
      tr.appendChild(el('span', 'fw-td fw-col-3', r.gd != null ? (r.gd > 0 ? '+' + r.gd : String(r.gd)) : ''));
      tr.appendChild(el('span', 'fw-td fw-col-4 fw-pts', r.points != null ? String(r.points) : ''));
      box.appendChild(tr);
    });
    return box;
  }

  async function loadStandingsFor(td) {
    if (!td || !td.leagueId || tileCfg.standings === false) return;
    const key = td.leagueId + '|' + (td.season || '');
    if (standingsCache.has(key)) return;
    const d = await api('/api/football/standings?league=' + encodeURIComponent(td.leagueId) + '&season=' + encodeURIComponent(td.season || ''));
    if (d && Array.isArray(d.rows)) {
      if (standingsCache.size > 16) standingsCache.delete(standingsCache.keys().next().value);
      standingsCache.set(key, d);
      if (view.mode === 'detail' && view.teamId === td.id) paint();
    }
  }

  // ── list view ──
  function listView(mount) {
    const wrap = el('div', 'fw-wrap');
    const head = el('div', 'fw-head');
    const titleWrap = el('div', 'fw-head-title');
    titleWrap.append(el('span', 'fw-title', t('layout_widget_football', 'Calcio')));
    const rows = displayRows();
    if (rows.length) titleWrap.appendChild(el('span', 'fw-count', String(rows.length)));
    head.appendChild(titleWrap);
    if (meta.live) { const live = el('span', 'fw-src fw-src--live'); live.append(el('span', 'fw-live-dot'), el('span', null, t('football_live', 'LIVE'))); head.appendChild(live); }
    wrap.appendChild(head);

    wrap.appendChild(addBox());

    const list = el('div', 'fw-list');
    if (teamsData === null && !favorites.length) list.appendChild(el('div', 'fw-state', t('football_loading', 'Loading…')));
    else if (!rows.length) list.appendChild(el('div', 'fw-state', t('football_empty', 'Nothing yet — search a team or competition above')));
    else rows.forEach(td => list.appendChild(row(td)));
    wrap.appendChild(list);
    mount.replaceChildren(wrap);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.football-widget-mount');
      if (!mount) return;
      if (view.mode === 'detail') detailView(mount);
      else listView(mount);
    });
  }

  async function refresh() {
    const d = await api('/api/football?refresh=1');
    if (d) applySeed(d);
    paint();
  }
  function applySeed(d) {
    if (Array.isArray(d.teams)) teamsData = d.teams;
    if (Array.isArray(d.favorites)) favorites = d.favorites;
    if (d.tile && typeof d.tile === 'object') tileCfg = d.tile;
    if (typeof d.live === 'boolean') meta.live = d.live;
    if (d.refreshedAt) meta.refreshedAt = d.refreshedAt;
    if (window.Ticker) window.Ticker.setSource('football', tickerItems());
  }
  function tickerItems() {
    // One chip per favorite: latest score, or next fixture + time. A league chip
    // shows its featured match; a team chip is result-coloured (win/loss).
    return (teamsData || []).map(td => {
      const pid = perspId(td);
      const live = [td.next, td.last].find(e => e && e.status === 'live');
      const ev = live || td.last || td.next;
      if (!ev) return null;
      const res = pid ? resultOf(ev, pid) : '';
      const dir = live ? 'live' : (res === 'w' ? 'up' : res === 'l' ? 'down' : 'flat');
      const sc = scoreText(ev);
      const value = sc ? (ev.home + ' ' + sc + ' ' + ev.away) : ('→ ' + sideLabel(ev, td) + ' ' + (whenShort(ev) || ''));
      return { label: td.name, value: value.trim(), dir };
    }).filter(Boolean);
  }
  async function seed() {
    if (!tiles().length || seedInflight) return;
    seedInflight = true;
    try {
      const d = await api('/api/football');
      if (d) applySeed(d);
      else if (teamsData === null) teamsData = [];
    } finally { seedInflight = false; }
    paint();
  }

  // ── public API ──
  function renderWidgets() {
    if (!tiles().length) { seeded = false; return; }
    paint();
    if (!seeded) { seeded = true; seed(); }
  }
  function onSSE(cache) {
    if (cache && Array.isArray(cache.teams)) {
      teamsData = cache.teams;
      if (typeof cache.live === 'boolean') meta.live = cache.live;
      if (cache.refreshedAt) meta.refreshedAt = cache.refreshedAt;
      if (window.Ticker) window.Ticker.setSource('football', tickerItems());
      paint();
    }
  }

  window.FootballWidget = { renderWidgets, onSSE };
})();
