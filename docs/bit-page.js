// docs/bit-page.js: the Bit page (bit.html). With #<number> it draws that person's Bit as
// their own Xenon does, from the hub's public answer (GET /bit/<n>: its look, number, name,
// stage, what it wears and its badges, never what it learnt). Without one it shows the
// classic Bit. Under the sheet, the Bits shown last (GET /bit/stats). A Bit is here only
// while its owner shows it (the Bit sheet in the app, server/bit/publish.js).
// Needs /create/bit-kit.js first (the engine). Every name from the hub goes in as text, and
// the small Bits are pictures (an <img> of an SVG the engine wrote), never markup.
(() => {
  'use strict';
  const X = globalThis.Xenon;
  const HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  const HASH = /^#([1-9]\d{0,8})$/;
  const STAGES = ['baby', 'young', 'adult', 'veteran', 'legend'];
  const NAME_MAX = 24;
  const RECENT_MAX = 12;
  const TIMEOUT_MS = 10000;
  const TILE = '#302E31'; // the ground of the small Bits, the sheet's own

  const WORDS = {
    en: { number: 'Bit #{n}', bornOf: '{number}, hatched on {date}.', born: 'Hatched on {date}.', stageOf: '{stage}, stage {i} of 5.', founder: 'One of the Founders: its Xenon was there before Bits hatched.', shiny: 'Shiny, as 1 Bit in {n} is.', classic: 'Classic green, as 1 Bit in {n} is.', trait: 'Its rarest trait shows up on 1 Bit in {n}.', looking: 'Looking for Bit #{n}.', missing: 'Bit #{n} is not on the site. Its owner may have taken it down.', offline: 'The page could not reach Xenon. Try again in a minute.', count: '{born} Bits hatched, {shown} shown here.', none: 'No Bit is shown here yet.', baby: 'Baby', young: 'Young', adult: 'Adult', veteran: 'Veteran', legend: 'Legend' },
    it: { number: 'Bit n. {n}', bornOf: '{number}, nato il {date}.', born: 'Nato il {date}.', stageOf: '{stage}, stadio {i} di 5.', founder: 'Uno dei Fondatori: il suo Xenon c’era già prima che nascessero i Bit.', shiny: 'Brillante, come 1 Bit su {n}.', classic: 'Verde classico, come 1 Bit su {n}.', trait: 'Il suo tratto più raro ce l’ha 1 Bit su {n}.', looking: 'Cerco il Bit n. {n}.', missing: 'Il Bit n. {n} non è sul sito. Forse chi lo ha lo ha tolto.', offline: 'La pagina non raggiunge Xenon. Riprova tra un minuto.', count: '{born} Bit nati, {shown} mostrati qui.', none: 'Qui non è ancora mostrato nessun Bit.', baby: 'Cucciolo', young: 'Giovane', adult: 'Adulto', veteran: 'Veterano', legend: 'Leggenda' },
    es: { number: 'Bit n.º {n}', bornOf: '{number}, nacido el {date}.', born: 'Nacido el {date}.', stageOf: '{stage}, etapa {i} de 5.', founder: 'Uno de los Fundadores: su Xenon ya estaba antes de que nacieran los Bits.', shiny: 'Brillante, como 1 Bit de cada {n}.', classic: 'Verde clásico, como 1 Bit de cada {n}.', trait: 'Su rasgo más raro lo tiene 1 Bit de cada {n}.', looking: 'Buscando el Bit n.º {n}.', missing: 'El Bit n.º {n} no está en el sitio. Puede que su dueño lo haya quitado.', offline: 'La página no pudo conectar con Xenon. Inténtalo de nuevo en un minuto.', count: '{born} Bits nacidos, {shown} mostrados aquí.', none: 'Aún no se muestra ningún Bit aquí.', baby: 'Cría', young: 'Joven', adult: 'Adulto', veteran: 'Veterano', legend: 'Leyenda' },
    fr: { number: 'Bit n° {n}', bornOf: '{number}, éclos le {date}.', born: 'Éclos le {date}.', stageOf: '{stage}, stade {i} sur 5.', founder: 'Un des Fondateurs : son Xenon était là avant l’éclosion des Bits.', shiny: 'Chromatique, comme 1 Bit sur {n}.', classic: 'Vert classique, comme 1 Bit sur {n}.', trait: 'Son trait le plus rare ne se voit que sur 1 Bit sur {n}.', looking: 'Recherche du Bit n° {n}.', missing: 'Le Bit n° {n} n’est pas sur le site. Son propriétaire l’a peut-être retiré.', offline: 'La page n’a pas pu joindre Xenon. Réessayez dans une minute.', count: '{born} Bits éclos, {shown} montrés ici.', none: 'Aucun Bit n’est encore montré ici.', baby: 'Bébé', young: 'Jeune', adult: 'Adulte', veteran: 'Vétéran', legend: 'Légende' },
    ja: { number: 'Bit #{n}', bornOf: '{number}、{date}に誕生。', born: '{date}に誕生。', stageOf: '{stage}（5段階中{i}段階目）。', founder: 'Bit が生まれる前からある Xenon で生まれた、ファウンダーの Bit です。', shiny: '色違いで、{n}体に1体です。', classic: 'クラシックグリーンで、{n}体に1体です。', trait: 'いちばん珍しい特徴は{n}体に1体です。', looking: 'Bit #{n} を探しています。', missing: 'Bit #{n} はサイトにありません。持ち主が取り下げた可能性があります。', offline: 'Xenon に接続できませんでした。少し待ってからもう一度お試しください。', count: '誕生した Bit は {born} 体、ここで公開中は {shown} 体です。', none: 'まだ公開されている Bit はありません。', baby: 'ベビー', young: 'ヤング', adult: 'アダルト', veteran: 'ベテラン', legend: 'レジェンド' },
    ko: { number: 'Bit #{n}', bornOf: '{number}, {date}에 태어났어요.', born: '{date}에 태어났어요.', stageOf: '{stage}, 5단계 중 {i}단계예요.', founder: 'Bit가 태어나기 전부터 있던 Xenon에서 태어난 창립 멤버예요.', shiny: '이로치예요. {n}마리 중 1마리꼴이에요.', classic: '클래식 그린이에요. {n}마리 중 1마리꼴이에요.', trait: '가장 희귀한 특징은 {n}마리 중 1마리만 가져요.', looking: 'Bit #{n}을(를) 찾는 중이에요.', missing: 'Bit #{n}은(는) 사이트에 없어요. 주인이 내렸을 수 있어요.', offline: 'Xenon에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.', count: '태어난 Bit {born}마리, 여기 공개된 Bit {shown}마리.', none: '아직 공개된 Bit가 없어요.', baby: '아기', young: '청소년', adult: '어른', veteran: '베테랑', legend: '전설' },
    zh: { number: 'Bit #{n}', bornOf: '{number}，{date} 孵化。', born: '{date} 孵化。', stageOf: '{stage}，五个阶段中的第 {i} 个。', founder: '创始成员：它的 Xenon 在 Bit 出现之前就已经在了。', shiny: '闪光，{n} 个 Bit 中才有 1 个。', classic: '经典绿，{n} 个 Bit 中才有 1 个。', trait: '它最稀有的特征，{n} 个 Bit 中才有 1 个。', looking: '正在查找 Bit #{n}。', missing: 'Bit #{n} 不在网站上，可能已被主人撤下。', offline: '无法连接 Xenon，请稍后再试。', count: '已孵化 {born} 个 Bit，这里展示 {shown} 个。', none: '这里还没有展示任何 Bit。', baby: '幼崽', young: '少年', adult: '成年', veteran: '老兵', legend: '传奇' },
  };
  const lang = (document.documentElement.lang || 'en').slice(0, 2);
  const W = WORDS[lang] || WORDS.en;
  const say = (key, vars = {}) => String(W[key] || WORDS.en[key]).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
  const num = (n) => new Intl.NumberFormat(lang).format(n);
  const date = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' });
  };

  const $ = (id) => document.getElementById(id);
  const title = $('pg-h');
  const stage = $('bit-stage');
  const caption = $('bit-caption');
  const note = $('bit-note');
  const NAME = title.textContent.trim();
  const ready = !!(X && X.bit && X.bitLook && X.bitWardrobe && X.bitPlayer && globalThis.XenonBit);

  // The hub's answer of one Bit, checked here: anything off and it is not drawn.
  function clean(b) {
    if (!b || typeof b !== 'object' || !Number.isSafeInteger(b.number) || b.number < 1) return null;
    if (!b.genes || typeof b.genes !== 'object') return null;
    const name = typeof b.name === 'string' ? [...b.name.replace(/[\p{C}]/gu, '').trim()].slice(0, NAME_MAX).join('') : '';
    const rare = Array.isArray(b.rarity) ? b.rarity[0] : null;
    return {
      number: b.number,
      name,
      stage: STAGES.includes(b.stage) ? b.stage : 'baby',
      worn: Array.isArray(b.worn) ? b.worn.filter((id) => typeof id === 'string').slice(0, 16) : [],
      founder: b.founder === true,
      born: typeof b.born === 'string' ? b.born : '',
      genes: b.genes,
      rare: rare && Number.isFinite(rare.oneIn) && rare.oneIn > 1 ? { gene: String(rare.gene), id: String(rare.id), oneIn: rare.oneIn } : null,
    };
  }

  async function getJson(path) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(HUB + path, { credentials: 'omit', signal: ctl.signal });
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally { clearTimeout(timer); }
  }

  // The big Bit: the person's own, the egg while it is being looked for, or the classic one.
  let big = null; // { key, api }
  function bigBit(key, label) {
    if (big && big.key === key) {
      const svg = stage.querySelector('svg[role="img"]');
      if (svg) svg.setAttribute('aria-label', label);
      return big.api;
    }
    if (big) big.api.destroy();
    stage.replaceChildren();
    const api = key === 'classic' ? X.bitPlayer.mount(stage, { label, mood: 'idle' }) : globalThis.XenonBit.mount(stage, { label });
    big = { key, api };
    return api;
  }

  function rareText(r) {
    if (!r) return '';
    const key = r.gene === 'shiny' ? 'shiny' : r.id === 'classic' ? 'classic' : 'trait';
    return say(key, { n: num(r.oneIn) });
  }

  // What the page says of a Bit, as sentences: its number and hatch day, its stage, then
  // what makes it rare. Japanese and Chinese sentences follow each other with no space.
  function facts(bit, number) {
    const day = bit.born ? date(bit.born) : '';
    const born = day ? say(bit.name ? 'bornOf' : 'born', { number, date: day }) : (bit.name ? number + '.' : '');
    const stage = say('stageOf', { stage: say(bit.stage), i: STAGES.indexOf(bit.stage) + 1 });
    return [born, stage, bit.founder ? say('founder') : '', rareText(bit.rare)]
      .filter(Boolean).join(lang === 'ja' || lang === 'zh' ? '' : ' ');
  }

  function setLine(el, text) {
    el.textContent = text;
    el.hidden = !text;
  }

  function showClassic(message) {
    title.textContent = NAME;
    setLine(caption, '');
    setLine(note, message || '');
    if (ready) bigBit('classic', NAME);
  }

  let asked = 0;
  async function showOne(n) {
    const ask = ++asked;
    const number = say('number', { n: num(n) });
    title.textContent = number;
    setLine(caption, '');
    setLine(note, say('looking', { n: num(n) }));
    bigBit('bit:' + n, number).set({ ok: true, hatched: false });
    let out = null;
    try { out = await getJson('/bit/' + n); } catch { out = null; }
    if (ask !== asked) return;
    const bit = out && out.body && out.body.ok === true ? clean(out.body.bit) : null;
    if (!bit || bit.number !== n) {
      showClassic(out && out.status === 404 ? say('missing', { n: num(n) }) : say('offline'));
      return;
    }
    title.textContent = bit.name || number;
    setLine(caption, facts(bit, number));
    setLine(note, '');
    bigBit('bit:' + n, bit.name || number).set({ ok: true, hatched: true, genes: bit.genes, worn: bit.worn });
  }

  function route() {
    const m = HASH.exec(location.hash);
    if (m) showOne(Number(m[1]));
    else showClassic('');
  }

  // A small Bit as a picture, in the pose it strikes for a photo.
  function still(bit) {
    const look = X.bitLook.lookOf(bit.genes, { worn: X.bitWardrobe.outfit(bit.worn), background: TILE });
    const clip = X.bit.clip('pose') || X.bit.clip('idle');
    const svg = X.bit.frameSvg(clip, X.bitPlayer.stillIndex(clip), { size: 160, look, clipId: 'bitp' + bit.number });
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function tile(bit) {
    let src;
    try { src = still(bit); } catch { return null; }
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'bitp-tile';
    a.href = '#' + bit.number;
    const img = new Image(160, 160);
    img.alt = '';
    img.decoding = 'async';
    img.src = src;
    const number = say('number', { n: num(bit.number) });
    a.append(img, Object.assign(document.createElement('b'), { textContent: bit.name || number }),
      Object.assign(document.createElement('span'), { textContent: bit.name ? number : say(bit.stage) }));
    li.append(a);
    return li;
  }

  async function showRecent() {
    const line = $('bit-count');
    const grid = $('bit-grid');
    let out = null;
    try { out = await getJson('/bit/stats'); } catch { out = null; }
    const body = out && out.body;
    if (!body || body.ok !== true || !Number.isSafeInteger(body.born) || !Number.isSafeInteger(body.shown)) {
      line.textContent = say('offline');
      return;
    }
    const tiles = (Array.isArray(body.recent) ? body.recent : []).slice(0, RECENT_MAX).map(clean).filter(Boolean).map(tile).filter(Boolean);
    line.textContent = tiles.length ? say('count', { born: num(body.born), shown: num(body.shown) }) : say('none');
    grid.replaceChildren(...tiles);
  }

  if (!ready) {
    setLine(note, say('offline'));
    return;
  }
  window.addEventListener('hashchange', () => {
    if (location.hash && !HASH.test(location.hash)) return; // an anchor on the page (#wardrobe): the browser scrolls there
    route();
    const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
    title.focus({ preventScroll: true });
  });
  route();
  showRecent();
})();
