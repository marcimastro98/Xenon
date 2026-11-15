// The small pieces a match is drawn with: who plays at home, the score, the result, the state
// badge, the run of last results and the little labels.
'use strict';

(() => {
  const { t } = window.FootballWidgetMatchTime;

  const el = makeEl;        // shared DOM factory (utils.js)

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

  // The last five, as letters rather than colour alone (the same colour-blind
  // safe rule the W/D/L chips follow). Already in the standings payload.
  function formStrip(form) {
    const cell = el('span', 'fw-td fw-col-5 fw-form');
    String(form || '').toUpperCase().replace(/[^WDL]/g, '').slice(-5).split('').forEach(ch => {
      cell.appendChild(el('span', 'fw-fdot fw-fdot--' + ch.toLowerCase(), ch));
    });
    return cell;
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

  window.FootballWidgetMatchPieces = {
    el, isHome, oppName, scoreText, resultOf, statusBadge, formStrip, identityStrip, sectionTitle,
    miniLabel, miniResult,
  };
})();
