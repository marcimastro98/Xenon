// The home's widgets section. The words walk through what people ask for, the
// section takes each service's colour, and the box searches the built-in widgets
// and the catalog without any AI. Without this script the section is still a
// picture, a list of names and a link to the full list.
(function () {
  'use strict';

  const WALK_MS = 3200;
  const FIRST_STEP_MS = 2400;
  const RESUME_MS = 1200;
  const MAX_RESULTS = 5;
  const MIN_QUERY = 2;

  const flood = document.getElementById('widgets');
  if (!flood || !window.XT) return;

  const $ = (id) => document.getElementById(id);
  const T = window.XT;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const words = Array.from(flood.querySelectorAll('.word'));
  const figure = flood.querySelector('.flood-r');
  const shot = $('fw-shot');
  const have = $('fw-have');
  const fact = $('fw-fact');
  const pause = $('fw-pause');
  const pic = (word) => '/images/home/w-' + word.dataset.w + '.webp';

  let at = 0;
  let token = 0;

  function say(word) {
    const text = T(word.dataset.have || 'have');
    if (word.dataset.href) {
      const a = document.createElement('a');
      a.href = word.dataset.href;
      a.textContent = text;
      have.replaceChildren(a);
    } else {
      have.textContent = text;
    }
    fact.textContent = T(word.dataset.fact);
  }

  function show(i) {
    const word = words[i];
    if (!word || i === at) return;
    at = i;
    const my = ++token;
    flood.style.setProperty('--c', word.dataset.c);
    flood.style.setProperty('--k', word.dataset.k);
    words.forEach((b, n) => b.setAttribute('aria-pressed', String(n === i)));
    say(word);
    const img = new Image();
    img.alt = T('w.alt').replace('{w}', word.textContent);
    img.src = pic(word);
    const done = () => { if (my === token) shot.replaceChildren(img); };
    (img.decode ? img.decode() : Promise.resolve()).then(done, done);
  }

  // The walk stops for good at the first real choice, never runs off screen or
  // under reduced motion, and has a pause button (WCAG 2.2.2). The caption is
  // announced only once the visitor is the one changing it.
  let timer = null;
  let seen = false;
  let hovering = false;
  let stopped = reduce;

  function chose() {
    stopped = true;
    clearTimeout(timer);
    timer = null;
    figure.setAttribute('aria-live', 'polite');
    pause.hidden = true;
  }

  function tick() {
    timer = null;
    if (stopped) return;
    if (seen && !hovering && !document.hidden) show((at + 1) % words.length);
    timer = setTimeout(tick, WALK_MS);
  }

  words.forEach((b, i) => {
    const pick = () => { chose(); show(i); };
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') pick(); });
    b.addEventListener('focus', pick);
    b.addEventListener('click', pick);
  });

  if (reduce) pause.hidden = true;
  pause.addEventListener('click', () => {
    const wasPaused = pause.getAttribute('aria-pressed') === 'true';
    pause.setAttribute('aria-pressed', String(!wasPaused));
    stopped = !wasPaused;
    clearTimeout(timer);
    timer = wasPaused ? setTimeout(tick, RESUME_MS) : null;
  });
  figure.addEventListener('pointerenter', () => { hovering = true; });
  figure.addEventListener('pointerleave', () => { hovering = false; });

  if ('IntersectionObserver' in window) {
    const warm = new IntersectionObserver((es) => {
      if (!es[0].isIntersecting) return;
      warm.disconnect();
      words.forEach((w) => { const i = new Image(); i.src = pic(w); });
    }, { rootMargin: '700px 0px' });
    warm.observe(flood);
    new IntersectionObserver((es) => {
      seen = es[0].isIntersecting;
      if (seen && !timer && !stopped) timer = setTimeout(tick, FIRST_STEP_MS);
    }, { threshold: 0.45 }).observe(flood);
  }

  // The search: built-in names and keywords in the page's language and in
  // English, then the catalog's widgets and bundles. A name that starts with the
  // query beats a name that contains it, which beats a keyword; on a tie the
  // built-in widget goes first.
  const input = $('ask-in');
  const out = $('ask-out');
  const lang = window.XLANG || 'en';
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  const when = (v) => { const n = Date.parse(v || ''); return Number.isNaN(n) ? null : n; };
  const list = flood.querySelector('.flood-foot a');
  let index = [];
  let requested = false;
  let ready = false;

  const getJson = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  function builtIn(w) {
    const name = w.name[lang] || w.name.en;
    return {
      name,
      names: norm(name + ' ' + w.name.en),
      words: norm((w.words[lang] || '') + ' ' + (w.words.en || '')),
      note: T('ask.builtin'),
      href: list.href,
      order: 0,
    };
  }

  function fromCatalog(e) {
    const name = String(e.name).replace(/\s+/g, ' ').trim();
    return {
      name,
      names: norm(name),
      words: norm((e.tagline || '') + ' ' + (e.description || '')),
      note: T('ask.catalog'),
      href: '/catalog/#' + encodeURIComponent(e.id),
      order: 1,
    };
  }

  function listed(e, now) {
    if (!e || !e.id || !e.name || e.active === false) return false;
    if (e.kind !== 'widget' && e.kind !== 'bundle') return false;
    const from = when(e.activeFrom);
    const until = when(e.activeUntil);
    return (from == null || from <= now) && (until == null || until >= now);
  }

  async function load() {
    if (requested) return;
    requested = true;
    const [built, catalog] = await Promise.all([getJson('/widget-search.json'), getJson('/community/catalog.json')]);
    const now = Date.now();
    const entries = catalog && Array.isArray(catalog.entries) ? catalog.entries : [];
    index = ((built && built.widgets) || []).map(builtIn).concat(entries.filter((e) => listed(e, now)).map(fromCatalog));
    ready = true;
    answer();
  }

  function rank(item, q) {
    if (item.names.startsWith(q)) return 0;
    if (item.names.includes(q)) return 1;
    return item.words.includes(q) ? 2 : -1;
  }

  function result(item) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    const name = document.createElement('b');
    const note = document.createElement('span');
    a.href = item.href;
    name.textContent = item.name;
    note.textContent = item.note;
    a.append(name, note);
    li.append(a);
    return li;
  }

  // The Maker is the way out when nothing matches: the sentence names it, the
  // link is ours, so it is split here rather than kept as HTML in the strings.
  function nothing() {
    const [before, after] = T('ask.none').split('{maker}');
    const li = document.createElement('li');
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.href = '/maker/';
    a.textContent = 'Xenon Maker';
    p.append(before, a, after || '');
    li.append(p);
    return li;
  }

  function answer() {
    const q = norm(input.value).trim();
    out.replaceChildren();
    const hits = q.length < MIN_QUERY ? [] : index
      .map((item) => ({ item, score: rank(item, q) }))
      .filter((h) => h.score >= 0)
      .sort((a, b) => (a.score - b.score) || (a.item.order - b.item.order))
      .slice(0, MAX_RESULTS);
    out.hidden = q.length < MIN_QUERY || (!hits.length && !ready);
    if (out.hidden) return;
    if (hits.length) out.append(...hits.map((h) => result(h.item)));
    else out.append(nothing());
  }

  input.placeholder = T('ask.ph');
  input.addEventListener('focus', () => { chose(); load(); });
  input.addEventListener('input', answer);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    input.value = '';
    answer();
  });
  $('ask').addEventListener('submit', (e) => e.preventDefault());
})();
