'use strict';
// The Xenon Maker's live preview. The Maker (xenon-app.com/maker, same origin)
// opens this demo in a frame with ?maker and posts the widget being edited; it
// lands on a tile through the same path a Store widget takes, permission
// dialog included. boot.js has already given this visit its own in-memory
// storage, so nothing here reaches the visitor's own demo.
//
// The demo has no server to serve a package's files, and the sandbox the app
// uses (allow-scripts, no allow-same-origin) rules out the in-memory routes: a
// sandboxed frame bypasses service workers, and its opaque origin may not load
// blob: files. So the Maker sends ONE self-contained document (scripts and
// styles inline, pictures and fonts as data: URLs) and the frame keeps the
// app's sandbox. Its CSP is set HERE, never taken from the message: no
// network, no eval; inline scripts only because the document is one file.
(function () {
  const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;   // server/sdk-widgets.js
  const LIST_ITEM_RE = /^[a-z][A-Za-z0-9.]{0,40}$/;
  const HOST_RE = /^[a-z0-9.-]{1,253}$/;
  const VERSION_RE = /^[0-9A-Za-z._-]{1,20}$/;
  const CATEGORIES = ['productivity', 'media', 'system', 'streaming'];
  const TILE_SIZES = ['small', 'medium', 'wide', 'tall', 'large'];
  const HEAD = '<!doctype html><html><head>';
  const HTML_MAX = 4 * 1024 * 1024;

  // The app's own checks for a tile's outline and a widget's glyph, which are
  // cosmetic (no grant) and so carried over as the scan would keep them. Looked
  // up when used: the app's scripts may load after this one.
  const appChecks = () => (typeof window !== 'undefined' && window.DashboardInstances)
    || (() => { try { return require('../../server/js/dashboard-instances.js'); } catch { return null; } })();

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const list = (v, re) => (Array.isArray(v)
    ? [...new Set(v.filter((s) => typeof s === 'string' && re.test(s)))].slice(0, 32)
    : []);

  // A Maker manifest as the app's own scan would list it (normalizeManifest in
  // server/sdk-widgets.js; server/test/demo-maker.test.mjs keeps the two equal).
  // A Maker widget asks for streams, actions, hosts and storage, nothing else.
  function makerPackage(m) {
    if (!m || typeof m !== 'object' || !WIDGET_ID_RE.test(m.id)) return null;
    const name = str(m.name, 60);
    if (!name) return null;
    const surface = m.surface === 'ambient' ? 'ambient' : 'tile';
    const DI = appChecks();
    return {
      id: m.id, api: 1, name,
      version: VERSION_RE.test(m.version) ? m.version : '0.0.0',
      author: str(m.author, 60), description: str(m.description, 200),
      storage: m.storage === true, storageGroup: '', secrets: false,
      surface, background: false,
      island: false, islandDynamic: false, islandFull: false,
      badge: false, badgeAction: false, mini: false, topbarButton: false, clipboard: false,
      ai: m.ai === true, accent: false, expand: false,
      shape: surface === 'tile' && DI ? DI.normalizeTileShape(m.shape) : null,
      icon: DI ? DI.normalizeWidgetIcon(m.icon) : null,
      category: CATEGORIES.includes(m.category) ? m.category : null,
      size: surface === 'tile' && TILE_SIZES.includes(m.size) ? m.size : null,
      entry: 'index.html',
      streams: list(m.streams, LIST_ITEM_RE), actions: list(m.actions, LIST_ITEM_RE),
      hosts: list(m.hosts, HOST_RE).slice(0, 8),
      userHosts: [], hooks: [], deck: { actions: [], states: [], handlers: [] },
    };
  }

  // The preview's policy, put in front of everything the Maker wrote. A <meta>
  // CSP can only add restrictions, so anything later in the document narrows it
  // further at most. Pictures and fonts may also come from this site (the
  // demo's album covers), as the app allows its own origin.
  function previewCsp(origin) {
    const self = /^https?:\/\/[A-Za-z0-9.:[\]-]+$/.test(origin) ? ' ' + origin : '';
    return [
      "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
      'img-src data: blob:' + self, 'font-src data:' + self, 'media-src data: blob:' + self,
      "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'",
    ].join('; ');
  }

  function withCsp(html, origin) {
    if (typeof html !== 'string' || html.length > HTML_MAX || !html.startsWith(HEAD)) return null;
    return HEAD + '<meta http-equiv="Content-Security-Policy" content="' + previewCsp(origin) + '">'
      + html.slice(HEAD.length);
  }

  // { type: 'xenon-maker:widget', manifest, html, place? } → the package and its
  // document. A package's widget comes with place: false: it is only installed,
  // and shows in the page tiles that name it, as a package import binds it.
  function widgetFromMessage(msg, origin) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:widget') return null;
    const pkg = makerPackage(msg.manifest);
    const html = withCsp(msg.html, origin);
    return pkg && pkg.surface === 'tile' && html ? { pkg, html, place: msg.place !== false } : null;
  }

  // What the permission dialog grants a Maker package once allowed (the patch
  // in custom-widget.js showPermDialog), for the preview of a page or bundle:
  // there the widget sits in a scaled tile where a dialog cannot be read, and
  // the demo's data is sample data in this visit's in-memory storage. A widget
  // added on its own still goes through the dialog.
  function makerGrant(pkg) {
    return {
      streams: pkg.streams.slice(), actions: pkg.actions.slice(), hosts: pkg.hosts.slice(), userHosts: {},
      hooks: [], handlers: [], storage: pkg.storage === true, secrets: false,
      island: false, islandDynamic: false, islandFull: false, badge: false, badgeAction: false,
      // The demo has no AI of the user to ask: a widget that asks gets not_allowed.
      mini: false, topbarButton: false, clipboard: false, ai: false, accent: false, expand: false,
    };
  }

  // The package a tile frame asks for: custom-widget.js sets
  // `/sdk/widget/<id>/<entry>?v=N` (sdkAssetBase).
  function packageIdOfSrc(url) {
    const m = /^\/sdk\/widget\/([^/?#]+)\//.exec(String(url));
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch { return null; }
  }

  // { type: 'xenon-maker:theme', data } → the theme's data and its font, if any.
  // The data goes through the app's own import patch and normalizeSettings when
  // applied, as a theme code does; only the font is read here.
  const FONT_EXTS = ['woff2', 'woff', 'ttf', 'otf'];
  const FONT_MAX = 2 * 1024 * 1024;   // THEME_FONT_EMBED_MAX
  function themeFromMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:theme') return null;
    const data = msg.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const fd = data.fontData;
    const font = fd && typeof fd === 'object' && FONT_EXTS.includes(fd.ext) && typeof fd.data === 'string'
      && /^[A-Za-z0-9+/]*={0,2}$/.test(fd.data) && fd.data.length <= Math.ceil(FONT_MAX / 3) * 4
      ? { ext: fd.ext, data: fd.data } : null;
    const rest = Object.assign({}, data);
    delete rest.fontData;
    return { data: rest, font };
  }

  // { type: 'xenon-maker:bg', data: { name, code, fps?, assets? } } → the bgCustom an
  // imported background code sets (applyBg in preset-share.js); settings.js
  // normalizeBgCustom and custom-bg.js re-check it all when it is applied.
  const BG_CODE_MAX = 60000;   // custom-bg.js CODE_MAX
  function bgFromMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:bg') return null;
    const data = msg.data;
    if (!data || typeof data !== 'object' || typeof data.code !== 'string') return null;
    if (!data.code.trim() || data.code.length > BG_CODE_MAX) return null;
    const assets = data.assets;
    return {
      code: data.code,
      name: String(data.name || '').slice(0, 60),
      // The pictures the layers draw; normalizeBgAssets keeps only valid ones.
      assets: assets && typeof assets === 'object' && !Array.isArray(assets) ? assets : {},
      fps: data.fps,
      enabled: true,
      imported: true,
    };
  }

  // { type: 'xenon-maker:ambient', scene } → the canvas Ambient scene an imported
  // 'ambient-layout' code installs (applyAmbientLayout in preset-share.js);
  // AmbientScene.normalizeScene re-checks all of it when it is shown. A scene
  // larger than the app's server keeps (sanitizeAmbientScenes in server.js) is
  // refused, as it would not survive a save there either.
  const SCENE_JSON_MAX = 400000;
  function ambientFromMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:ambient') return null;
    const scene = msg.scene;
    if (!scene || typeof scene !== 'object' || Array.isArray(scene)) return null;
    let json = '';
    try { json = JSON.stringify(scene); } catch { return null; }
    return json.length <= SCENE_JSON_MAX ? scene : null;
  }

  // { type: 'xenon-maker:page', name, data: { items } } → the page preset an
  // imported 'page' code inserts (applyPage in preset-share.js); normalizePresets
  // re-checks every item when it is shown.
  const PAGE_ITEMS_MAX = 64;
  function pageFromMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:page') return null;
    const data = msg.data;
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
    if (!data.items.length || data.items.length > PAGE_ITEMS_MAX) return null;
    return { name: String(msg.name || '').slice(0, 40), items: data.items };
  }

  // The page's grid always has this id in the preview, so the Maker can find it
  // and every edit replaces the same page instead of adding one.
  const PAGE_ID = 'maker-page';
  // The dashboard holding only the page being edited, as an import would build
  // it on an empty dashboard. Mutates `layout`; false when the page is refused.
  // The custom tiles that name their package are added to `bind`.
  function layoutWithPage(layout, page, DP, bind = []) {
    // The widgets this dashboard knows are its layout's own.
    const known = Object.keys(layout.widgets || {});
    const [preset] = DP.normalizePresets([{ id: 'maker', name: page.name, kind: 'page', gridCols: 24, data: { items: page.items } }], known);
    if (!preset) return false;
    Object.keys(layout.widgets || {}).forEach((id) => { if (layout.widgets[id]) layout.widgets[id].visible = false; });
    layout.copies = [];
    layout.groups = {};
    layout.pages = [];
    const res = DP.insertPreset(layout, preset, null);
    if (!res || !res.ok || !res.pageId) return false;
    if (Array.isArray(res.bind)) bind.push(...res.bind);
    const rename = (o) => { if (o && o.page === res.pageId) o.page = PAGE_ID; };
    layout.pages.forEach((p) => { if (p.id === res.pageId) { p.id = PAGE_ID; delete p.imported; } });
    Object.values(layout.widgets || {}).forEach(rename);
    layout.copies.forEach(rename);
    Object.values(layout.groups).forEach(rename);
    return true;
  }

  // { type: 'xenon-maker:deck', profile, view: { path, page, lit } } → the Deck profile
  // an imported 'deck' code installs (sanitizeDeckProfile rebuilds it when it is
  // shown), the folder (key ids from the root) and page the editor is on, and
  // whether its state-bound keys are drawn lit.
  const DECK_JSON_MAX = 6 * 1024 * 1024;
  function deckFromMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:deck') return null;
    const profile = msg.profile;
    if (!profile || typeof profile !== 'object' || !profile.root || typeof profile.root !== 'object') return null;
    let size = 0;
    try { size = JSON.stringify(profile).length; } catch { return null; }
    if (size > DECK_JSON_MAX) return null;
    const v = msg.view && typeof msg.view === 'object' ? msg.view : {};
    const path = Array.isArray(v.path) ? v.path.filter((id) => typeof id === 'string').slice(0, 8) : [];
    const page = Number.isFinite(v.page) ? Math.max(0, Math.round(v.page)) : 0;
    return { profile, view: { path, page, lit: v.lit === true } };
  }

  // The Deck tile fills the preview page; its keys keep the author's grid
  // (no auto-fit), as the profile reads in a deck of that shape. The music
  // screen shows only when the profile styles it, so that style can be seen.
  const DECK_ID = 'deck';
  const DECK_ITEM = { type: 'widget', widget: 'deck', x: 0, y: 0, w: 24, h: 8 };
  function deckStore(profile, DM) {
    const id = 'maker';
    const config = DM.normalizeDeckConfig({
      cols: profile.cols, rows: profile.rows, autoFit: false, showMedia: !!(profile.look && profile.look.mediaStyle),
      profiles: [Object.assign({}, profile, { id })], activeProfile: id,
    });
    return { [DECK_ID]: config };
  }

  // { type: 'xenon-maker:topbar', data } → the whole bar, read by the app's own
  // reader (js/topbar-share.js) as an imported `topbar` code is.
  const topbarShare = () => (typeof window !== 'undefined' && window.TopbarShare)
    || (() => { try { return require('../../server/js/topbar-share.js'); } catch { return null; } })();
  function topbarFromMessage(msg) {
    if (!msg || typeof msg !== 'object' || msg.type !== 'xenon-maker:topbar') return null;
    const TS = topbarShare();
    return TS ? TS.read(msg.data) : null;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      makerPackage, makerGrant, previewCsp, withCsp, widgetFromMessage, packageIdOfSrc, themeFromMessage, bgFromMessage,
      ambientFromMessage, pageFromMessage, layoutWithPage, PAGE_ID, deckFromMessage, deckStore, DECK_ID, DECK_ITEM,
      topbarFromMessage,
    };
    return;
  }

  const M = window.__XENON_DEMO_MAKER__;
  if (!M) return;

  const docs = new Map();     // package id → blob: URL of its current document
  const frames = new Map();   // package id → frames showing it

  // A tile frame for a Maker package loads that package's document instead of
  // a server path. Every other frame is left exactly as the app set it.
  const src = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
  Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
    configurable: true,
    enumerable: src.enumerable,
    get() { return src.get.call(this); },
    set(value) {
      const id = packageIdOfSrc(value);
      const doc = id ? docs.get(id) : null;
      if (doc) {
        if (!frames.has(id)) frames.set(id, new Set());
        frames.get(id).add(this);
      }
      src.set.call(this, doc || value);
    },
  });

  // The page's tiles that name a package, bound again whenever one arrives.
  let pageBind = [];

  async function show({ pkg, html, place }) {
    const old = docs.get(pkg.id);
    docs.set(pkg.id, URL.createObjectURL(new Blob([html], { type: 'text/html' })));
    const at = M.packages.findIndex((p) => p.id === pkg.id);
    if (at < 0) M.packages.push(pkg); else M.packages[at] = pkg;
    const CW = window.CustomWidget;
    if (CW) {
      await CW.refreshPackages();
      if (!place && typeof updateSdkWidgets === 'function') {
        const cur = (hubSettings && hubSettings.sdkWidgets) || {};
        updateSdkWidgets({ grants: Object.assign({}, cur.grants, { [pkg.id]: makerGrant(pkg) }) });
      }
      if (!place) {
        if (pageBind.length) CW.bindPackages(pageBind);
      } else if (at < 0) {
        CW.addToPage(pkg.id);
      } else {
        // Same element, new document: the widget says hello again and the host
        // answers with a fresh init, as after the tile's own Reload.
        for (const f of frames.get(pkg.id) || []) {
          if (f.isConnected) f.src = '/sdk/widget/' + encodeURIComponent(pkg.id) + '/index.html';
          else frames.get(pkg.id).delete(f);
        }
      }
    }
    if (old) setTimeout(() => URL.revokeObjectURL(old), 10000);
  }

  // The theme being edited, applied the way an imported theme code is, minus
  // saving it: this visit's storage is in memory anyway.
  const FONT_STYLE_ID = 'maker-font-face';
  let fontUrl = '';
  let fontData = '';
  function applyFont(font) {
    // Every edit resends the theme; the font face is rebuilt only when it changes.
    if ((font ? font.data : '') === fontData) return;
    fontData = font ? font.data : '';
    const root = document.documentElement;
    if (fontUrl) URL.revokeObjectURL(fontUrl);
    fontUrl = '';
    document.getElementById(FONT_STYLE_ID)?.remove();
    if (!font) {
      root.style.removeProperty('--user-font-family');
      return;
    }
    const bin = atob(font.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    fontUrl = URL.createObjectURL(new Blob([bytes], { type: 'font/' + font.ext }));
    const style = document.createElement('style');
    style.id = FONT_STYLE_ID;
    style.textContent = `@font-face{font-family:'XenonUserFont';src:url("${fontUrl}");font-display:block;}`;
    document.head.appendChild(style);
    root.style.setProperty('--user-font-family', "'XenonUserFont'");
  }
  // The app may load its settings after the first theme or background arrives
  // (the boot hydrate) and would paint over it, so each rides on every apply.
  let pinned = null;
  let demoBar = null;
  let pinnedBg = null;
  let pinnedLayout = null;
  let pinnedTopbar = null;
  const applySettings = window.applyHubSettings;
  if (typeof applySettings === 'function') {
    window.applyHubSettings = function () {
      if (pinned || pinnedBg || pinnedLayout || pinnedTopbar) {
        hubSettings = normalizeSettings(Object.assign({}, hubSettings, pinned, pinnedBg && { bgCustom: pinnedBg },
          pinnedLayout && { dashboardLayout: pinnedLayout },
          pinnedTopbar && window.TopbarShare.patch(hubSettings, pinnedTopbar)));
      }
      return applySettings.apply(this, arguments);
    };
  }
  function showTheme({ data, font }) {
    const PS = window.PresetShare;
    if (!PS || typeof PS.themeImportPatch !== 'function' || typeof normalizeSettings !== 'function') return;
    pinned = PS.themeImportPatch(data);
    // The bar's style lands on the demo's own bar, as the import does; a theme
    // without one puts back the bar the demo started with.
    const TL = window.TopbarLook;
    if (TL) {
      if (!demoBar) demoBar = TL.normalize(hubSettings.topbarLook);
      pinned.topbarLook = TL.withThemePart(demoBar, data && data.topbarLook);
    }
    window.applyHubSettings();
    applyFont(font);
  }

  // The bar being edited, laid on the demo the way an imported code is.
  function showTopbar(share) {
    if (typeof applyTopbarSetup !== 'function' || !window.TopbarShare) return;
    pinnedTopbar = share;
    applyTopbarSetup(share);
    window.parent.postMessage({ type: 'xenon-demo:topbar' }, location.origin);
  }

  function showBg(bg) {
    if (typeof normalizeSettings !== 'function') return;
    pinnedBg = bg;
    window.applyHubSettings();
  }

  // The scene being edited, full screen the way Ambient shows an installed one.
  // Every edit rebuilds it; only the first one slides in (demo.css).
  function showAmbient(scene) {
    const AS = window.AmbientScene;
    const AC = window.AmbientCanvas;
    if (!AS || !AC) return;
    const norm = AS.normalizeScene(scene);
    if (!norm) return;
    const again = AC.isOpen();
    if (again) AC.unmount();
    document.documentElement.classList.toggle('maker-ambient-again', again);
    AC.mount(norm);
  }

  // The page being edited, alone on the dashboard. The pager is rebuilt only
  // the first time; later edits re-lay the same page's grid.
  function showPage(page) {
    const DP = window.DashboardPresets;
    if (!DP || typeof getDashboardLayout !== 'function' || typeof saveDashboardLayout !== 'function') return;
    const layout = getDashboardLayout();
    const bind = [];
    if (!layoutWithPage(layout, page, DP, bind)) return;
    pageBind = bind;
    const first = !pinnedLayout;
    pinnedLayout = layout;
    saveDashboardLayout(layout, { status: false });
    if (first && window.DashboardPages) window.DashboardPages.rebuild();
    else if (typeof applyDashboardLayout === 'function') applyDashboardLayout();
    if (bind.length && window.CustomWidget) window.CustomWidget.bindPackages(bind);
    if (window.DashboardPager && typeof window.DashboardPager.goToPage === 'function') window.DashboardPager.goToPage(PAGE_ID);
    window.parent.postMessage({ type: 'xenon-demo:page' }, location.origin);
  }

  // The Deck profile being edited, alone in a Deck tile on its own page. The
  // page is laid once; later edits rewrite the Deck store and repaint.
  let deckPage = false;
  function showDeck({ profile, view }) {
    const PS = window.PresetShare, DM = window.DeckModel, DA = window.DeckActions;
    if (!PS || typeof PS.sanitizeDeckProfile !== 'function' || !DM || !DA || !window.Deck) return;
    const clean = PS.sanitizeDeckProfile(profile, { model: DM, actions: DA });
    if (!clean) return;
    localStorage.setItem('deck.config.v1', JSON.stringify(deckStore(clean, DM)));
    if (!deckPage) {
      showPage({ name: clean.name, items: [DECK_ITEM] });
      deckPage = true;
    }
    window.Deck.showView(DECK_ID, view.path, view.page, view.lit);
    window.parent.postMessage({ type: 'xenon-demo:deck' }, location.origin);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || e.origin !== location.origin) return;
    const deck = deckFromMessage(e.data);
    if (deck) {
      try { showDeck(deck); } catch (err) { console.warn('[maker preview]', err); }
    }
    const page = pageFromMessage(e.data);
    if (page) {
      try { showPage(page); } catch (err) { console.warn('[maker preview]', err); }
    }
    const w = widgetFromMessage(e.data, location.origin);
    if (w) show(w).catch((err) => console.warn('[maker preview]', err));
    const theme = themeFromMessage(e.data);
    if (theme) {
      try { showTheme(theme); } catch (err) { console.warn('[maker preview]', err); }
    }
    const scene = ambientFromMessage(e.data);
    if (scene) {
      try { showAmbient(scene); } catch (err) { console.warn('[maker preview]', err); }
    }
    const bg = bgFromMessage(e.data);
    if (bg) {
      try { showBg(bg); } catch (err) { console.warn('[maker preview]', err); }
    }
    const bar = topbarFromMessage(e.data);
    if (bar) {
      try { showTopbar(bar); } catch (err) { console.warn('[maker preview]', err); }
    }
  });
  window.parent.postMessage({ type: 'xenon-demo:ready' }, location.origin);
})();
