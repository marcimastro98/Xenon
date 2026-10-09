'use strict';
// The demo's UI layer, loaded LAST — after js/main.js, so the fake EventSource
// created by initDataStream() is already registered and the grid has mounted.
// Everything data-shaped lives in demo/boot.js; this file only adds what a
// visitor sees: the badge, the conversion prompts, the "not in the demo" marks,
// and the catalog hand-off.
(function () {
  // The demo's own words, in the site's six languages. The dashboard inside
  // follows its own language setting; this chrome follows the same one when the
  // app has set <html lang>, and the browser's otherwise.
  const S = {
    en: { badge: 'Demo with sample data', back: 'Back to the site', cta: 'Download', min: 'Minimize', open: 'Show', convert: 'Everything you just touched runs on your own PC. Xenon is free.', dismiss: 'Keep looking around', naTitle: 'Runs on your PC', na_browser: 'The Browser tile streams a real Chromium from your PC.', na_screen: 'This mirrors a display on your PC.', na_remote: 'Remote control needs Sunshine and Tailscale on your PC.', na_search: 'Local file search reads your own drives.', na_disk: 'Disk insights map your real drives.' },
    fr: { badge: 'Démo avec des données d\'exemple', back: 'Retour au site', cta: 'Télécharger', min: 'Réduire', open: 'Afficher', convert: 'Tout ce que vous venez de toucher fonctionne sur votre propre PC. Xenon est gratuit.', dismiss: 'Continuer à explorer', naTitle: 'Fonctionne sur votre PC', na_browser: 'La tuile Browser diffuse un vrai Chromium depuis votre PC.', na_screen: 'Ceci reproduit l’affichage de votre PC.', na_remote: 'La télécommande nécessite Sunshine et Tailscale sur votre PC.', na_search: 'La recherche de fichiers locaux lit vos propres lecteurs.', na_disk: 'Les analyses de disque cartographient vos disques réels.' },
    it: { badge: 'Demo con dati di esempio', back: 'Torna al sito', cta: 'Scarica', min: 'Riduci', open: 'Mostra', convert: 'Tutto quello che hai toccato gira sul tuo PC. Xenon è gratis.', dismiss: 'Continua a guardare', naTitle: 'Gira sul tuo PC', na_browser: 'Il riquadro Browser mostra un vero Chromium dal tuo PC.', na_screen: 'Questo riquadro mostra uno schermo del tuo PC.', na_remote: 'Il controllo remoto usa Sunshine e Tailscale sul tuo PC.', na_search: 'La ricerca file legge i tuoi dischi.', na_disk: 'L’analisi del disco mostra i tuoi dischi veri.' },
    es: { badge: 'Demo con datos de ejemplo', back: 'Volver al sitio', cta: 'Descargar', min: 'Minimizar', open: 'Mostrar', convert: 'Todo lo que acabas de tocar funciona en tu propio PC. Xenon es gratis.', dismiss: 'Seguir mirando', naTitle: 'Funciona en tu PC', na_browser: 'El recuadro Navegador muestra un Chromium real desde tu PC.', na_screen: 'Este recuadro refleja una pantalla de tu PC.', na_remote: 'El control remoto necesita Sunshine y Tailscale en tu PC.', na_search: 'La búsqueda de archivos lee tus propias unidades.', na_disk: 'El análisis de disco muestra tus unidades reales.' },
    ja: { badge: 'サンプルデータのデモ', back: 'サイトに戻る', cta: 'ダウンロード', min: '最小化', open: '表示', convert: '今触ったものはすべてあなたのPCで動きます。Xenonは無料です。', dismiss: 'このまま見る', naTitle: 'あなたのPCで動きます', na_browser: 'ブラウザータイルは、PC上の本物のChromiumを表示します。', na_screen: 'このタイルはPCの画面を映します。', na_remote: 'リモート操作にはPC上のSunshineとTailscaleが必要です。', na_search: 'ファイル検索はあなた自身のドライブを読み取ります。', na_disk: 'ディスク分析は実際のドライブを表示します。' },
    ko: { badge: '샘플 데이터로 보는 데모', back: '사이트로 돌아가기', cta: '다운로드', min: '최소화', open: '보기', convert: '방금 만져 본 것은 모두 내 PC에서 실행됩니다. Xenon은 무료입니다.', dismiss: '계속 둘러보기', naTitle: '내 PC에서 실행됩니다', na_browser: '브라우저 타일은 PC의 실제 Chromium을 보여 줍니다.', na_screen: '이 타일은 PC의 화면을 보여 줍니다.', na_remote: '원격 제어에는 PC의 Sunshine과 Tailscale이 필요합니다.', na_search: '파일 검색은 내 드라이브를 읽습니다.', na_disk: '디스크 분석은 실제 드라이브를 보여 줍니다.' },
    zh: { badge: '使用示例数据的演示', back: '返回网站', cta: '下载', min: '最小化', open: '显示', convert: '你刚才点过的一切都在你自己的电脑上运行。Xenon 是免费的。', dismiss: '继续看看', naTitle: '在你的电脑上运行', na_browser: '浏览器磁贴显示你电脑上真实的 Chromium。', na_screen: '这个磁贴显示你电脑上的一个屏幕。', na_remote: '远程控制需要电脑上的 Sunshine 和 Tailscale。', na_search: '文件搜索读取你自己的硬盘。', na_disk: '磁盘分析显示你真实的硬盘。' },
  };
  const lang = () => {
    const l = String(document.documentElement.lang || navigator.language || 'en').slice(0, 2).toLowerCase();
    return S[l] ? l : 'en';
  };
  const tr = (k) => S[lang()][k] || S.en[k];
  const track = (name, params) => { try { if (typeof window.xtrack === 'function') window.xtrack(name, params || {}); } catch { /* analytics is best-effort */ } };
  // Inside the home page's frame the site is already around the demo, with its
  // own Download key: the demo then only says that it is a demo.
  let embedded = false;
  try { embedded = window.self !== window.top; } catch { embedded = true; }

  // ── Badge ────────────────────────────────────────────────────────────────
  // Mounted on <html>, not <body>: edge-preview.js letterboxes and CSS-scales
  // <body> into a 2560x720 stage, so anything inside it gets squashed with the
  // dashboard. Same trick that file uses for its own chip (which owns the
  // bottom-RIGHT corner, hence bottom-left here).
  function mountBadge() {
    if (document.getElementById('demo-badge')) return;
    const bar = document.createElement('div');
    bar.id = 'demo-badge';
    if (embedded) bar.classList.add('is-embedded');

    const txt = document.createElement('span');
    txt.className = 'db-txt';
    txt.textContent = tr('badge');
    bar.appendChild(txt);
    if (embedded) { document.documentElement.appendChild(bar); return; }

    const back = document.createElement('a');
    back.className = 'db-back';
    back.href = '../';
    back.textContent = tr('back');

    const cta = document.createElement('a');
    cta.className = 'db-cta';
    cta.href = '../download.html';
    cta.textContent = tr('cta');
    // No JS needed: docs/analytics.js delegates on [data-track] in the capture
    // phase and turns data-track-* into event params.
    cta.setAttribute('data-track', 'demo_download_click');
    cta.setAttribute('data-track-location', 'badge');

    const min = document.createElement('button');
    min.type = 'button';
    min.className = 'db-min';
    const setMin = (collapsed) => {
      bar.classList.toggle('is-min', collapsed);
      min.textContent = collapsed ? '+' : '\u2212';
      min.setAttribute('aria-label', tr(collapsed ? 'open' : 'min'));
      min.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    min.addEventListener('click', () => {
      const collapsed = !bar.classList.contains('is-min');
      setMin(collapsed);
      // sessionStorage, not localStorage: a fresh visit should see it again.
      try { sessionStorage.setItem('xenon.demo.badge', collapsed ? '0' : '1'); } catch { /* private mode */ }
    });

    bar.appendChild(back); bar.appendChild(cta); bar.appendChild(min);
    document.documentElement.appendChild(bar);
    let collapsed = false;
    try { collapsed = sessionStorage.getItem('xenon.demo.badge') === '0'; } catch { /* private mode */ }
    setMin(collapsed);
  }

  // ── Conversion prompt ─────────────────────────────────────────────────────
  // The badge alone is wallpaper. This fires at the highest-intent moment there
  // is: the visitor has just tried to do something real and been told it needs
  // the app. Once per session, dismissible, never blocking.
  let promptShown = false;
  function showConvertPrompt(reason) {
    if (promptShown || embedded) return;
    try { if (sessionStorage.getItem('xenon.demo.prompt') === '1') return; } catch { /* private mode */ }
    promptShown = true;
    try { sessionStorage.setItem('xenon.demo.prompt', '1'); } catch { /* private mode */ }

    const sheet = document.createElement('div');
    sheet.id = 'demo-convert';

    const p = document.createElement('p');
    p.textContent = tr('convert');
    const row = document.createElement('div');
    row.className = 'dc-row';

    const go = document.createElement('a');
    go.className = 'dc-go';
    go.href = '../download.html';
    go.textContent = tr('cta');
    go.setAttribute('data-track', 'demo_download_click');
    go.setAttribute('data-track-location', 'sheet');

    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'dc-no';
    no.textContent = tr('dismiss');
    no.addEventListener('click', () => sheet.remove());

    row.appendChild(go); row.appendChild(no);
    sheet.appendChild(p); sheet.appendChild(row);
    document.documentElement.appendChild(sheet);
    track('demo_convert_prompt', { reason: reason || 'time' });
  }

  // A blocked write is the trigger; 90 seconds of browsing is the fallback.
  window.addEventListener('xenon:demo-blocked', () => showConvertPrompt('blocked'));
  setTimeout(() => showConvertPrompt('time'), 90000);

  // ── "Not available in the demo" ───────────────────────────────────────────
  // Tiles whose whole content streams from a real PC would otherwise render as a
  // dead black rectangle. A MutationObserver on the grid re-applies the mark, so
  // it survives page switches, tile duplication and layout edits without any
  // per-widget knowledge — and without patching a single source file.
  const UNAVAILABLE = { browser: 'na_browser', secondscreen: 'na_screen', remote: 'na_remote', search: 'na_search', disk: 'na_disk' };

  function markUnavailable() {
    Object.keys(UNAVAILABLE).forEach((key) => {
      document.querySelectorAll('[data-dashboard-widget="' + key + '"]').forEach((tile) => {
        if (tile.querySelector(':scope > .demo-na')) return;
        const veil = document.createElement('div');
        veil.className = 'demo-na';
        const inner = document.createElement('div');
        inner.className = 'demo-na-in';
        const h = document.createElement('b');
        h.textContent = tr('naTitle');
        const p = document.createElement('span');
        p.textContent = tr(UNAVAILABLE[key]);
        inner.appendChild(h); inner.appendChild(p);
        veil.appendChild(inner);
        // The tile is the positioning context the veil needs; only set it when
        // the tile has not already established one.
        if (getComputedStyle(tile).position === 'static') tile.style.position = 'relative';
        tile.appendChild(veil);
      });
    });
  }

  let markQueued = false;
  function queueMark() {
    if (markQueued) return;
    markQueued = true;
    requestAnimationFrame(() => { markQueued = false; markUnavailable(); });
  }

  // ── Catalog hand-off ──────────────────────────────────────────────────────
  // boot.js parked and stripped the fragment before anything could react to it.
  // The apply itself goes through the app's OWN import dialog, so the visitor
  // sees the real preview/permission flow (a selling point in itself) and the
  // demo contains zero apply code that could diverge from the product.
  async function ingestPreset() {
    const parked = window.__XENON_DEMO_PRESET__;
    if (!parked || !window.PresetShare || !PresetShare.openImport) return;
    let code = '';
    let meta = { source: 'import' };
    if (parked.mode === 'preset') {
      code = parked.value;
    } else {
      const id = parked.value;
      if (!/^[a-z0-9][a-z0-9_-]{0,60}$/.test(id)) return;
      try {
        const r = await fetch('../community/codes/' + id + '.txt', { cache: 'no-store' });
        if (r.ok) code = (await r.text()).trim();
      } catch { /* fall through to the catalog entry's inline code */ }
      if (!code) {
        try {
          const cat = await (await fetch('../community/catalog.json', { cache: 'no-store' })).json();
          const entry = (cat.entries || []).find((e) => e && e.id === id);
          if (entry && entry.code) code = String(entry.code).trim();
          if (entry) meta = { source: 'catalog', sourceId: id, sourceVersion: entry.version || '', perfWarning: entry.perfWarning === true };
        } catch { /* no code: the app's own invalid-import toast explains it */ }
      } else {
        meta = { source: 'catalog', sourceId: id };
      }
    }
    track('demo_preset_open', { item_id: parked.value, ok: !!code });
    if (!code) return;
    PresetShare.openImport(code, meta);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  function start() {
    mountBadge();
    markUnavailable();
    const grid = document.getElementById('dashboard') || document.body;
    new MutationObserver(queueMark).observe(grid, { childList: true, subtree: true });
    track('demo_start', { entry: window.__XENON_DEMO_PRESET__ ? 'catalog' : 'direct' });
    // Let the grid mount and any greeting claim its slot before a dialog opens
    // on top of it.
    setTimeout(() => { ingestPreset().catch(() => {}); }, 400);
  }

  if (document.readyState === 'complete') start();
  else window.addEventListener('load', start, { once: true });
})();
