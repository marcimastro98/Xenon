// The map page and a feature's page.

function mapView() {
  const pieces = DATA.pieces[reading.lang] || DATA.pieces.en;
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const piece = (id) => {
    const p = byId.get(id);
    return h('div', { class: 'piece' }, h('b', null, p.name), h('code', null, p.where), h('span', null, p.what));
  };
  const arrow = (glyph, words) => h('div', { class: 'arrow', 'aria-hidden': 'true' }, h('i', null, glyph), words);
  const holder = h('div', { class: 'map', role: 'list' });
  const view = h('div', null,
    h('h1', null, t('title')),
    h('h2', null, t('howTitle')),
    h('div', { class: 'flow' }, piece('app'), arrow('→', t('shows')), piece('screen'), arrow('←', t('serves')), piece('engine'), arrow('→', t('asks')), piece('helpers')),
    h('p', { class: 'muted' }, t('appStarts')),
    h('h2', null, t('mapTitle')),
    h('p', null, t('mapHint')),
    holder);
  requestAnimationFrame(() => drawMap(holder));
  return view;
}

/** One function, method or route as a table row: tap the name to copy path:line. */
function symbolRow(path, [name, line, doc], exported) {
  return h('tr', null,
    h('td', null, h('button', { type: 'button', class: exported ? 'x' : null, 'data-sym': name, title: `${path}:${line}`, onclick: () => copyText(`${path}:${line}`) }, name)),
    h('td', { class: 'l' }, t('line', line)),
    h('td', null, doc || ''));
}

function fileBlock(file) {
  const fns = file.f || [];
  const exported = new Set((file.x || []).map((x) => x.replace(/^window\./, '')));
  const inside = fns.length > 0 || (file.x || []).length > 0;
  const summary = h('summary', null,
    h('span', { class: 'fn' }, baseName(file.p)),
    file.d ? h('span', { class: 'd' }, file.d) : null,
    fns.length ? h('span', { class: 'n' }, t('fnCount', num(fns.length))) : null);
  const body = h('div', { class: 'body' },
    h('div', { class: 'path' }, h('span', null, file.p), h('button', { type: 'button', class: 'copy', onclick: () => copyText(file.p) }, t('copyPath'))),
    (file.x || []).length ? h('p', { class: 'exports' }, t('exports', file.x.join(', '))) : null,
    fns.length ? h('div', { class: 'scroll' }, h('table', { class: 'funcs' }, h('tbody', null, fns.map((fn) => symbolRow(file.p, fn, exported.has(fn[0])))))) : null,
    inside ? null : h('p', { class: 'muted' }, t('noInside')));
  return h('details', { class: 'file', 'data-path': file.p }, summary, body);
}

function featureView(id) {
  const f = featureById.get(id);
  if (!f) return h('p', null, t('gone'));
  const area = areaById.get(f.area);
  const list = filesOf.get(id);
  const folders = [...new Set(list.map((file) => dirName(file.p)))];
  const routes = list.flatMap((file) => (file.r || []).map((r) => ({ file, r })));
  const holder = h('div');
  const draw = (term) => {
    holder.replaceChildren();
    const want = term.trim().toLowerCase();
    let last = '';
    for (const file of list) {
      const words = `${file.p} ${file.d || ''} ${(file.f || []).map((fn) => `${fn[0]} ${fn[2] || ''}`).join(' ')}`.toLowerCase();
      if (want && !words.includes(want)) continue;
      const dir = dirName(file.p);
      if (dir !== last) { holder.append(h('div', { class: 'folder' }, `${dir}/`)); last = dir; }
      holder.append(fileBlock(file));
    }
    if (!holder.firstChild) holder.append(h('p', { class: 'muted' }, t('noFiles')));
  };
  draw('');
  return h('div', null,
    h('a', { class: 'back', href: '#mappa' }, t('back')),
    h('p', { class: 'muted' }, say(area.name)),
    h('h1', null, say(f.name)),
    h('p', null, say(f.what)),
    h('p', { class: 'facts' }, t('facts', num(list.length), num(folders.length), num(countOf(list, 'f')), num(routes.length))),
    h('h2', null, t('whereTitle')),
    h('div', { class: 'scroll' }, h('table', { class: 'where' }, h('tbody', null, folders.map((dir) => {
      const here = list.filter((file) => dirName(file.p) === dir).length;
      return h('tr', null, h('td', null, h('code', null, `${dir}/`)), h('td', { class: 'muted' }, t('files', num(here))), h('td', null, folderLine(dir)));
    })))),
    routes.length ? [
      h('h2', null, t('routesTitle')), h('p', { class: 'muted' }, t('routesHint')),
      h('div', { class: 'scroll' }, h('table', { class: 'routes' }, h('tbody', null, routes.map(({ file, r }) => h('tr', null,
        h('td', null, h('code', null, r[0])),
        h('td', null, h('button', { type: 'button', class: 'copy', onclick: () => copyText(`${file.p}:${r[1]}`) }, `${baseName(file.p)}:${r[1]}`)),
        h('td', null, r[2] || '')))))),
    ] : null,
    h('h2', null, t('filesTitle')),
    h('p', { class: 'muted' }, t('filesHint')),
    h('input', { class: 'filter', id: 'ffilter', type: 'search', placeholder: t('filter'), 'aria-label': t('filter'), oninput: (e) => draw(e.target.value) }),
    holder);
}

/** Opens a file in the page shown now and points at a function in it. */
function focusFile(path, sym) {
  const block = [...document.querySelectorAll('details.file')].find((d) => d.dataset.path === path);
  if (!block) return;
  block.open = true;
  flash(block);
  const row = sym ? [...block.querySelectorAll('[data-sym]')].find((b) => b.dataset.sym === sym) : null;
  if (row) flash(row.closest('tr'));
  (row || block).scrollIntoView({ block: 'center' });
}
