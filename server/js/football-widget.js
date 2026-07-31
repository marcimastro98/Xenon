'use strict';
// Football (Calcio) widget — a match-centric view of everything the user
// follows: a hero band with the most relevant match (in play > kicking off soon
// > last result), then one of three tabs — every followed team's and
// competition's fixtures merged into a single day-by-day feed, the league table,
// or headlines about the teams being followed.
//
// It used to be a list of SUBSCRIPTIONS: one row per followed team, that team's
// whole existence squeezed into a two-line cell, and a permanent search box on
// top. When the provider had no fixture in the window (off-season, an
// international break, a freshly seeded favorite) a row had nothing at all —
// not even a crest, because the crest was harvested from the match. The server
// now holds club identity separately (`info`: crest, colours, stadium,
// capacity, year founded), so a team is something to look at even with no game
// scheduled.
//
// Data is pushed over SSE ('football' → onSSE) and seeded once on mount
// (GET /api/football, which also returns the favorites list so every followed
// team shows even before its fixtures resolve). Teams are added through a real
// SEARCH (GET /api/football/search); favorites are persisted via
// POST /api/football/teams; the league table (GET /api/football/standings) and
// the headlines (GET /api/football/news) are fetched on demand, when their tab
// is opened. All external strings render through textContent; crest URLs are
// used as <img src> only when https (the server already host-checks them).
(function () {
  const el = makeEl;        // shared DOM factory (utils.js)
  const api = apiJson;      // fetch → JSON, null on failure (utils.js)
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  let teamsData = null;     // null = not seeded yet; [] once seeded. Server payload (one per favorite)
  let favorites = [];       // [{id,type,name,badge,league,leagueId}] from the server — persists across SSE
  let info = {};            // teamId → { badge, colour, stadium, capacity, founded, desc, … }
  let tileCfg = { results: true, standings: true };
  let meta = { live: false, refreshedAt: 0 };
  let seeded = false, seedInflight = false;
  let view = { mode: 'list', tab: 'matches', teamId: '', favType: 'team' };
  let managing = false;     // the add/manage panel, opened from the + in the tab bar
  let tableLeague = '';     // league id selected in the Classifica tab
  const standingsCache = new Map(); // `${leagueId}|${season}` → data

  // News is per-tab and cheap to keep: fetched on the first open, then reused
  // (the server caches it for 15 minutes anyway).
  let newsItems = null, newsLoading = false;

  // A favorite is a team or a league/competition; key/dedup by type+id.
  function favKey(f) { return (f && f.type === 'league' ? 'L:' : 'T:') + (f && f.id); }
  function isLeague(td) { return !!(td && td.type === 'league'); }
  // Match perspective: a team entry is shown opponent-centric; a league entry has
  // no "my team", so matches show both sides plainly.
  function perspId(td) { return isLeague(td) ? '' : (td && td.id); }
  function infoFor(id) { return (id && info && info[id]) || null; }

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
  // A crest for one SIDE of a match: the event carries its own badges, and the
  // identity cache fills in the followed club's when the event's is missing.
  function sideCrest(ev, side, cls) {
    const id = side === 'home' ? ev.homeId : ev.awayId;
    const nm = side === 'home' ? ev.home : ev.away;
    const inf = infoFor(id);
    return crest((side === 'home' ? ev.homeBadge : ev.awayBadge) || (inf && inf.badge) || '', nm, cls);
  }
  function matchDate(ev) {
    if (!ev) return null;
    const iso = ev.ts || (ev.date ? ev.date + 'T' + (ev.time || '00:00:00') : '');
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  }
  function matchMs(ev) { const d = matchDate(ev); return d ? d.getTime() : 0; }
  function timeText(ev) {
    const d = matchDate(ev);
    if (!d) return '';
    try { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
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
  function relTime(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const s = Math.max(0, (Date.now() - n) / 1000);
    if (s < 60) return t('news_now', 'now');
    if (s < 3600) return Math.floor(s / 60) + t('news_min', 'm');
    if (s < 86400) return Math.floor(s / 3600) + t('news_hour', 'h');
    const d = Math.floor(s / 86400);
    if (d < 7) return d + t('news_day', 'd');
    try { return new Date(n).toLocaleDateString([], { day: '2-digit', month: 'short' }); } catch { return ''; }
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
  // Club colour → a CSS custom property. The server validated it as a hex
  // triplet; anything it rejected arrives as '' and the theme accent stands.
  function applyClubColour(node, id) {
    const inf = infoFor(id);
    if (node && inf && inf.colour) node.style.setProperty('--fw-club', inf.colour);
  }

  // ── the merged match feed ────────────────────────────────────────────────
  // Every followed team and competition contributes its fixtures and results to
  // ONE chronological feed. Dedup is by event id and is not optional: a derby
  // between two followed teams appears in both of their lists, and a followed
  // competition repeats every match its clubs also carry.
  function mergeMatches() {
    const byId = new Map();
    for (const td of (teamsData || [])) {
      const owner = { id: td.id, type: td.type || 'team', name: td.name };
      for (const ev of [].concat(td.lastList || [], td.nextList || [])) {
        if (!ev || !ev.id) continue;
        const prev = byId.get(ev.id);
        if (prev) {
          // A team owner wins over a competition owner: "my team" is what the
          // row should highlight, and the league entry knows no side.
          if (!prev.mine && owner.type === 'team') prev.mine = owner.id;
          continue;
        }
        byId.set(ev.id, { ev, mine: owner.type === 'team' ? owner.id : '', from: owner });
      }
    }
    return Array.from(byId.values());
  }

  // Buckets a merged feed into display groups. Anything finished goes to
  // RISULTATI however recent it is; anything still to play is grouped by its own
  // day, so "OGGI" never contains a match that has already been decided.
  function groupByDay(rows, now) {
    const startOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const today = startOf(now);
    const upcoming = [];
    const past = [];
    for (const r of rows) {
      const ms = matchMs(r.ev);
      const done = r.ev.status === 'ft' || (r.ev.status !== 'live' && ms && ms < now - 3 * 3600 * 1000);
      (done ? past : upcoming).push({ ...r, ms });
    }
    upcoming.sort((a, b) => (a.ms || 0) - (b.ms || 0));
    past.sort((a, b) => (b.ms || 0) - (a.ms || 0));

    const groups = [];
    let lastKey = null;
    for (const r of upcoming) {
      const day = r.ms ? startOf(r.ms) : 0;
      const key = 'd' + day;
      if (key !== lastKey) {
        lastKey = key;
        groups.push({ key, label: dayLabel(day, today), rows: [] });
      }
      groups[groups.length - 1].rows.push(r);
    }
    if (past.length) groups.push({ key: 'past', label: t('football_results', 'Results'), rows: past.slice(0, 8) });
    return groups;
  }
  function dayLabel(dayMs, todayMs) {
    if (!dayMs) return '';
    const diff = Math.round((dayMs - todayMs) / 86400000);
    if (diff === 0) return t('football_today', 'Today');
    if (diff === 1) return t('football_tomorrow', 'Tomorrow');
    try { return new Date(dayMs).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' }); }
    catch { return ''; }
  }

  // The one match the tile leads with: in play, else the next one to kick off,
  // else the most recent result. Never an arbitrary favorite's fixture.
  function heroPick(rows, now) {
    let live = null, next = null, last = null;
    for (const r of rows) {
      const ms = matchMs(r.ev);
      if (r.ev.status === 'live') { if (!live || ms < matchMs(live.ev)) live = r; continue; }
      if (r.ev.status === 'ft' || (ms && ms < now - 3 * 3600 * 1000)) {
        if (!last || ms > matchMs(last.ev)) last = r;
      } else if (ms >= now - 3 * 3600 * 1000) {
        if (!next || ms < matchMs(next.ev)) next = r;
      }
    }
    return live || next || last || null;
  }

  // ── hero band ──
  function heroBand(pick) {
    const ev = pick.ev;
    const mine = pick.mine || '';
    const band = el('div', 'fw-hero' + (ev.status === 'live' ? ' is-live' : ''));
    applyClubColour(band, mine || ev.homeId);

    const top = el('div', 'fw-hero-top');
    const lb = statusBadge(ev);
    if (lb) top.appendChild(lb);
    else if (ev.status === 'ft') top.appendChild(el('span', 'fw-badge', t('football_ft', 'Full time')));
    else { const w = whenLong(ev); if (w) top.appendChild(el('span', 'fw-hero-when', w)); }
    if (ev.league) top.appendChild(el('span', 'fw-hero-league', ev.round && ev.round !== '0' ? ev.league + ' · ' + t('football_round', 'MD') + ' ' + ev.round : ev.league));
    band.appendChild(top);

    const mid = el('div', 'fw-hero-mid');
    const side = (name, node, isMine) => {
      const s = el('div', 'fw-hero-side' + (isMine ? ' is-mine' : ''));
      s.appendChild(node);
      s.appendChild(el('div', 'fw-hero-team', name));
      return s;
    };
    mid.appendChild(side(ev.home, sideCrest(ev, 'home', 'fw-crest--lg'), !!mine && ev.homeId === mine));
    const centre = el('div', 'fw-hero-centre');
    if (ev.homeScore != null && ev.awayScore != null) centre.appendChild(el('div', 'fw-hero-score', ev.homeScore + ' – ' + ev.awayScore));
    else centre.appendChild(el('div', 'fw-hero-kick', timeText(ev) || t('football_vs', 'vs')));
    mid.appendChild(centre);
    mid.appendChild(side(ev.away, sideCrest(ev, 'away', 'fw-crest--lg'), !!mine && ev.awayId === mine));
    band.appendChild(mid);

    if (ev.venue) band.appendChild(el('div', 'fw-hero-venue', ev.venue));
    band.addEventListener('click', () => openMatchOwner(pick));
    return band;
  }

  // Tapping a match opens the followed entity it belongs to — the team when one
  // of ours is playing, otherwise the competition it came from.
  function openMatchOwner(r) {
    const id = r.mine || (r.from && r.from.id) || '';
    if (!id) return;
    const type = r.mine ? 'team' : ((r.from && r.from.type) || 'team');
    openDetail(id, type);
  }
  function openDetail(id, type) {
    view = { mode: 'detail', tab: view.tab, teamId: id, favType: type || 'team' };
    paint();
    const td = (teamsData || []).find(x => x.id === id && isLeague(x) === (type === 'league'));
    if (td) loadStandingsFor(td);
  }

  // ── tab bar ──
  function tabsBar() {
    const bar = el('div', 'fw-tabs');
    const tab = (id, label) => {
      const b = el('button', 'fw-tab' + (view.tab === id ? ' is-on' : '')); b.type = 'button';
      b.textContent = label;
      // Each tab fetches from its own render, so switching to one is only ever
      // a state change here — there is no second place that has to remember to
      // kick a load off.
      b.addEventListener('click', () => { view.tab = id; paint(); });
      return b;
    };
    bar.append(
      tab('matches', t('football_tab_matches', 'Matches')),
      tab('table', t('football_tab_table', 'Table')),
      tab('news', t('football_tab_news', 'News')),
    );
    if (meta.live) { const live = el('span', 'fw-src fw-src--live'); live.append(el('span', 'fw-live-dot'), el('span', null, t('football_live', 'LIVE'))); bar.appendChild(live); }
    const add = el('button', 'fw-manage' + (managing ? ' is-on' : '')); add.type = 'button';
    add.setAttribute('aria-label', t('football_add', 'Follow a team'));
    add.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    add.addEventListener('click', () => { managing = !managing; if (!managing) { searchQuery = ''; searchResults = []; } paint(); });
    bar.appendChild(add);
    return bar;
  }

  // ── manage panel (search + the followed list) ──
  function managePanel() {
    const panel = el('div', 'fw-manage-panel');
    panel.appendChild(addBox());
    const list = favorites.length ? favorites : (teamsData || []);
    if (list.length) {
      const chips = el('div', 'fw-chips');
      list.forEach(f => {
        const chip = el('div', 'fw-chip' + (f.type === 'league' ? ' fw-chip--league' : ''));
        const open = el('button', 'fw-chip-open'); open.type = 'button';
        const inf = infoFor(f.id);
        open.appendChild(crest(f.badge || (inf && inf.badge) || '', f.name, 'fw-crest--sm' + (f.type === 'league' ? ' fw-crest--league' : '')));
        open.appendChild(el('span', 'fw-chip-name', f.name || f.id));
        open.addEventListener('click', () => { managing = false; openDetail(f.id, f.type || 'team'); });
        chip.appendChild(open);
        const rm = el('button', 'fw-chip-rm'); rm.type = 'button';
        rm.setAttribute('aria-label', t('football_remove', 'Remove'));
        rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        rm.addEventListener('click', () => removeTeam(f.id, f.type));
        chip.appendChild(rm);
        chips.appendChild(chip);
      });
      panel.appendChild(chips);
    }
    return panel;
  }

  // ── matches tab ──
  function matchesTab(rows) {
    const host = el('div', 'fw-feed');
    if (!rows.length) return identityFallback(host);
    // The competition is only worth a line per row when there is more than one
    // in the feed. Following a single league, it printed "Italian Serie A" under
    // every match, which is noise dressed as information.
    const leagues = new Set(rows.map(r => r.ev.leagueId || r.ev.league).filter(Boolean));
    const showLeague = leagues.size > 1;
    const groups = groupByDay(rows, Date.now());
    groups.forEach(g => {
      host.appendChild(el('div', 'fw-daysep', g.label));
      const box = el('div', 'fw-day');
      g.rows.forEach(r => box.appendChild(matchRow(r, showLeague)));
      host.appendChild(box);
    });
    return host;
  }

  function matchRow(r, showLeague) {
    const ev = r.ev;
    const mine = r.mine || '';
    const row = el('button', 'fw-match' + (ev.status === 'live' ? ' is-live' : '')); row.type = 'button';
    const res = mine ? resultOf(ev, mine) : '';

    // Crests sit on the OUTER edges of the row, so they line up down both sides
    // of the feed and are the first thing the eye lands on — which is the whole
    // point of having them.
    const home = el('div', 'fw-match-side fw-match-home' + (mine && ev.homeId === mine ? ' is-mine' : ''));
    home.appendChild(sideCrest(ev, 'home', 'fw-crest--sm'));
    home.appendChild(el('span', 'fw-match-team', ev.home || ''));
    row.appendChild(home);

    const mid = el('div', 'fw-match-mid' + (res ? ' fw-res--' + res : ''));
    const sc = scoreText(ev);
    if (ev.status === 'live') {
      mid.appendChild(el('span', 'fw-match-score is-live', sc || '–'));
      mid.appendChild(el('span', 'fw-match-min', ev.progress || t('football_live', 'LIVE')));
    } else if (sc) {
      mid.appendChild(el('span', 'fw-match-score', sc));
    } else if (ev.status === 'pp') {
      mid.appendChild(el('span', 'fw-badge fw-badge--pp', t('football_pp', 'Postp.')));
    } else {
      mid.appendChild(el('span', 'fw-match-time', timeText(ev) || '—'));
    }
    row.appendChild(mid);

    const away = el('div', 'fw-match-side fw-match-away' + (mine && ev.awayId === mine ? ' is-mine' : ''));
    away.appendChild(el('span', 'fw-match-team', ev.away || ''));
    away.appendChild(sideCrest(ev, 'away', 'fw-crest--sm'));
    row.appendChild(away);

    if (showLeague && ev.league) row.appendChild(el('div', 'fw-match-league', ev.league));
    row.addEventListener('click', () => openMatchOwner(r));
    return row;
  }

  // With nothing scheduled anywhere, the followed clubs are still worth
  // drawing: crest, ground, capacity, year founded. A blank list would say the
  // widget is broken; this says the calendar is empty, which is the truth.
  function identityFallback(host) {
    const list = favorites.length ? favorites : (teamsData || []);
    if (!list.length) {
      host.appendChild(el('div', 'fw-state', t('football_empty', 'Nothing yet — search a team or competition above')));
      return host;
    }
    host.appendChild(el('div', 'fw-daysep', t('football_no_fixtures', 'No matches scheduled')));
    const box = el('div', 'fw-idcards');
    list.forEach(f => box.appendChild(identityCard(f)));
    host.appendChild(box);
    return host;
  }

  function identityCard(f) {
    const inf = infoFor(f.id);
    const card = el('button', 'fw-idcard'); card.type = 'button';
    applyClubColour(card, f.id);
    card.appendChild(crest(f.badge || (inf && inf.badge) || '', f.name, 'fw-crest--lg' + (f.type === 'league' ? ' fw-crest--league' : '')));
    const body = el('div', 'fw-idcard-body');
    body.appendChild(el('div', 'fw-idcard-name', f.name || f.id));
    const bits = [];
    if (f.type === 'league') bits.push(t('football_competition', 'Competition'));
    else {
      if (inf && inf.stadium) bits.push(inf.stadium);
      else if (f.league) bits.push(f.league);
      if (inf && inf.founded) bits.push(String(inf.founded));
    }
    if (bits.length) body.appendChild(el('div', 'fw-idcard-sub', bits.join(' · ')));
    card.appendChild(body);
    card.addEventListener('click', () => openDetail(f.id, f.type || 'team'));
    return card;
  }

  // ── table tab ──
  // The leagues worth offering: every followed competition, plus the league each
  // followed club actually plays in (which the fixtures tell us, so a club that
  // moved division is right without anyone editing a setting).
  function tableLeagues() {
    const out = [];
    const seen = new Set();
    const push = (id, name, season) => {
      if (!id || seen.has(id)) return;
      seen.add(id);
      out.push({ id, name: name || id, season: season || '' });
    };
    for (const td of (teamsData || [])) {
      if (isLeague(td)) push(td.id, td.name, td.season);
    }
    for (const td of (teamsData || [])) {
      if (!isLeague(td) && td.leagueId) push(td.leagueId, td.league, td.season);
    }
    for (const f of favorites) {
      if (f.type === 'league') push(f.id, f.name, '');
      else if (f.leagueId) push(f.leagueId, f.league, '');
    }
    return out;
  }

  function tableTab() {
    const host = el('div', 'fw-feed');
    const leagues = tableLeagues();
    if (!leagues.length) { host.appendChild(el('div', 'fw-state', t('football_empty', 'Nothing yet — search a team or competition above'))); return host; }
    const current = leagues.find(l => l.id === tableLeague) || leagues[0];
    if (leagues.length > 1) {
      const chips = el('div', 'fw-lchips');
      leagues.forEach(l => {
        const b = el('button', 'fw-lchip' + (l.id === current.id ? ' is-on' : '')); b.type = 'button';
        b.textContent = l.name;
        b.addEventListener('click', () => { tableLeague = l.id; paint(); loadStandings(l); });
        chips.appendChild(b);
      });
      host.appendChild(chips);
    }
    const key = current.id + '|' + (current.season || '');
    const table = standingsCache.get(key);
    if (table === undefined) { host.appendChild(el('div', 'fw-mini-loading', t('football_loading', 'Loading…'))); loadStandings(current); }
    else if (table === null) host.appendChild(el('div', 'fw-state', t('football_no_table', 'No table for this competition')));
    else host.appendChild(standingsTable(table, myIdsIn(current.id)));
    return host;
  }
  // Every followed club that plays in this league, so the table can highlight
  // more than one row (following Napoli and Inter is the normal case).
  function myIdsIn(leagueId) {
    const ids = new Set();
    for (const td of (teamsData || [])) if (!isLeague(td) && td.leagueId === leagueId) ids.add(td.id);
    for (const f of favorites) if (f.type !== 'league' && f.leagueId === leagueId) ids.add(f.id);
    return ids;
  }

  function standingsTable(table, mineIds) {
    const mine = mineIds instanceof Set ? mineIds : new Set(mineIds ? [mineIds] : []);
    const box = el('div', 'fw-table');
    const head = el('div', 'fw-tr fw-tr--head');
    [['0', '#'], ['1', ''], ['2', t('football_col_played', 'P')], ['3', t('football_col_gd', 'GD')],
     ['4', t('football_col_points', 'Pts')], ['5', t('football_form', 'Form')]].forEach(([i, label]) => {
      head.appendChild(el('span', 'fw-th fw-col-' + i, label));
    });
    box.appendChild(head);
    table.rows.slice(0, 24).forEach(r => {
      const tr = el('div', 'fw-tr' + (mine.has(r.teamId) ? ' is-mine' : ''));
      tr.appendChild(el('span', 'fw-td fw-col-0', r.rank != null ? String(r.rank) : ''));
      const teamCell = el('span', 'fw-td fw-col-1');
      teamCell.appendChild(crest(r.badge || ((infoFor(r.teamId) || {}).badge) || '', r.team, 'fw-crest--xs'));
      teamCell.appendChild(el('span', 'fw-td-team', r.team));
      tr.appendChild(teamCell);
      tr.appendChild(el('span', 'fw-td fw-col-2', r.played != null ? String(r.played) : ''));
      tr.appendChild(el('span', 'fw-td fw-col-3', r.gd != null ? (r.gd > 0 ? '+' + r.gd : String(r.gd)) : ''));
      tr.appendChild(el('span', 'fw-td fw-col-4 fw-pts', r.points != null ? String(r.points) : ''));
      tr.appendChild(formStrip(r.form));
      box.appendChild(tr);
    });
    // A five-row table with nothing said about it reads as a broken table. The
    // provider caps it without a Premium key, so the tile says so once, under
    // the rows, instead of leaving the user to count them.
    if (table.partial) box.appendChild(el('div', 'fw-table-note', t('football_table_partial', 'The free data source only returns the top 5. A TheSportsDB Premium key shows the full table.')));
    return box;
  }
  // The last five, as letters rather than colour alone (the same colour-blind
  // safe rule the W/D/L chips follow). Already in the standings payload.
  function formStrip(form) {
    const cell = el('span', 'fw-td fw-col-5 fw-form');
    String(form || '').toUpperCase().replace(/[^WDL]/g, '').slice(-5).split('').forEach(ch => {
      cell.appendChild(el('span', 'fw-fdot fw-fdot--' + ch.toLowerCase(), ch));
    });
    return cell;
  }

  // ── news tab ──
  function newsTab() {
    const host = el('div', 'fw-feed');
    if (newsItems === null) {
      // The tab loads whatever put it in this state, not only a tap on it.
      // Adding or removing a team drops the cached headlines (they are about
      // the teams being followed), and while the tab was already open nothing
      // asked for them again — so the panel sat on "Loading…" forever. Same
      // shape as the table tab, which fetches from its own render.
      loadNews();
      host.appendChild(el('div', 'fw-mini-loading', t('football_loading', 'Loading…')));
      return host;
    }
    if (!newsItems.length) {
      host.appendChild(el('div', 'fw-state', t('football_news_empty', 'No headlines right now')));
      return host;
    }
    const list = el('div', 'fw-news-list');
    newsItems.forEach(it => list.appendChild(newsRow(it)));
    host.appendChild(list);
    return host;
  }
  function newsRow(it) {
    // Scheme allowlist before the href is written: escaping does not stop
    // javascript:/data: (see the URL invariant in CLAUDE.md).
    const href = /^https?:\/\//i.test(String(it.url || '')) ? String(it.url) : '';
    const row = el(href ? 'a' : 'div', 'fw-news');
    if (href) { row.href = href; row.target = '_blank'; row.rel = 'noopener noreferrer'; }
    row.appendChild(el('div', 'fw-news-title', it.title || ''));
    const m = el('div', 'fw-news-meta');
    if (it.source) m.appendChild(el('span', 'fw-news-src', it.source));
    const rt = relTime(it.published);
    if (rt) m.appendChild(el('span', 'fw-news-time', rt));
    row.appendChild(m);
    return row;
  }
  async function loadNews(force) {
    if (newsLoading) return;
    if (newsItems !== null && !force) return;
    newsLoading = true;
    try {
      const d = await api('/api/football/news');
      newsItems = (d && Array.isArray(d.items)) ? d.items : [];
    } finally { newsLoading = false; }
    if (view.tab === 'news') paint();
  }

  // ── search add box ──
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
      const rinfo = el('div', 'fw-result-info');
      rinfo.appendChild(el('div', 'fw-result-name', r.name || r.id));
      const sub = el('div', 'fw-result-sub');
      if (r.league) sub.appendChild(el('span', 'fw-result-league', r.league));
      if (r.country) sub.appendChild(el('span', 'fw-result-country', r.country));
      rinfo.appendChild(sub);
      item.appendChild(rinfo);
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
    if (ok) { searchQuery = ''; searchResults = []; searchSeq++; newsItems = null; await refresh(); }
    else if (window.XenonToast) window.XenonToast.show({ type: 'error', title: t('football_add_fail', 'Could not add'), message: r.name || r.id });
  }
  async function removeTeam(id, type) {
    const ok = await postTeams('remove', { id, type: type || 'team' });
    if (ok) {
      if (view.mode === 'detail' && view.teamId === id) view = { mode: 'list', tab: view.tab, teamId: '', favType: 'team' };
      newsItems = null;
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
    const inf = infoFor(td.id);
    const wrap = el('div', 'fw-detail');
    applyClubColour(wrap, td.id);

    const head = el('div', 'fw-detail-head');
    const back = el('button', 'fw-back'); back.type = 'button'; back.setAttribute('aria-label', t('back', 'Back'));
    back.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>';
    back.addEventListener('click', () => { view = { mode: 'list', tab: view.tab, teamId: '', favType: 'team' }; paint(); });
    head.appendChild(back);
    head.appendChild(crest(td.badge || (inf && inf.badge) || '', td.name, 'fw-crest--lg' + (isLeague(td) ? ' fw-crest--league' : '')));
    const titleBox = el('div', 'fw-detail-title');
    titleBox.append(el('div', 'fw-detail-name', td.name || td.id));
    const dsub = isLeague(td) ? t('football_competition', 'Competition') : (td.league || (inf && inf.league) || '');
    if (dsub) titleBox.append(el('div', 'fw-detail-league', dsub));
    head.appendChild(titleBox);
    const rm = el('button', 'fw-detail-rm'); rm.type = 'button'; rm.setAttribute('aria-label', t('football_remove', 'Remove'));
    rm.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
    rm.addEventListener('click', () => removeTeam(td.id, td.type));
    head.appendChild(rm);
    wrap.appendChild(head);

    const body = el('div', 'fw-detail-body fw-body');

    // Identity first: this is the part that is there whether or not anything is
    // scheduled, and it is why the detail view is never empty.
    if (inf) body.appendChild(identityStrip(inf));

    const hero = heroMatch(td);
    if (hero) body.appendChild(matchHero(hero, pid));

    const last = (td.lastList || []).slice(0, 5);
    if (tileCfg.results !== false && last.length) {
      body.appendChild(sectionTitle(t('football_recent', 'Recent results')));
      const listWrap = el('div', 'fw-mini-list');
      last.forEach(ev => listWrap.appendChild(miniResult(ev, pid)));
      body.appendChild(listWrap);
    }
    const upcoming = (td.nextList || []).filter(e => e.status !== 'ft').slice(0, 5);
    if (upcoming.length) {
      body.appendChild(sectionTitle(t('football_upcoming', 'Upcoming')));
      const listWrap = el('div', 'fw-mini-list');
      upcoming.forEach(ev => listWrap.appendChild(miniFixture(ev, pid)));
      body.appendChild(listWrap);
    }
    if (tileCfg.standings !== false && td.leagueId) {
      const key = td.leagueId + '|' + (td.season || '');
      const table = standingsCache.get(key);
      body.appendChild(sectionTitle((table && table.league) || t('football_standings', 'Standings')));
      if (table) body.appendChild(standingsTable(table, new Set([pid])));
      else if (table === null) body.appendChild(el('div', 'fw-mini-loading', t('football_no_table', 'No table for this competition')));
      else body.appendChild(el('div', 'fw-mini-loading', t('football_loading', 'Loading…')));
    }
    wrap.appendChild(body);
    mount.replaceChildren(wrap);
  }

  function identityStrip(inf) {
    const box = el('div', 'fw-ident');
    const facts = el('div', 'fw-ident-facts');
    const fact = (label, value) => {
      if (!value) return;
      const f = el('div', 'fw-fact');
      f.appendChild(el('div', 'fw-fact-v', String(value)));
      f.appendChild(el('div', 'fw-fact-k', label));
      facts.appendChild(f);
    };
    fact(t('football_stadium', 'Ground'), inf.stadium);
    fact(t('football_capacity', 'Capacity'), inf.capacity ? formatNum(inf.capacity) : '');
    fact(t('football_founded', 'Founded'), inf.founded || '');
    if (facts.childNodes.length) box.appendChild(facts);
    if (inf.desc) box.appendChild(el('div', 'fw-ident-desc', inf.desc));
    return box;
  }
  function formatNum(n) { try { return Number(n).toLocaleString(); } catch { return String(n); } }

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
    if (ev.league) top.appendChild(el('span', 'fw-hero-league', ev.round && ev.round !== '0' ? ev.league + ' · ' + t('football_round', 'MD') + ' ' + ev.round : ev.league));
    hero.appendChild(top);

    const mid = el('div', 'fw-hero-mid');
    const side = (name, node, mine) => { const s = el('div', 'fw-hero-side' + (mine ? ' is-mine' : '')); s.appendChild(node); s.appendChild(el('div', 'fw-hero-team', name)); return s; };
    mid.appendChild(side(ev.home, sideCrest(ev, 'home', 'fw-crest--lg'), ev.homeId === teamId));
    const centre = el('div', 'fw-hero-centre');
    if (ev.homeScore != null && ev.awayScore != null) centre.appendChild(el('div', 'fw-hero-score', ev.homeScore + ' – ' + ev.awayScore));
    else centre.appendChild(el('div', 'fw-hero-kick', timeText(ev) || t('football_vs', 'vs')));
    mid.appendChild(centre);
    mid.appendChild(side(ev.away, sideCrest(ev, 'away', 'fw-crest--lg'), ev.awayId === teamId));
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
    const oppSide = teamId ? (isHome(ev, teamId) ? 'away' : 'home') : 'home';
    row.appendChild(sideCrest(ev, oppSide, 'fw-crest--sm'));
    row.appendChild(el('span', 'fw-mini-opp', miniLabel(ev, teamId)));
    const w = whenShort(ev);
    row.appendChild(el('span', 'fw-mini-when', w || (teamId && isHome(ev, teamId) ? t('football_home', 'H') : t('football_away', 'A'))));
    return row;
  }

  async function loadStandings(league) {
    if (!league || !league.id || tileCfg.standings === false) return;
    const key = league.id + '|' + (league.season || '');
    if (standingsCache.has(key)) return;
    const d = await api('/api/football/standings?league=' + encodeURIComponent(league.id) + '&season=' + encodeURIComponent(league.season || ''));
    if (standingsCache.size > 16) standingsCache.delete(standingsCache.keys().next().value);
    // A miss is CACHED as null: a competition with no table (a cup, a season the
    // provider has not filled in) must say so once instead of refetching on
    // every repaint — which, with an SSE tick every couple of minutes, would be
    // a request loop nobody asked for.
    standingsCache.set(key, (d && Array.isArray(d.rows)) ? d : null);
    paint();
  }
  function loadStandingsFor(td) {
    if (!td || !td.leagueId) return;
    loadStandings({ id: td.leagueId, season: td.season || '' });
  }

  // ── list view ──
  function listView(mount) {
    const wrap = el('div', 'fw-wrap');
    const rows = mergeMatches();
    const pick = heroPick(rows, Date.now());
    if (pick) wrap.appendChild(heroBand(pick));
    wrap.appendChild(tabsBar());
    if (managing) wrap.appendChild(managePanel());

    const body = el('div', 'fw-body');
    if (teamsData === null && !favorites.length) body.appendChild(el('div', 'fw-state', t('football_loading', 'Loading…')));
    else if (view.tab === 'table') body.appendChild(tableTab());
    else if (view.tab === 'news') body.appendChild(newsTab());
    else body.appendChild(matchesTab(rows));
    wrap.appendChild(body);
    mount.replaceChildren(wrap);
  }

  function paint() {
    tiles().forEach(tile => {
      const mount = tile.querySelector('.football-widget-mount');
      if (!mount) return;
      // The whole mount is rebuilt on every SSE tick, so the scroll position of
      // the feed has to be carried across or a match list scrolls itself back to
      // the top every couple of minutes while the user is reading it.
      const prevBody = mount.querySelector('.fw-body');
      const top = prevBody ? prevBody.scrollTop : 0;
      if (view.mode === 'detail') detailView(mount);
      else listView(mount);
      if (top) { const next = mount.querySelector('.fw-body'); if (next) next.scrollTop = top; }
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
    if (d.info && typeof d.info === 'object') info = d.info;
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
      const value = sc ? (ev.home + ' ' + sc + ' ' + ev.away) : ('→ ' + (pid ? oppName(ev, pid) : (ev.home + ' – ' + ev.away)) + ' ' + (whenShort(ev) || ''));
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
      if (cache.info && typeof cache.info === 'object') info = cache.info;
      if (typeof cache.live === 'boolean') meta.live = cache.live;
      if (cache.refreshedAt) meta.refreshedAt = cache.refreshedAt;
      if (window.Ticker) window.Ticker.setSource('football', tickerItems());
      paint();
    }
  }

  window.FootballWidget = { renderWidgets, onSSE };
})();
