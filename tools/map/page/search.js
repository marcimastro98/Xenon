// One box over everything: features, folders, endpoints, functions, files, and the
// words of the comments. Every word typed must match; names beat descriptions.

const ORDER = ['f', 'd', 'r', 's', 'p', 'w'];
const SHOWN = { f: 6, d: 6, r: 10, s: 20, p: 20, w: 10 };

function buildIndex() {
  const index = [];
  for (const f of FEATURES) {
    index.push({ k: 'f', id: f.id, o: f.id, key: `${f.name.it} ${f.name.en} ${f.id}`.toLowerCase(), more: `${f.what.it} ${f.what.en}`.toLowerCase() });
  }
  const walk = (node) => {
    for (const child of node.dirs.values()) {
      index.push({ k: 'd', dir: child.path, key: child.path.toLowerCase(), o: ownersOf(child)[0]?.id || '' });
      walk(child);
    }
  };
  walk(TREE);
  for (const file of DATA.files) {
    index.push({ k: 'p', path: file.p, o: file.o, key: file.p.toLowerCase(), more: (file.d || '').toLowerCase() });
    for (const r of file.r || []) index.push({ k: 'r', path: file.p, o: file.o, name: r[0], line: r[1], doc: r[2], key: r[0].toLowerCase() });
    for (const fn of file.f || []) {
      index.push({ k: 's', path: file.p, o: file.o, name: fn[0], line: fn[1], doc: fn[2], key: fn[0].toLowerCase() });
      if (fn[2]) index.push({ k: 'w', path: file.p, o: file.o, name: fn[0], line: fn[1], doc: fn[2], key: fn[2].toLowerCase() });
    }
  }
  return index;
}

let INDEX = null;

function score(item, terms, whole) {
  let total = 0;
  for (const term of terms) {
    const at = item.key.indexOf(term);
    if (at < 0) {
      if (item.more?.includes(term)) { total += 1; continue; }
      return 0;
    }
    const tail = item.k === 'p' || item.k === 'd' ? item.key.slice(item.key.lastIndexOf('/') + 1) : item.key;
    total += tail === term ? 60 : tail.startsWith(term) ? 30 : tail.includes(term) ? 14 : 4;
  }
  return item.key === whole ? total + 40 : total;
}

function hitLines(item, terms) {
  const owner = featureById.get(item.o);
  const where = owner ? ` · ${say(owner.name)}` : '';
  switch (item.k) {
    case 'f': return [marked(say(featureById.get(item.id).name), terms), say(featureById.get(item.id).what)];
    case 'd': return [marked(`${item.dir}/`, terms), `${folderLine(item.dir)}${where}`];
    case 'p': return [marked(baseName(item.path), terms), [marked(item.path, terms), where]];
    case 'w': return [`${item.name}()`, [marked(item.doc, terms), ` · ${baseName(item.path)}:${item.line}`]];
    default: return [marked(item.k === 's' ? `${item.name}()` : item.name, terms), [`${item.path}:${item.line}`, item.doc ? ` · ${item.doc}` : where]];
  }
}

function setupSearch(go) {
  const input = document.getElementById('q');
  const box = document.getElementById('results');
  let hits = [];
  let active = -1;
  let timer = 0;
  const close = () => { box.hidden = true; input.setAttribute('aria-expanded', 'false'); active = -1; };
  const choose = (item) => { close(); input.blur(); go(item); };
  const mark = (n) => {
    const rows = box.querySelectorAll('.hit');
    if (rows.length === 0) return;
    active = (n + rows.length) % rows.length;
    rows.forEach((row, i) => { row.setAttribute('aria-selected', String(i === active)); });
    rows[active].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', rows[active].id);
  };
  const run = () => {
    const raw = input.value.trim().toLowerCase();
    if (raw.length < 2) { close(); return; }
    INDEX = INDEX || buildIndex();
    const terms = raw.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const item of INDEX) { const s = score(item, terms, raw); if (s > 0) scored.push([s, item]); }
    scored.sort((a, b) => b[0] - a[0] || a[1].key.length - b[1].key.length);
    const taken = Object.fromEntries(ORDER.map((k) => [k, 0]));
    hits = [];
    for (const [, item] of scored) if (taken[item.k] < SHOWN[item.k]) { taken[item.k] += 1; hits.push(item); }
    box.replaceChildren();
    if (hits.length === 0) box.append(h('p', { class: 'nohit' }, t('none', input.value.trim())));
    let n = 0;
    for (const kind of ORDER) {
      const group = hits.filter((item) => item.k === kind);
      if (group.length === 0) continue;
      const extra = scored.filter(([, item]) => item.k === kind).length - group.length;
      box.append(h('h4', null, t('kinds')[kind], extra > 0 ? ` ${t('more', num(extra))}` : ''));
      for (const item of group) {
        const [title, sub] = hitLines(item, terms);
        box.append(h('button', { class: 'hit', type: 'button', role: 'option', id: `hit-${n++}`, onmousedown: (e) => e.preventDefault(), onclick: () => choose(item) },
          h('span', { class: 't' }, title), h('span', { class: 's' }, sub)));
      }
    }
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = -1;
  };
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 80); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); mark(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active - 1); }
    else if (e.key === 'Enter') { const pick = hits[Math.max(active, 0)]; if (pick) { e.preventDefault(); choose(pick); } }
    else if (e.key === 'Escape') { close(); input.blur(); }
  });
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !typing) { e.preventDefault(); input.focus(); input.select(); }
  });
  return { refresh: () => { if (!box.hidden) run(); } };
}
