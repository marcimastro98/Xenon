// Routes (#mappa, #cartelle, #f-<feature>), the language switch, and the start.

const LANG_KEY = 'xenon-map-lang';
let pending = null;

function render() {
  const hash = location.hash.slice(1) || 'mappa';
  const fid = hash.startsWith('f-') ? hash.slice(2) : null;
  const main = document.getElementById('main');
  main.replaceChildren(fid ? featureView(fid) : hash === 'cartelle' ? foldersView() : mapView());
  document.querySelectorAll('.views a').forEach((a) => {
    if (!fid && a.dataset.view === hash) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const f = fid ? featureById.get(fid) : null;
  document.title = f ? `${say(f.name)} · ${t('title')}` : t('title');
  if (pending && fid) { focusFile(pending.path, pending.sym); pending = null; }
}

/** Shows a file of the map, in its feature, pointing at a function if one is named. */
function openFile(path, sym) {
  const file = fileByPath.get(path);
  if (!file || !featureById.has(file.o)) return;
  const target = `#f-${file.o}`;
  if (location.hash === target) { focusFile(path, sym); return; }
  pending = { path, sym };
  location.hash = target;
}

function openFolder(dir) {
  if (location.hash !== '#cartelle') location.hash = '#cartelle';
  else render();
  let node = TREE;
  for (const part of dir.split('/')) {
    node = node.dirs.get(part);
    const button = [...document.querySelectorAll('button.dir')].find((b) => b.dataset.dir === node.path);
    if (!button) return;
    if (button.getAttribute('aria-expanded') !== 'true') button.click();
    if (node.path === dir) { flash(button); button.scrollIntoView({ block: 'center' }); }
  }
}

function setLanguage(next, search) {
  const lang = next === 'en' ? 'en' : 'it';
  reading.lang = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* the choice just is not remembered */ }
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.dataset.t); });
  const stamp = document.querySelector('.stamp');
  stamp.textContent = `${t('files', num(DATA.files.length))} · ${stamp.dataset.date}`;
  document.querySelectorAll('[data-t-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.tPlaceholder); });
  document.querySelectorAll('.lang button').forEach((b) => { b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });
  render();
  if (search) search.refresh();
}

function start() {
  let saved = '';
  try { saved = localStorage.getItem(LANG_KEY) || ''; } catch { /* no storage here */ }
  const first = saved || ((navigator.language || '').toLowerCase().startsWith('it') ? 'it' : 'en');
  const search = setupSearch((item) => {
    if (item.k === 'f') location.hash = `#f-${item.id}`;
    else if (item.k === 'd') openFolder(item.dir);
    else openFile(item.path, item.name);
  });
  document.querySelectorAll('.lang button').forEach((b) => { b.addEventListener('click', () => setLanguage(b.dataset.lang, search)); });
  document.addEventListener('click', (e) => {
    const leaf = e.target.closest('a.leaf[data-open]');
    if (leaf) { e.preventDefault(); openFile(leaf.dataset.open); }
  });
  window.addEventListener('hashchange', render);
  let width = 0;
  new ResizeObserver(() => {
    const holder = document.querySelector('.map');
    if (holder && holder.clientWidth !== width) { width = holder.clientWidth; drawMap(holder); }
  }).observe(document.getElementById('main'));
  setLanguage(first, null);
}

start();
