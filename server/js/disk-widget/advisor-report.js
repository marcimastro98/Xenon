// What the advisor's window is drawn from: its numbers, its sections, and the report Bit writes,
// read as headings, lists, tables and emphasis and built as elements, never as markup.
'use strict';

(() => {
  const { tr, fmtSize } = window.DiskWidgetWording;
  const { el } = window.DiskWidgetPieces;

  function advisorStat(label, value, detail) {
    const stat = el('div', 'diskw-modal-stat');
    stat.appendChild(el('span', '', label));
    stat.appendChild(el('strong', '', value));
    if (detail) stat.appendChild(el('small', '', detail));
    return stat;
  }

  function advisorFact(label, text) {
    const row = el('div', 'diskw-modal-fact');
    row.appendChild(el('strong', '', label));
    row.appendChild(el('p', '', text));
    return row;
  }

  // The provider returns markdown (headings, **bold**, `| tables |`, ---); the
  // panel used to drop it in as raw text, so the report read as a wall of
  // asterisks and pipes. This builds NODES, never innerHTML: every piece of the
  // untrusted AI text reaches the page through textContent, so there is nothing
  // to inject. It covers exactly what the storage report uses — headings,
  // lists, tables, rules, bold/italic/code — and anything unknown stays plain.
  const MD_INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_)/;

  function mdInline(node, text) {
    String(text).split(MD_INLINE_RE).forEach((p) => {
      if (!p) return;
      if (p.length > 2 && p[0] === '`' && p[p.length - 1] === '`') node.appendChild(el('code', 'diskw-md-code', p.slice(1, -1)));
      else if (p.length > 4 && (p.startsWith('**') || p.startsWith('__'))) node.appendChild(el('strong', '', p.slice(2, -2)));
      else if (p.length > 2 && (p[0] === '*' || p[0] === '_')) node.appendChild(el('em', '', p.slice(1, -1)));
      else node.appendChild(document.createTextNode(p));
    });
    return node;
  }

  const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const splitRow = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

  function renderAiMarkdown(box, raw) {
    const lines = String(raw || '').replace(/\r/g, '').split('\n');
    let list = null;
    const endList = () => { list = null; };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Horizontal rule.
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { endList(); box.appendChild(el('hr', 'diskw-md-hr')); continue; }

      // Table: a row, then a |---|---| separator, then rows until a non-row.
      if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        endList();
        const header = splitRow(line);
        const rows = [];
        let j = i + 2;
        for (; j < lines.length && isTableRow(lines[j]) && !isTableSep(lines[j]); j++) rows.push(splitRow(lines[j]));
        const scroller = el('div', 'diskw-md-tablewrap');
        const table = el('table', 'diskw-md-table');
        const thead = el('thead', '');
        const htr = el('tr', '');
        header.forEach((c) => mdInline(htr.appendChild(el('th', '')), c));
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = el('tbody', '');
        rows.forEach((cells) => {
          const tr = el('tr', '');
          for (let k = 0; k < header.length; k++) mdInline(tr.appendChild(el('td', '')), cells[k] || '');
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        scroller.appendChild(table);
        box.appendChild(scroller);
        i = j - 1;
        continue;
      }

      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        endList();
        const level = Math.min(heading[1].length, 4);
        mdInline(box.appendChild(el('div', 'diskw-md-h diskw-md-h' + level)), heading[2]);
        continue;
      }

      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
      const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        if (!list) { list = el('div', 'diskw-md-list'); box.appendChild(list); }
        const indent = ((bullet ? bullet[1] : numbered[1]) || '').length;
        const item = el('div', 'diskw-md-li' + (indent >= 2 ? ' is-sub' : ''));
        item.appendChild(el('span', 'diskw-md-bullet', numbered ? numbered[2] + '.' : '•'));
        mdInline(item.appendChild(el('div', 'diskw-md-litext')), bullet ? bullet[2] : numbered[3]);
        list.appendChild(item);
        continue;
      }

      endList();
      if (!line.trim()) continue;          // blank line = the gap between blocks
      mdInline(box.appendChild(el('div', 'diskw-md-p')), line);
    }
    return box;
  }

  function advisorStats(a) {
    const percent = (value) => (value != null ? Math.round(value) + '%' : '');
    const stats = el('div', 'diskw-modal-stats');
    stats.appendChild(advisorStat(tr('disk_used_space', 'Spazio usato'), fmtSize(a.used), percent(a.usedPercent)));
    stats.appendChild(advisorStat(tr('disk_free_space', 'Spazio libero'), fmtSize(a.free), percent(a.freePercent)));
    stats.appendChild(advisorStat(
      tr('disk_recommended_cleanup', 'Pulizia consigliata'),
      fmtSize(a.safeBytes),
      tr('disk_recommended_cleanup_hint', 'cache e temporanei rigenerabili')));
    stats.appendChild(advisorStat(
      tr('disk_personal_decision', 'Scelta personale'),
      fmtSize(a.reviewBytes + a.duplicateBytes),
      tr('disk_personal_decision_hint', 'Xenon non decide al posto tuo')));
    return stats;
  }

  function advisorSection(title, intro) {
    const section = el('section', 'diskw-modal-section');
    section.appendChild(el('h3', '', title));
    if (intro) section.appendChild(el('p', 'diskw-modal-section-intro', intro));
    return section;
  }

  window.DiskWidgetAdvisorReport = { advisorFact, renderAiMarkdown, advisorStats, advisorSection };
})();
