'use strict';

// ── Shareable presets ───────────────────────────────────────────────────────
// Export a THEME (your colours/appearance), a PAGE LAYOUT (a page's widgets +
// geometry) or a DECK PROFILE (a full key layout) as a portable, versioned,
// self-contained code — a copyable link or a downloadable .json file — and
// import one back. The website gallery (docs/) hands out the same codes.
//
// Security: theme and page presets carry ONLY value fields — colours, and base
// widget ids + geometry — re-validated on import through the app's own
// normalizers (`normalizeSettings`, `DashboardPresets.normalizePresets`), so
// importing a stranger's theme/page can't execute anything.
//
// Deck profiles are different: their keys CARRY ACTIONS. The boundary is
// sanitizeDeckProfile(), applied on BOTH export and import: the profile is
// rebuilt through DeckModel.normalizeDeckConfig and every trigger is rebuilt
// from scratch through DeckActions.triggerSteps/compactTrigger — unknown action
// types are dropped, select params are coerced onto the catalog's options, and
// nothing outside a param's spec survives (normalizeKey alone copies raw
// trigger objects, so this explicit rebuild is what keeps arbitrary JSON out of
// the stored config). Imported actions still only ever run when the user taps
// the key, and each run re-validates through server/actions/registry.js — the
// same single gate as every locally-created key. The import dialog additionally
// shows WHAT actions the profile contains before anything is added.
(function () {
  'use strict';

  const PRESET_FORMAT = 1;
  const PRESET_KINDS = ['theme', 'page', 'deck'];
  const THEME_KEYS = ['appearance', 'accent', 'background', 'text', 'panelAlpha',
    'bgDim', 'bgBlur', 'dynamicAlbumTheme', 'bgAurora', 'bgGrid'];
  // Hard decode guard (pre-JSON.parse). Theme/page presets are tiny, but a deck
  // profile can embed photo key-faces as data: URLs (up to ~1.5MB per key), so
  // the cap is sized for those while still rejecting absurd payloads.
  const MAX_CODE_BYTES = 4 * 1024 * 1024;
  // Above this a code is impractical as a LINK (chat apps truncate); the share
  // dialog switches to file-first and offers a no-images variant.
  const LINK_SOFT_MAX = 100 * 1024;
  // Folder nesting cap for imported deck profiles: real decks are 1–2 levels;
  // 6 is generous. Also keeps a crafted deeply-nested payload from recursing
  // the normalizer into a stack overflow — folders past the cap are emptied.
  const DECK_MAX_FOLDER_DEPTH = 6;
  const DECK_TRIGGERS = ['tap', 'double', 'hold'];

  // ── UTF-8-safe base64url (works in the browser and under node for tests) ──
  function b64urlEncode(str) {
    let b64;
    if (typeof Buffer !== 'undefined') {
      b64 = Buffer.from(str, 'utf8').toString('base64');
    } else {
      const bytes = new TextEncoder().encode(str);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      b64 = btoa(bin);
    }
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64urlDecode(b64url) {
    const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  // ── Pure format helpers (exported for unit tests) ─────────────────
  // Encode a preset into a compact, shareable code (base64url of the JSON envelope).
  function encodePreset(kind, name, data, meta) {
    const env = {
      xenonPreset: PRESET_FORMAT,
      exportedAt: (meta && meta.exportedAt) || '',
      appVersion: (meta && meta.appVersion) || '',
      // Geometry units of the exported data. Codes from pre-24-column installs
      // lack this field and are scaled ×2 on import (see applyPage).
      gridCols: 24,
      kind,
      name: String(name == null ? '' : name).slice(0, 60),
      data,
    };
    return b64urlEncode(JSON.stringify(env));
  }

  // Decode a shared string — a raw code, a full link (…#preset=CODE), or pasted
  // JSON — into a STRUCTURALLY valid envelope, or null. Payload values are NOT
  // trusted here; the caller re-normalizes them through the app's normalizers
  // before applying anything.
  function decodePreset(input) {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;
    const m = s.match(/[#?&]preset=([A-Za-z0-9_\-]+)/);
    if (m) s = m[1];
    let json;
    if (s.charAt(0) === '{') {
      json = s;
    } else {
      try { json = b64urlDecode(s); } catch { return null; }
    }
    if (!json || json.length > MAX_CODE_BYTES) return null;
    let env;
    try { env = JSON.parse(json); } catch { return null; }
    if (!env || typeof env !== 'object') return null;
    if (env.xenonPreset !== PRESET_FORMAT) return null;
    if (!PRESET_KINDS.includes(env.kind)) return null;
    if (!env.data || typeof env.data !== 'object') return null;
    return {
      kind: env.kind,
      name: typeof env.name === 'string' ? env.name.slice(0, 60) : '',
      appVersion: typeof env.appVersion === 'string' ? env.appVersion : '',
      gridCols: Number(env.gridCols) || 0,
      data: env.data,
    };
  }

  // ── Deck-profile helpers (pure; deps = { model, actions } so node tests can
  //    inject require'd DeckModel/DeckActions and the browser passes the
  //    window globals) ──────────────────────────────────────────────────────

  // Truncate folder nesting beyond `depth` levels (crafted payloads only; a
  // too-deep folder becomes a single empty page instead of recursing forever).
  function capFolderDepth(folder, depth) {
    if (!folder || typeof folder !== 'object' || !Array.isArray(folder.pages)) return;
    for (const page of folder.pages) {
      if (!page || !Array.isArray(page.keys)) continue;
      for (const key of page.keys) {
        if (!key || typeof key !== 'object' || key.kind !== 'folder') continue;
        if (depth <= 1) key.folder = { pages: [{ keys: [] }] };
        else capFolderDepth(key.folder, depth - 1);
      }
    }
  }

  // Walk every key of a profile tree (root + nested folders), calling fn(key).
  function eachProfileKey(profile, fn) {
    const walk = (folder) => {
      if (!folder || !Array.isArray(folder.pages)) return;
      for (const page of folder.pages) {
        if (!page || !Array.isArray(page.keys)) continue;
        for (const key of page.keys) {
          if (!key) continue;
          fn(key);
          if (key.kind === 'folder') walk(key.folder);
        }
      }
    };
    walk(profile && profile.root);
  }

  function countProfileKeys(profile) {
    let n = 0;
    eachProfileKey(profile, () => { n++; });
    return n;
  }

  // Rebuild an untrusted deck profile into a clean { name, root } (no id — the
  // importer assigns a fresh one), or null. Everything is rebuilt, never
  // spread: the profile through DeckModel's normalizer (full 8×8 grid so no key
  // is truncated), then each key's triggers from scratch through the action
  // validator (unknown types dropped, params coerced onto the catalog), state
  // bindings restricted to the known read-only sources, and blob: images
  // cleared (they are session-local object URLs — dead on any other machine).
  function sanitizeDeckProfile(raw, deps) {
    const M = deps && deps.model, A = deps && deps.actions;
    if (!raw || typeof raw !== 'object' || !M || !A) return null;
    try {
      const src = { name: raw.name, root: raw.root && typeof raw.root === 'object' ? raw.root : null };
      if (!src.root) return null;
      capFolderDepth(src.root, DECK_MAX_FOLDER_DEPTH);
      const probe = M.normalizeDeckConfig({ cols: 8, rows: 8, profiles: [src], activeProfile: 'p' });
      const prof = probe.profiles[0];
      eachProfileKey(prof, (key) => {
        if (key.kind === 'action') {
          const rawTriggers = (key.triggers && typeof key.triggers === 'object') ? key.triggers : {};
          const clean = {};
          for (const name of DECK_TRIGGERS) {
            const t = A.compactTrigger(A.triggerSteps(rawTriggers[name]));
            if (t) clean[name] = t;
          }
          key.triggers = clean;
          if (key.state && !(M.DECK_STATE_SOURCES || []).includes(key.state.source)) delete key.state;
        }
        if (key.icon && typeof key.icon.value === 'string' && /^blob:/i.test(key.icon.value)) key.icon.value = '';
        if (key.bgImage && typeof key.bgImage.value === 'string' && /^blob:/i.test(key.bgImage.value)) delete key.bgImage;
      });
      return { name: prof.name, root: prof.root };
    } catch { return null; }
  }

  // Which action types a (sanitized) profile contains, as [{ type, count }]
  // sorted by count — shown to the user BEFORE an imported profile is added.
  function profileActionSummary(profile, deps) {
    const A = deps && deps.actions;
    if (!A) return [];
    const counts = new Map();
    eachProfileKey(profile, (key) => {
      if (key.kind !== 'action' || !key.triggers) return;
      for (const name of DECK_TRIGGERS) {
        for (const step of A.triggerSteps(key.triggers[name])) {
          counts.set(step.action.type, (counts.get(step.action.type) || 0) + 1);
        }
      }
    });
    return Array.from(counts, ([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count);
  }

  // A copy of the profile with every embedded picture removed (photo key-faces
  // and image icons fall back to the default glyph) — the "share without
  // images" variant when the full code is too big to travel as a link.
  function stripProfileImages(profile) {
    const copy = JSON.parse(JSON.stringify(profile));
    eachProfileKey(copy, (key) => {
      delete key.bgImage;
      if (key.icon && key.icon.type === 'image') key.icon = { type: 'emoji', value: '' };
    });
    return copy;
  }

  // ── Browser controller (dialogs + apply) ──────────────────────────
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const tr = (k, fb) => (typeof t === 'function' && t(k) && t(k) !== k) ? t(k) : fb;
    const stamp = () => { try { return new Date().toISOString(); } catch { return ''; } };
    // hubSettings is a shared-script-scope global from settings.js (a top-level
    // `let`, NOT window.hubSettings) — reach it by bare name, guarded.
    const HS = () => { try { return (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings : {}; } catch { return {}; } };
    const appVersion = () => { try { return String(window.APP_VERSION || HS().appVersion || ''); } catch { return ''; } };
    const toast = (title, message, type) => {
      if (window.XenonToast) window.XenonToast.show({ type: type || 'info', title, message: message || '', duration: 3600 });
    };

    function linkFor(code) { try { return location.origin + '/#preset=' + code; } catch { return '#preset=' + code; } }

    function download(filename, text) {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function copy(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    }

    // ---- capture the current theme / page ----
    function currentTheme() {
      const s = HS();
      const out = {};
      for (const k of THEME_KEYS) if (k in s) out[k] = s[k];
      return out;
    }
    function layoutNow() {
      return (typeof getDashboardLayout === 'function') ? getDashboardLayout() : HS().dashboardLayout;
    }
    function pageName(page, index) {
      const nm = (page.name || (page.nameKey ? tr(page.nameKey, '') : '') || '').trim();
      return nm || (tr('preset_kind_page', 'Page') + ' ' + (index + 1));
    }
    // Every page in the current layout, with a display name and its widget count —
    // so the export picker can label each page and disable the empty ones.
    function listPages() {
      const layout = layoutNow();
      const DP = window.DashboardPresets;
      if (!layout || !Array.isArray(layout.pages) || !DP || typeof DP.capture !== 'function') return [];
      return layout.pages.map((p, i) => {
        let count = 0;
        try { const d = DP.capture(layout, 'page', null, p.id); count = (d && Array.isArray(d.items)) ? d.items.length : 0; }
        catch { count = 0; }
        return { id: p.id, name: pageName(p, i), count };
      });
    }
    function capturePage(pageId) {
      const layout = layoutNow();
      const DP = window.DashboardPresets;
      if (!layout || !DP || typeof DP.capture !== 'function') return null;
      const idx = (layout.pages || []).findIndex(p => p.id === pageId);
      if (idx < 0) return null;
      const data = DP.capture(layout, 'page', null, pageId);
      return { data, name: pageName(layout.pages[idx], idx) };
    }

    // ---- deck-profile export ----
    const deckDeps = () => ({ model: window.DeckModel, actions: window.DeckActions });

    // Share one profile object (from the deck's profile menu, or the picker
    // below). Sanitized BEFORE encoding, so an exported code never carries
    // anything the validator wouldn't accept back.
    function shareDeckProfile(profileObj) {
      const prof = sanitizeDeckProfile(profileObj, deckDeps());
      if (!prof || !countProfileKeys(prof)) {
        toast(tr('preset_share_empty_deck', 'This profile is empty — nothing to share.'), '', 'error');
        return;
      }
      const name = prof.name || tr('preset_kind_deck', 'Deck profile');
      openShareDialog('deck', name, encodePreset('deck', name, prof, { exportedAt: stamp(), appVersion: appVersion() }), prof);
    }

    // Settings → Share & Import entry: pick which profile (across every deck).
    function exportDeck() {
      const D = window.Deck;
      const all = (D && D.listAllDeckProfiles) ? D.listAllDeckProfiles() : [];
      if (!all.length) {
        toast(tr('preset_share_empty_deck', 'This profile is empty — nothing to share.'), '', 'error');
        return;
      }
      if (all.length === 1) { doExportDeck(all[0]); return; }
      openDeckProfilePicker(all);
    }
    function doExportDeck(entry) {
      const D = window.Deck;
      const profile = (D && D.getProfileTemplate) ? D.getProfileTemplate(entry.instanceId, entry.profileId) : null;
      if (profile) shareDeckProfile(profile);
    }
    function openDeckProfilePicker(profiles) {
      const { body, close } = buildModal(tr('preset_deck_pick', 'Which profile do you want to share?'));
      const list = document.createElement('div');
      list.className = 'preset-page-list';
      profiles.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset-page-item';
        const nm = document.createElement('span');
        nm.className = 'preset-page-name';
        nm.textContent = p.name;
        const meta = document.createElement('span');
        meta.className = 'preset-page-meta';
        meta.textContent = p.keys + ' ' + tr('preset_deck_keys', 'keys');
        btn.appendChild(nm); btn.appendChild(meta);
        btn.addEventListener('click', () => { close(); doExportDeck(p); });
        list.appendChild(btn);
      });
      body.appendChild(list);
    }

    // ---- export entry points ----
    function exportTheme() {
      const name = tr('preset_share_theme_name', 'My theme');
      openShareDialog('theme', name, encodePreset('theme', name, currentTheme(), { exportedAt: stamp(), appVersion: appVersion() }));
    }
    // Export a page. With more than one page, ask WHICH page first (defaulting the
    // highlight to the one you're viewing) instead of silently taking the current one.
    function exportPage() {
      const pages = listPages();
      if (!pages.some(p => p.count > 0)) {
        toast(tr('preset_share_empty_page', 'This page is empty — nothing to share.'), '', 'error');
        return;
      }
      if (pages.length === 1) { doExportPage(pages[0].id); return; }
      const pager = window.DashboardPager;
      const curId = (pager && pager.getCurrentPage && pager.getCurrentPage()) || '';
      openPagePicker(pages, curId);
    }
    function doExportPage(pageId) {
      const cp = capturePage(pageId);
      if (!cp || !cp.data || !Array.isArray(cp.data.items) || !cp.data.items.length) {
        toast(tr('preset_share_empty_page', 'This page is empty — nothing to share.'), '', 'error');
        return;
      }
      const name = cp.name || tr('preset_kind_page', 'Page');
      openShareDialog('page', name, encodePreset('page', name, cp.data, { exportedAt: stamp(), appVersion: appVersion() }));
    }

    function openPagePicker(pages, currentId) {
      const { body, close } = buildModal(tr('preset_pick_title', 'Which page do you want to share?'));
      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_pick_desc', 'Pick the page to export as a preset.');
      body.appendChild(desc);

      const list = document.createElement('div');
      list.className = 'preset-page-list';
      pages.forEach((p) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'preset-page-item';
        btn.disabled = !p.count;

        const nm = document.createElement('span');
        nm.className = 'preset-page-name';
        nm.textContent = p.name;
        if (p.id === currentId) {
          const cur = document.createElement('span');
          cur.className = 'preset-page-cur';
          cur.textContent = tr('preset_pick_current', 'current');
          nm.appendChild(cur);
        }

        const meta = document.createElement('span');
        meta.className = 'preset-page-meta';
        meta.textContent = p.count
          ? p.count + ' ' + tr('preset_pick_widgets', 'widgets')
          : tr('preset_pick_empty', 'empty');

        btn.appendChild(nm);
        btn.appendChild(meta);
        if (p.count) btn.addEventListener('click', () => { close(); doExportPage(p.id); });
        list.appendChild(btn);
      });
      body.appendChild(list);
    }

    // ---- apply an imported preset (re-validated per kind) ----
    function applyPreset(env) {
      if (!env) return false;
      if (env.kind === 'theme') return applyTheme(env.data);
      if (env.kind === 'page') return applyPage(env.data, env.name, env.gridCols);
      return false;
    }
    function applyTheme(data) {
      if (!data || typeof data !== 'object') return false;
      const patch = {};
      for (const k of THEME_KEYS) if (k in data) patch[k] = data[k];
      if (!Object.keys(patch).length) return false;
      try {
        // normalizeSettings rebuilds known keys only, coercing each field (hex,
        // clamped numbers, aurora/grid) — untrusted values can't slip through.
        hubSettings = normalizeSettings(Object.assign({}, HS(), patch));
        if (typeof saveHubSettings === 'function') saveHubSettings();
        if (typeof applyHubSettings === 'function') applyHubSettings();
        if (typeof syncSettingsControls === 'function') syncSettingsControls();
        return true;
      } catch { return false; }
    }
    function applyPage(data, name, gridCols) {
      const DP = window.DashboardPresets;
      if (!DP || !data || !Array.isArray(data.items) || !data.items.length) return false;
      const raw = {
        id: 'ps_imp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: String(name || '').slice(0, 40) || tr('preset_kind_page', 'Page'),
        kind: 'page', createdAt: Date.now(), data,
      };
      // Codes exported on the 24-column grid say so; legacy 12-column codes are
      // left unflagged and normalizePresets scales them ×2.
      if (Number(gridCols) === 24) raw.gridCols = 24;
      let norm;
      try { norm = (typeof DP.normalizePresets === 'function') ? DP.normalizePresets([raw])[0] : raw; }
      catch { return false; }
      if (!norm || !norm.data || !Array.isArray(norm.data.items) || !norm.data.items.length) return false;
      try {
        if (typeof getDashboardPresets !== 'function' || typeof setDashboardPresets !== 'function') return false;
        const list = getDashboardPresets().slice();
        list.push(norm);
        setDashboardPresets(list);
        // Adds it to the saved-presets dock AND drops it onto a fresh page now.
        if (typeof insertDashboardPreset === 'function') insertDashboardPreset(norm.id);
        if (typeof refreshDashboardLayoutEditor === 'function') refreshDashboardLayoutEditor();
        return true;
      } catch { return false; }
    }

    // ---- minimal modal ----
    function buildModal(titleText) {
      const overlay = document.createElement('div');
      overlay.className = 'preset-modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'preset-modal';
      const head = document.createElement('div');
      head.className = 'preset-modal-head';
      const h = document.createElement('h3');
      h.className = 'preset-modal-title';
      h.textContent = titleText;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'preset-modal-close';
      x.setAttribute('aria-label', tr('close', 'Close'));
      x.textContent = '✕';
      const body = document.createElement('div');
      body.className = 'preset-modal-body';
      head.appendChild(h); head.appendChild(x);
      modal.appendChild(head); modal.appendChild(body);
      overlay.appendChild(modal);
      const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
      const onKey = (e) => { if (e.key === 'Escape') close(); };
      x.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
      return { body, close };
    }

    function actionRow() { const r = document.createElement('div'); r.className = 'preset-modal-actions'; return r; }
    function codeField(value, readOnly) {
      const f = document.createElement('textarea');
      f.className = 'preset-code-field';
      f.rows = 3;
      if (readOnly) { f.readOnly = true; f.value = value; f.addEventListener('focus', () => f.select()); }
      return f;
    }

    function openShareDialog(kind, name, code, deckProfile) {
      const { body, close } = buildModal(tr('preset_share_title', 'Share preset'));

      // Make it explicit WHAT is being shared — for a page this is the exact page
      // (the one currently open in the pager), so the user is never guessing which.
      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = tr('preset_kind_' + kind, kind);
      what.appendChild(chip);
      if (name) {
        const nm = document.createElement('span');
        nm.className = 'preset-modal-whatname';
        nm.textContent = name;
        what.appendChild(nm);
      }
      body.appendChild(what);

      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_share_desc', 'Copy the link or download the file. The recipient imports it from Settings → Appearance → Import.');
      body.appendChild(desc);

      // A code past the link-practical size (deck profiles with photo faces)
      // travels as a FILE: the link field is replaced by a plain note, and a
      // "share without images" alternative re-encodes with pictures stripped.
      const oversize = code.length > LINK_SOFT_MAX;
      const link = linkFor(code);
      let field = null;
      if (oversize) {
        const note = document.createElement('p');
        note.className = 'preset-modal-desc preset-modal-note';
        note.textContent = tr('preset_share_toobig_link', 'This preset is large (it embeds images), so it travels as a file instead of a link.');
        body.appendChild(note);
      } else {
        field = codeField(link, true);
        body.appendChild(field);
      }

      const row = actionRow();
      if (!oversize) {
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button'; copyBtn.className = 'settings-btn';
        copyBtn.textContent = tr('preset_copy_link', 'Copy link');
        copyBtn.addEventListener('click', async () => {
          const ok = await copy(link);
          copyBtn.textContent = ok ? tr('preset_copied', 'Copied!') : tr('preset_copy_fail', 'Select & copy');
          if (!ok) field.select();
          setTimeout(() => { copyBtn.textContent = tr('preset_copy_link', 'Copy link'); }, 1600);
        });
        row.appendChild(copyBtn);
      }
      const dlBtn = document.createElement('button');
      dlBtn.type = 'button'; dlBtn.className = 'settings-btn' + (oversize ? '' : ' subtle');
      dlBtn.textContent = tr('preset_download', 'Download file');
      dlBtn.addEventListener('click', () => {
        let pretty = link;
        try { pretty = JSON.stringify(JSON.parse(b64urlDecode(code)), null, 2); } catch { /* keep link */ }
        const safe = String(name || kind).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 40) || kind;
        download('xenon-' + kind + '-' + safe + '.json', pretty);
      });
      row.appendChild(dlBtn);
      if (oversize && kind === 'deck' && deckProfile) {
        const noImg = document.createElement('button');
        noImg.type = 'button'; noImg.className = 'settings-btn subtle';
        noImg.textContent = tr('preset_share_noimg', 'Share without images');
        noImg.addEventListener('click', () => {
          close();
          const slim = stripProfileImages(deckProfile);
          openShareDialog('deck', name, encodePreset('deck', name, slim, { exportedAt: stamp(), appVersion: appVersion() }));
        });
        row.appendChild(noImg);
      }
      body.appendChild(row);
    }

    function openImport(prefill) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_import_desc', 'Paste a preset link or code, or choose a .json file.');
      body.appendChild(desc);

      const field = codeField('', false);
      field.placeholder = tr('preset_import_placeholder', 'Paste the link or code here…');
      if (prefill) field.value = prefill;
      body.appendChild(field);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { field.value = String(reader.result || ''); };
        reader.readAsText(f);
      });
      body.appendChild(fileInput);

      const row = actionRow();
      const fileBtn = document.createElement('button');
      fileBtn.type = 'button'; fileBtn.className = 'settings-btn subtle';
      fileBtn.textContent = tr('preset_import_file', 'Choose file…');
      fileBtn.addEventListener('click', () => fileInput.click());
      const importBtn = document.createElement('button');
      importBtn.type = 'button'; importBtn.className = 'settings-btn primary';
      importBtn.textContent = tr('preset_import_apply', 'Import');
      importBtn.addEventListener('click', () => {
        const env = decodePreset(field.value);
        if (!env) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
        // Deck profiles carry actions → their own review step (what's inside +
        // which deck it goes to), never applied straight from the paste box.
        if (env.kind === 'deck') {
          const prof = sanitizeDeckProfile(env.data, deckDeps());
          if (!prof || !countProfileKeys(prof)) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
          close();
          openDeckImport(env.name || prof.name, prof);
          return;
        }
        if (applyPreset(env)) {
          close();
          const kindName = tr('preset_kind_' + env.kind, env.kind);
          toast(tr('preset_import_ok', 'Preset imported'), (env.name ? env.name + ' · ' : '') + kindName, 'success');
        } else {
          toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error');
        }
      });
      row.appendChild(fileBtn); row.appendChild(importBtn);
      body.appendChild(row);
    }

    // Review step for an imported deck profile: shows the name, size and — the
    // part that matters — every ACTION TYPE the keys contain, with a plain-words
    // caution, before the user picks which deck it lands on. `prof` is already
    // sanitized; the summary therefore reflects exactly what would be stored.
    function openDeckImport(name, prof) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));

      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = tr('preset_kind_deck', 'Deck profile');
      what.appendChild(chip);
      const nm = document.createElement('span');
      nm.className = 'preset-modal-whatname';
      nm.textContent = (name || '') + ' · ' + countProfileKeys(prof) + ' ' + tr('preset_deck_keys', 'keys');
      what.appendChild(nm);
      body.appendChild(what);

      const summary = profileActionSummary(prof, deckDeps());
      const head = document.createElement('p');
      head.className = 'preset-modal-desc';
      head.textContent = summary.length
        ? tr('preset_deck_contains', 'This profile contains actions:')
        : tr('preset_deck_noactions', 'No actions — looks only.');
      body.appendChild(head);
      if (summary.length) {
        const acts = document.createElement('div');
        acts.className = 'preset-deck-acts';
        const DA = window.DeckActions;
        summary.forEach((s) => {
          const spec = DA && DA.actionSpec ? DA.actionSpec(s.type) : null;
          const chipEl = document.createElement('span');
          chipEl.className = 'preset-deck-act';
          chipEl.textContent = tr(spec && spec.labelKey, s.type) + (s.count > 1 ? ' ×' + s.count : '');
          acts.appendChild(chipEl);
        });
        body.appendChild(acts);
        const caution = document.createElement('p');
        caution.className = 'preset-modal-desc preset-deck-caution';
        caution.textContent = tr('preset_deck_caution', 'Only import profiles from people you trust. Actions run only when you tap their key, and each one is re-checked by Xenon before it runs.');
        body.appendChild(caution);
      }

      const D = window.Deck;
      const targets = (D && D.listDeckTargets) ? D.listDeckTargets() : [];
      const finish = (res) => {
        close();
        if (!res || !res.ok) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
        if (res.savedAsPreset) {
          toast(tr('preset_import_ok', 'Preset imported'),
            tr('preset_deck_saved_preset', 'No Deck on the dashboard — saved to the Deck presets. Add a Deck widget and insert it from its profile menu.'), 'success');
        } else {
          toast(tr('preset_import_ok', 'Preset imported'), (name ? name + ' · ' : '') + tr('preset_kind_deck', 'Deck profile'), 'success');
        }
      };
      if (targets.length > 1) {
        const pickHead = document.createElement('p');
        pickHead.className = 'preset-modal-desc';
        pickHead.textContent = tr('preset_deck_target', 'Add to which Deck?');
        body.appendChild(pickHead);
        const list = document.createElement('div');
        list.className = 'preset-page-list';
        targets.forEach((tgt) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'preset-page-item';
          const tn = document.createElement('span');
          tn.className = 'preset-page-name';
          tn.textContent = tgt.label;
          const meta = document.createElement('span');
          meta.className = 'preset-page-meta';
          meta.textContent = tgt.profiles + ' ' + tr('deck_profiles', 'Profiles').toLowerCase();
          btn.appendChild(tn); btn.appendChild(meta);
          btn.addEventListener('click', () => finish(D.importSharedProfile(tgt.instanceId, prof)));
          list.appendChild(btn);
        });
        body.appendChild(list);
      } else {
        const row = actionRow();
        const go = document.createElement('button');
        go.type = 'button'; go.className = 'settings-btn primary';
        go.textContent = tr('preset_import_apply', 'Import');
        go.addEventListener('click', () => {
          if (!D || !D.importSharedProfile) { finish(null); return; }
          finish(D.importSharedProfile(targets.length ? targets[0].instanceId : '', prof));
        });
        row.appendChild(go);
        body.appendChild(row);
      }
    }

    // A …/#preset=CODE link opens the dashboard straight into the import dialog,
    // prefilled (never auto-applied — the user confirms). Clear the hash so a
    // refresh doesn't re-prompt.
    function checkHash() {
      try {
        const h = location.hash || '';
        if (!/[#&?]preset=/.test(h)) return;
        const valid = decodePreset(h);
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
        if (valid) openImport(h.replace(/^#/, ''));
      } catch { /* ignore */ }
    }

    window.PresetShare = { exportTheme, exportPage, exportCurrentPage: exportPage, exportDeck, shareDeckProfile, openImport, encodePreset, decodePreset };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkHash, { once: true });
    else checkHash();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { encodePreset, decodePreset, sanitizeDeckProfile, profileActionSummary, stripProfileImages, countProfileKeys };
  }
})();
