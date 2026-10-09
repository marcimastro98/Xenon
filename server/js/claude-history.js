'use strict';
// The Claude tile's Chats face: every Claude Code chat kept on this PC, newest
// first, with its size, and a way to move the ones you no longer need to the
// Recycle Bin/Trash. Claude Code itself has no list and no delete.
//
// The tile rebuilds on every SSE push, so all state lives here and render()
// only draws it. Ids go to the server, never paths. Titles are the user's own
// prompts or Claude's summaries: textContent only, through el().
(function () {
  const ACTIVE_LABEL_MS = 60 * 1000;
  let list = null;           // null = not loaded yet
  let totalBytes = 0;
  let loading = false;
  let error = '';
  let notice = '';
  let project = '';          // '' = every project
  let confirming = false;
  let busy = false;
  const picked = new Set();

  function visible() {
    return (list || []).filter((s) => !project || s.project === project);
  }

  async function load(h) {
    if (loading) return;
    loading = true; error = ''; h.paint();
    const d = await apiJson('/api/claude/history');
    loading = false;
    if (d && d.ok) {
      list = d.sessions;
      totalBytes = d.totalBytes || 0;
      const alive = new Set(list.map((s) => s.id));
      for (const id of picked) if (!alive.has(id)) picked.delete(id);
      if (project && !list.some((s) => s.project === project)) project = '';
    } else {
      error = h.t('claude_hist_error', 'Could not read the chats on this PC.');
      if (!list) list = [];
    }
    h.paint();
  }

  async function removePicked(h) {
    if (busy || !picked.size) return;
    busy = true; notice = ''; h.paint();
    const d = await apiJson('/api/claude/history/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: Array.from(picked) }),
    });
    busy = false; confirming = false;
    const removed = (d && d.removed) || [];
    const kept = (d && d.refused) || [];
    removed.forEach((id) => picked.delete(id));
    notice = !d ? h.t('claude_hist_error', 'Could not read the chats on this PC.')
      : kept.length
        ? h.t('claude_hist_partial', '{n} moved to the Recycle Bin, {k} kept: still in use or locked.')
          .replace('{n}', String(removed.length)).replace('{k}', String(kept.length))
        : h.t('claude_hist_done', '{n} moved to the Recycle Bin.').replace('{n}', String(removed.length));
    await load(h);
  }

  function sizeOf(ids) {
    const want = new Set(ids);
    return (list || []).reduce((n, s) => n + (want.has(s.id) ? s.bytes : 0), 0);
  }

  function head(h, rows) {
    const el = makeEl;
    const top = el('div', 'cw-hist-head');
    const sum = el('div', 'cw-hist-sum');
    sum.appendChild(el('span', 'cw-hist-count', h.t('claude_hist_count', '{n} chats').replace('{n}', String((list || []).length))));
    sum.appendChild(el('span', 'cw-hist-size', formatBytes(totalBytes)));
    top.appendChild(sum);

    const projects = Array.from(new Set((list || []).map((s) => s.project).filter(Boolean))).sort();
    if (projects.length > 1) {
      const sel = el('select', 'cw-hist-proj');
      sel.setAttribute('aria-label', h.t('claude_hist_project', 'Project'));
      sel.appendChild(new Option(h.t('claude_hist_all', 'All projects'), ''));
      projects.forEach((p) => sel.appendChild(new Option(p, p)));
      sel.value = project;
      sel.addEventListener('change', () => { project = sel.value; confirming = false; h.paint(); });
      top.appendChild(sel);
    }
    const refresh = el('button', 'cw-hist-icon', '↻');
    refresh.type = 'button';
    refresh.title = h.t('claude_hist_refresh', 'Refresh');
    refresh.setAttribute('aria-label', refresh.title);
    refresh.disabled = loading || busy;
    refresh.addEventListener('click', () => { notice = ''; load(h); });
    top.appendChild(refresh);

    const free = rows.filter((s) => !s.busy);
    const allOn = free.length > 0 && free.every((s) => picked.has(s.id));
    const all = el('button', 'cw-hist-btn', allOn ? h.t('claude_hist_none', 'Clear selection') : h.t('claude_hist_select_all', 'Select all'));
    all.type = 'button';
    all.disabled = !free.length || busy;
    all.addEventListener('click', () => {
      free.forEach((s) => (allOn ? picked.delete(s.id) : picked.add(s.id)));
      confirming = false; h.paint();
    });
    top.appendChild(all);
    return top;
  }

  function actionBar(h) {
    const el = makeEl;
    const bar = el('div', 'cw-hist-bar' + (confirming ? ' is-confirm' : ''));
    const ids = Array.from(picked);
    if (confirming) {
      bar.appendChild(el('p', 'cw-hist-ask', h.t('claude_hist_confirm', 'Move {n} chats ({size}) to the Recycle Bin? You can restore them from there.')
        .replace('{n}', String(ids.length)).replace('{size}', formatBytes(sizeOf(ids)))));
      const no = el('button', 'cw-hist-btn', h.t('claude_hist_cancel', 'Cancel'));
      no.type = 'button'; no.disabled = busy;
      no.addEventListener('click', () => { confirming = false; h.paint(); });
      const yes = el('button', 'cw-hist-btn is-danger', busy ? h.t('claude_hist_moving', 'Moving…') : h.t('claude_hist_move', 'Move to Recycle Bin'));
      yes.type = 'button'; yes.disabled = busy;
      yes.addEventListener('click', () => removePicked(h));
      bar.append(no, yes);
      return bar;
    }
    bar.appendChild(el('span', 'cw-hist-picked', h.t('claude_hist_picked', '{n} selected · {size}')
      .replace('{n}', String(ids.length)).replace('{size}', formatBytes(sizeOf(ids)))));
    const del = el('button', 'cw-hist-btn is-danger', h.t('claude_hist_delete', 'Delete'));
    del.type = 'button';
    del.addEventListener('click', () => { confirming = true; notice = ''; h.paint(); });
    bar.appendChild(del);
    return bar;
  }

  function row(h, s) {
    const el = makeEl;
    const li = el('li', 'cw-hist-row' + (s.busy ? ' is-busy' : '') + (picked.has(s.id) ? ' is-on' : ''));
    const box = el('input', 'cw-hist-check');
    box.type = 'checkbox';
    box.checked = picked.has(s.id);
    box.disabled = s.busy || busy;
    box.setAttribute('aria-label', s.title || h.t('claude_hist_untitled', 'Empty chat'));
    box.addEventListener('change', () => {
      if (box.checked) picked.add(s.id); else picked.delete(s.id);
      confirming = false; h.paint();
    });
    li.appendChild(box);

    // The text opens the conversation in the Ask panel, to read or continue it.
    const open = el('button', 'cw-hist-open');
    open.type = 'button';
    open.appendChild(el('span', 'cw-hist-title' + (s.title ? '' : ' is-empty'), s.title || h.t('claude_hist_untitled', 'Empty chat')));
    const age = Date.now() - (s.at || 0);
    const when = s.busy ? h.t('claude_hist_in_use', 'In use')
      : age < ACTIVE_LABEL_MS ? h.t('claude_hist_now', 'just now')
        : h.t('claude_hist_ago', '{t} ago').replace('{t}', h.ago(age));
    const meta = [s.project, when, formatBytes(s.bytes)].filter(Boolean).join(' · ');
    open.appendChild(el('span', 'cw-hist-meta', meta));
    open.addEventListener('click', () => h.openAsk(s.id, s.title || s.project || ''));
    li.appendChild(open);
    return li;
  }

  /** h = { t, ago, paint, openAsk } */
  function render(h) {
    const el = makeEl;
    if (list === null && !loading) load(h);
    const face = el('div', 'cw-hist');
    if (list === null) {
      face.appendChild(el('div', 'cw-state', h.t('claude_reading', 'Reading local Claude Code sessions…')));
      return face;
    }
    const rows = visible();
    face.appendChild(head(h, rows));
    if (error) face.appendChild(el('p', 'cw-hist-note is-error', error));
    if (notice) face.appendChild(el('p', 'cw-hist-note', notice));
    if (!rows.length) {
      face.appendChild(el('div', 'cw-state', h.t('claude_hist_empty', 'No Claude Code chats on this PC.')));
      return face;
    }
    const ul = el('ul', 'cw-hist-list');
    rows.forEach((s) => ul.appendChild(row(h, s)));
    face.appendChild(ul);
    if (picked.size) face.appendChild(actionBar(h));
    return face;
  }

  window.ClaudeHistory = { render };
})();
