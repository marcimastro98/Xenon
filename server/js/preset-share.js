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
  // 'bundle' packs a theme + one or more page layouts + installable SDK widget
  // packages into a single code/file (a "Pacchetto Xenon"). Its data is
  // { theme?, pages?:[{name,data}], widgets?:[{id,name,…,payload}] }; each part
  // is re-validated through the SAME per-kind boundary on import (theme →
  // normalizeSettings, page → normalizePresets, widget → server /sdk/install
  // validateWidgetPayload + the normal grant flow — never auto-granted).
  // 'bg' shares JUST a code-defined animated background ({ name, code }) so people
  // can swap backgrounds without exporting a whole theme. On import the code goes
  // through normalizeBgCustom (capped) and still only ever runs inside the isolated
  // sandbox iframe (see js/custom-bg.js), exactly like a hand-typed one.
  // 'widget' shares ONE installed community widget as its validated file payload
  // (same shape as a bundle's widget entry). On import it re-installs through the
  // SAME server boundary (/sdk/install validateWidgetPayload) and is NEVER
  // auto-granted — the user approves its permissions after, exactly like a manual
  // install.
  // 'ambient' shares ONE installed Ambient scene (an SDK package whose manifest
  // declares surface:'ambient') as the same validated file payload a 'widget'
  // code carries. Import reuses the exact /sdk/install boundary and is never
  // auto-granted; the only extra is an opt-in "set as my ambient scene" step.
  // 'ambient-layout' shares ONE native canvas Ambient scene (js/ambient-scene.js)
  // — the JSON layout the in-app editor produces. Its data is { scene, widgets? }:
  // the scene has its /uploads images inlined to data: URIs (self-contained) and
  // every referenced SDK widget bundled as a validated /sdk/install payload. On
  // import the scene is re-normalized through AmbientScene (imported-marked, fresh
  // id) and its widgets install through the SAME server boundary, never
  // auto-granted — so a shared scene is lossless yet re-validated end to end.
  const PRESET_KINDS = ['theme', 'page', 'deck', 'bundle', 'bg', 'widget', 'ambient', 'ambient-layout'];
  // A theme code carries the whole visual identity of the Aspetto tab — mode,
  // style/skin, colours, album-accent and surface (font travels separately as
  // fontData). Keep this in step with THEME_SETTING_KEYS in settings.js. Older
  // codes simply omit the newer fields and import as before.
  const THEME_KEYS = ['appearance', 'styleMode', 'retroScanlines', 'accent', 'background',
    'text', 'mutedText', 'lineColor', 'dynamicAlbumTheme',
    'panelAlpha', 'panelBorderStrength', 'panelShadowStrength',
    'uiRoundness', 'glassBlur', 'glassSaturate',
    'bgDim', 'bgBlur', 'bgAurora', 'bgGrid', 'bgStatic', 'bgCustom'];
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

  // ── Code-locked presets (envelope encryption) ────────────────────────────
  // A locked preset carries the SAME inner preset code, but AES-GCM-encrypted
  // under a random content key; that key is then wrapped once per recipient
  // "unlock code" (PBKDF2 → AES-GCM). Anyone holding ONE of the codes can
  // unwrap the content key and decrypt the theme; without a valid code the
  // payload is unrecoverable (not merely gated by a bypassable UI check). The
  // codes are the only secret — the bundle itself is public/shareable.
  const LOCK_FORMAT = 1;
  const PBKDF2_ITER = 210000;      // stretch a short human code against offline attack
  const LOCK_MAX_KEYS = 200;       // ceiling on codes per export (and on entries we'll try on import)
  const LOCK_MAX_ITER = 5000000;   // reject a crafted bundle asking for absurd KDF work
  // Unlock-code alphabet: 32 unambiguous symbols (no O/0/I/1), so byte & 31 is a
  // uniform pick. A code is 12 chars ≈ 60 bits — plenty behind PBKDF2 with no
  // online oracle. The pretty dashed form is only for display; keys derive from
  // the canonical (letters+digits, upper-case) form so dashes/spaces/case don't matter.
  const UNLOCK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

  // ── Binary base64 (standard, not url) for the optional embedded custom font ──
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function base64ToBytes(b64) {
    const bin = atob(String(b64 || ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // A theme code stays share-friendly; only embed a font small enough to keep the
  // code usable (the decode cap is MAX_CODE_BYTES). Larger fonts still travel in a
  // full backup — the theme just exports colours-only with a heads-up.
  const THEME_FONT_EMBED_MAX = 2 * 1024 * 1024;
  const FONT_EXT_RE = /\.(woff2|woff|ttf|otf)$/i;

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

  // Turn a shared string — a raw code, a full link (…#preset=CODE) or pasted
  // JSON — into its raw JSON string (still untrusted), or null. Shared by
  // decodePreset() and peekLocked() so both accept the exact same input forms.
  function extractPresetPayload(input) {
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
    return json;
  }

  // Decode a shared string into a STRUCTURALLY valid envelope, or null. Payload
  // values are NOT trusted here; the caller re-normalizes them through the app's
  // normalizers before applying anything.
  function decodePreset(input) {
    const json = extractPresetPayload(input);
    if (json == null) return null;
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
            // runScript and typeText are LOCAL-only actions and must never travel
            // inside a shared preset: runScript launches an arbitrary script, and
            // typeText injects arbitrary keystrokes into whatever app is focused —
            // with '\n' mapped to a real Enter that's runScript-class (a key could
            // type a command into a terminal/Run box and execute it). Drop those
            // steps on export AND import; the importer adds their own. playSound
            // steps are kept but their FILE path is blanked: it's a machine-local
            // absolute path (dead on any other PC) that would otherwise leak the
            // sharer's username/folder layout inside a public code.
            const steps = A.triggerSteps(rawTriggers[name])
              .filter((s) => s.action && s.action.type !== 'runScript' && s.action.type !== 'typeText')
              .map((s) => (s.action.type === 'playSound' ? { ...s, action: { ...s.action, file: '' } } : s));
            const t = A.compactTrigger(steps);
            if (t) clean[name] = t;
          }
          key.triggers = clean;
          if (key.state && !(M.DECK_STATE_SOURCES || []).includes(key.state.source)) delete key.state;
          if (key.live && !(M.DECK_LIVE_SOURCES || []).includes(key.live.source)) delete key.live;
        }
        if (key.icon && typeof key.icon.value === 'string' && /^blob:/i.test(key.icon.value)) key.icon.value = '';
        if (key.bgImage && typeof key.bgImage.value === 'string' && /^blob:/i.test(key.bgImage.value)) delete key.bgImage;
      });
      const out = { name: prof.name, root: prof.root };
      // Device LOOK (well background + music-strip styling) travels with the
      // profile — gradients carry no bytes; images are data-URLs (no machine
      // paths). Re-validated through the model on BOTH export and import.
      if (raw.look && typeof raw.look === 'object') {
        const look = {};
        const wi = M.normalizeDeckWellImage(raw.look.wellImage);
        const ms = M.normalizeDeckMediaStyle(raw.look.mediaStyle);
        if (wi) look.wellImage = wi;
        if (ms) look.mediaStyle = ms;
        if (look.wellImage || look.mediaStyle) out.look = look;
      }
      return out;
    } catch { return null; }
  }

  // Distinct SDK package ids a (sanitized) profile references — sdkMacro /
  // sdkHandler steps plus sdkState state/live bindings all carry "pkg/…" refs.
  // Used by the deck export to offer embedding those packages in the code.
  function profileSdkPackages(profile, deps) {
    const A = deps && deps.actions;
    if (!A) return [];
    const out = new Set();
    const addRef = (ref) => {
      const s = String(ref || '');
      const i = s.indexOf('/');
      if (i > 0) out.add(s.slice(0, i));
    };
    eachProfileKey(profile, (key) => {
      if (key.kind === 'action' && key.triggers) {
        for (const name of DECK_TRIGGERS) {
          for (const step of A.triggerSteps(key.triggers[name])) {
            if (!step.action) continue;
            if (step.action.type === 'sdkMacro') addRef(step.action.macro);
            if (step.action.type === 'sdkHandler') addRef(step.action.handler);
          }
        }
      }
      if (key.state && key.state.source === 'sdkState') addRef(key.state.name);
      if (key.live && key.live.source === 'sdkState') addRef(key.live.name);
    });
    return Array.from(out);
  }

  // The registry action each slider target drives — so slider keys are
  // DISCLOSED in the import review with the same labels as button actions.
  const SLIDER_TARGET_ACTION = {
    volume: 'volume', appVolume: 'appVolume', spotifyVolume: 'spotifyVolume',
    obsInput: 'obsInputVolume', haLight: 'haLight',
    discordInput: 'discordInputVol', discordOutput: 'discordOutputVol',
  };

  // Which action types a (sanitized) profile contains, as [{ type, count }]
  // sorted by count — shown to the user BEFORE an imported profile is added.
  function profileActionSummary(profile, deps) {
    const A = deps && deps.actions;
    if (!A) return [];
    const counts = new Map();
    eachProfileKey(profile, (key) => {
      // Slider keys drive real registry actions too — disclose them under the
      // same label as the equivalent button action (a profile of pure faders
      // must never review as "no actions").
      if (key.kind === 'slider' && key.slider && SLIDER_TARGET_ACTION[key.slider.target]) {
        const type = SLIDER_TARGET_ACTION[key.slider.target];
        counts.set(type, (counts.get(type) || 0) + 1);
        return;
      }
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

  // ── Envelope-encryption helpers (Web Crypto; work in the browser and under
  //    node ≥ 20 for tests — both expose globalThis.crypto.subtle) ───────────
  const subtleCrypto = () => (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;

  // Canonical form a wrapping key derives from: letters+digits, upper-case, no
  // separators — so a user typing "xnab cdef-ghjk" unlocks "XN-ABCD-EFGH-JKLM".
  function canonCode(s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  // A preset paste is a base64url code, a share link, or JSON — none of which
  // contain a canvas draw() contract. When someone pastes raw animated-background
  // source into Import (a very common mix-up — the code goes in the "Code" editor,
  // not here), decodePreset just returns null and they'd see a generic "not valid"
  // error. Detect the draw() shape so we can point them to the right field instead.
  function looksLikeBgCode(input) {
    const s = String(input == null ? '' : input);
    return /function\s+draw\s*\(|\bdraw\s*=\s*(?:function|\()|\bctx\s*\.\s*(?:fillRect|createLinearGradient|beginPath|drawImage|arc|stroke|fill|clearRect)\b|\brequestAnimationFrame\s*\(/.test(s);
  }

  function randBytes(n) {
    const b = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) { crypto.getRandomValues(b); return b; }
    throw new Error('no-random');
  }

  // A display unlock code: XN-XXXX-XXXX-XXXX (12 random symbols, dashed).
  function makeUnlockCode() {
    const bytes = randBytes(12);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += UNLOCK_ALPHABET[bytes[i] & 31];
      if (i === 3 || i === 7) out += '-';
    }
    return 'XN-' + out;
  }

  // PBKDF2(code) → an AES-GCM key used to wrap/unwrap the content key.
  async function deriveWrapKey(code, salt, iterations) {
    const subtle = subtleCrypto();
    if (!subtle) throw new Error('no-webcrypto');
    const base = await subtle.importKey('raw', new TextEncoder().encode(canonCode(code)), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // Lock an inner preset code into a shareable bundle + the list of unlock codes
  // (shown once to the exporter — never stored). `count` clamps to 1…LOCK_MAX_KEYS.
  async function lockPreset(innerPreset, meta, count) {
    const subtle = subtleCrypto();
    if (!subtle) throw new Error('no-webcrypto');
    const n = Math.max(1, Math.min(LOCK_MAX_KEYS, Math.floor(Number(count)) || 10));
    const codes = [];
    const seen = new Set();
    while (codes.length < n) { const c = makeUnlockCode(); if (!seen.has(c)) { seen.add(c); codes.push(c); } }

    const cek = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    const rawCek = new Uint8Array(await subtle.exportKey('raw', cek));
    const contentIv = randBytes(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: contentIv }, cek, new TextEncoder().encode(String(innerPreset))));

    const keys = [];
    for (const c of codes) {
      const salt = randBytes(16);
      const wk = await deriveWrapKey(c, salt, PBKDF2_ITER);
      const iv = randBytes(12);
      const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, wk, rawCek));
      keys.push({ salt: bytesToBase64(salt), iv: bytesToBase64(iv), wrapped: bytesToBase64(wrapped) });
    }

    const env = {
      xenonLocked: LOCK_FORMAT,
      kind: (meta && PRESET_KINDS.includes(meta.kind)) ? meta.kind : 'theme',
      name: String((meta && meta.name) || '').slice(0, 60),
      appVersion: (meta && meta.appVersion) || '',
      exportedAt: (meta && meta.exportedAt) || '',
      kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITER },
      enc: { iv: bytesToBase64(contentIv), ct: bytesToBase64(ct) },
      keys,
    };
    return { code: b64urlEncode(JSON.stringify(env)), codes };
  }

  // Recognise a locked bundle (before asking for a code) and normalise it into a
  // trusted shape, or null. Rejects malformed / out-of-bounds envelopes so the
  // unlock path only ever iterates a sane set of entries.
  function peekLocked(input) {
    const json = extractPresetPayload(input);
    if (json == null) return null;
    let env;
    try { env = JSON.parse(json); } catch { return null; }
    if (!env || typeof env !== 'object' || env.xenonLocked !== LOCK_FORMAT) return null;
    if (!PRESET_KINDS.includes(env.kind)) return null;
    const enc = env.enc;
    if (!enc || typeof enc.iv !== 'string' || typeof enc.ct !== 'string') return null;
    if (!Array.isArray(env.keys) || !env.keys.length || env.keys.length > LOCK_MAX_KEYS) return null;
    for (const k of env.keys) {
      if (!k || typeof k.salt !== 'string' || typeof k.iv !== 'string' || typeof k.wrapped !== 'string') return null;
    }
    const iters = Math.floor(Number(env.kdf && env.kdf.iterations));
    if (!(iters > 0 && iters <= LOCK_MAX_ITER)) return null;
    return {
      kind: env.kind,
      name: typeof env.name === 'string' ? env.name.slice(0, 60) : '',
      appVersion: typeof env.appVersion === 'string' ? env.appVersion : '',
      iterations: iters,
      enc: { iv: enc.iv, ct: enc.ct },
      keys: env.keys.map((k) => ({ salt: k.salt, iv: k.iv, wrapped: k.wrapped })),
    };
  }

  // Try `code` against every wrapped entry; on the one that unwraps, decrypt the
  // payload and return the inner preset string (a normal code, fed back through
  // decodePreset by the caller). Wrong/absent code → null. `locked` is a
  // peekLocked() result. AES-GCM auth failure is expected per non-matching entry.
  async function unlockPreset(locked, code) {
    const subtle = subtleCrypto();
    if (!subtle || !locked || !code || !canonCode(code)) return null;
    let cek = null;
    for (const entry of locked.keys) {
      try {
        const wk = await deriveWrapKey(code, base64ToBytes(entry.salt), locked.iterations);
        const rawCek = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(entry.iv) }, wk, base64ToBytes(entry.wrapped));
        cek = await subtle.importKey('raw', rawCek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
        break;
      } catch { /* not this entry's code — keep trying */ }
    }
    if (!cek) return null;
    try {
      const plain = await subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(locked.enc.iv) }, cek, base64ToBytes(locked.enc.ct));
      return new TextDecoder().decode(plain);
    } catch { return null; }
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

    function download(filename, text, mime) {
      const blob = new Blob([text], { type: mime || 'application/json' });
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
        return { id: p.id, name: pageName(p, i), count, imported: p.imported === true };
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
    async function shareDeckProfile(profileObj) {
      // Redistribution guard: a profile that arrived via a share code is someone
      // else's work — only original creations may leave as a new code.
      if (profileObj && profileObj.imported === true) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      const prof = sanitizeDeckProfile(profileObj, deckDeps());
      if (!prof || !countProfileKeys(prof)) {
        toast(tr('preset_share_empty_deck', 'This profile is empty — nothing to share.'), '', 'error');
        return;
      }
      const name = prof.name || tr('preset_kind_deck', 'Deck profile');
      const shareWith = (widgets) => {
        const data = widgets && widgets.length ? Object.assign({}, prof, { widgets }) : prof;
        openShareDialog('deck', name, encodePreset('deck', name, data, { exportedAt: stamp(), appVersion: appVersion() }), prof);
      };
      // Keys referencing installed SDK widgets (macros/handlers/states) work on
      // another machine only if those packages travel too — offer to embed them.
      // Only the user's OWN packages are offered: community-installed ones can't
      // be redistributed (the receiver finds them in the gallery instead — and
      // /sdk/export would refuse them server-side anyway).
      const referenced = profileSdkPackages(prof, deckDeps());
      let pkgs = referenced.slice(0, DECK_EMBED_MAX_WIDGETS);
      if (pkgs.length) {
        const meta = new Map((await listSdkWidgets()).map((w) => [w.id, w]));
        pkgs = pkgs.filter((id) => { const w = meta.get(id); return !w || w.exportable !== false; });
      }
      if (!pkgs.length) { shareWith(null); return; }
      const { body, close } = buildModal(tr('preset_deck_deps_title', 'Include the widgets this profile uses?'));
      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_deck_deps_desc', 'Some keys use installed community widgets. Embedding them makes the shared code work out of the box (the receiver still reviews and approves each widget).');
      body.appendChild(desc);
      const chips = document.createElement('div');
      chips.className = 'preset-deck-acts';
      pkgs.forEach((id) => { const c = document.createElement('span'); c.className = 'preset-deck-act'; c.textContent = '🧩 ' + id; chips.appendChild(c); });
      body.appendChild(chips);
      const row = actionRow();
      const skip = document.createElement('button');
      skip.type = 'button'; skip.className = 'settings-btn';
      skip.textContent = tr('preset_deck_deps_skip', 'Without widgets');
      skip.addEventListener('click', () => { close(); shareWith(null); });
      const inc = document.createElement('button');
      inc.type = 'button'; inc.className = 'settings-btn primary';
      inc.textContent = tr('preset_deck_deps_include', 'Include ({n})').replace('{n}', pkgs.length);
      inc.addEventListener('click', async () => {
        inc.disabled = true;
        const meta = await listSdkWidgets();
        const byId = new Map(meta.map((w) => [w.id, w]));
        const widgets = [];
        for (const id of pkgs) {
          try {
            const res = await fetch('/sdk/export/' + encodeURIComponent(id));
            const d = await res.json();
            if (!res.ok || !d.ok || !d.payload) continue;
            const w = byId.get(id) || {};
            widgets.push({
              id,
              name: String(w.name || id).slice(0, 60),
              surface: w.surface === 'ambient' ? 'ambient' : 'tile',
              version: String(w.version || '').slice(0, 20),
              actions: Array.isArray(w.actions) ? w.actions.slice() : [],
              hosts: Array.isArray(w.hosts) ? w.hosts.slice() : [],
              payload: d.payload,
            });
          } catch { /* a package that won't export is simply skipped */ }
        }
        close();
        shareWith(widgets);
      });
      row.appendChild(skip); row.appendChild(inc);
      body.appendChild(row);
    }

    // Settings → Share & Import entry: pick which profile (across every deck).
    function exportDeck() {
      const D = window.Deck;
      const all = (D && D.listAllDeckProfiles) ? D.listAllDeckProfiles() : [];
      if (!all.length) {
        toast(tr('preset_share_empty_deck', 'This profile is empty — nothing to share.'), '', 'error');
        return;
      }
      // Nothing of the user's own to share → say why instead of an all-disabled picker.
      if (!all.some(p => p.imported !== true)) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
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
        btn.disabled = p.imported === true;   // imported = someone else's work → not re-shareable
        const nm = document.createElement('span');
        nm.className = 'preset-page-name';
        nm.textContent = p.name;
        const meta = document.createElement('span');
        meta.className = 'preset-page-meta';
        meta.textContent = p.imported === true
          ? tr('preset_imported_hint', 'imported — not shareable')
          : p.keys + ' ' + tr('preset_deck_keys', 'keys');
        btn.appendChild(nm); btn.appendChild(meta);
        btn.addEventListener('click', () => { close(); doExportDeck(p); });
        list.appendChild(btn);
      });
      body.appendChild(list);
    }

    // ---- export entry points ----
    // The live look counts as imported when it exactly matches a theme card that
    // arrived via a share code (tweak any token and it's a derivative — yours).
    function currentThemeImported() {
      try {
        if (typeof findActiveThemeId !== 'function' || typeof getCustomThemes !== 'function') return false;
        const id = findActiveThemeId();
        const card = getCustomThemes().find(x => x.id === id);
        return !!(card && card.imported === true);
      } catch { return false; }
    }
    // Current look + embedded custom typeface, ready to encode. Shared by the
    // single theme export and the bundle build so both codes are self-contained.
    // Skips the font (with a heads-up) if it's too big to stay a practical share
    // code — colours still export, and the font remains available via backup.
    async function themeExportData() {
      const data = currentTheme();
      const font = (typeof hubSettings !== 'undefined' && hubSettings) ? hubSettings.uiFont : null;
      if (font && typeof font.url === 'string' && FONT_EXT_RE.test(font.url)) {
        try {
          const buf = await (await fetch(getFontSource(font))).arrayBuffer();
          if (buf.byteLength && buf.byteLength <= THEME_FONT_EMBED_MAX) {
            data.fontData = {
              data: bytesToBase64(new Uint8Array(buf)),
              ext: (font.url.match(FONT_EXT_RE)[1] || '').toLowerCase(),
              name: String(font.name || '').slice(0, 120),
            };
          } else {
            toast(tr('preset_font_too_large', 'Font too large to embed — the theme was shared without it.'), '', 'error');
          }
        } catch { /* font unreadable → export colours only */ }
      }
      return data;
    }
    async function exportTheme() {
      if (currentThemeImported()) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      const name = tr('preset_share_theme_name', 'My theme');
      const data = await themeExportData();
      openShareDialog('theme', name, encodePreset('theme', name, data, { exportedAt: stamp(), appVersion: appVersion() }));
    }
    // Share only the code-defined animated background as its own compact code, so
    // it can be swapped in without carrying (or overwriting) a whole theme. Its
    // bundled images (data: URIs) ride along, so the shared background stays
    // self-contained — no external hosts, no dead links.
    function exportBg() {
      const cb = HS().bgCustom;
      const code = (cb && typeof cb.code === 'string') ? cb.code.trim() : '';
      if (!code) {
        toast(tr('preset_share_empty_bg', 'No animated background to share yet — create or pick one first.'), '', 'error');
        return;
      }
      // Redistribution guard: an imported background is someone else's work.
      if (cb.imported === true) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      const name = (cb && cb.name && String(cb.name).trim()) || tr('preset_kind_bg', 'Animated background');
      const data = { name, code };
      const assets = (window.CustomBg && CustomBg.sanitizeBgAssets) ? CustomBg.sanitizeBgAssets(cb.assets) : {};
      if (Object.keys(assets).length) data.assets = assets;
      openShareDialog('bg', name, encodePreset('bg', name, data, { exportedAt: stamp(), appVersion: appVersion() }), null, data);
    }
    // Export a page. With more than one page, ask WHICH page first (defaulting the
    // highlight to the one you're viewing) instead of silently taking the current one.
    function exportPage() {
      const pages = listPages();
      if (!pages.some(p => p.count > 0)) {
        toast(tr('preset_share_empty_page', 'This page is empty — nothing to share.'), '', 'error');
        return;
      }
      // Only imported pages left → say why instead of an all-disabled picker.
      if (!pages.some(p => p.count > 0 && !p.imported)) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      if (pages.length === 1) { doExportPage(pages[0].id); return; }
      const pager = window.DashboardPager;
      const curId = (pager && pager.getCurrentPage && pager.getCurrentPage()) || '';
      openPagePicker(pages, curId);
    }
    // Per-tile decoration images uploaded locally live at /uploads/tileasset-* —
    // machine-local paths that don't exist on anyone else's install. Before a page
    // (or bundle) leaves as a code, inline those into base64 data: URIs so the
    // shared layout is self-contained. Curated `preset` ids and existing data: URIs
    // are already portable and untouched. Destination caps mirror normalizeTileDecor
    // (bg ≤1.5M, frame/overlay ≤900k chars, ~3.2M total under the 4MB envelope), so
    // nothing inlined here is rejected on import. Mutates items; resolves true if
    // anything had to be dropped for size/read failure.
    async function _fetchAsDataUri(url) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('asset unreadable');
      const blob = await res.blob();
      return await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onerror = () => reject(new Error('read failed'));
        fr.onload = () => resolve(String(fr.result || ''));
        fr.readAsDataURL(blob);
      });
    }
    async function inlineDecorAssets(items) {
      if (!Array.isArray(items)) return false;
      let total = 0; let warned = false;
      const cache = new Map();
      const conv = async (src, maxChars) => {
        if (typeof src !== 'string' || !src.startsWith('/uploads/')) return src;
        const key = src + '|' + maxChars;
        if (cache.has(key)) return cache.get(key);
        let out = '';
        try {
          const uri = await _fetchAsDataUri(src);
          if (uri.length <= maxChars && total + uri.length <= 3200000) { total += uri.length; out = uri; }
          else warned = true;
        } catch { warned = true; }
        cache.set(key, out); return out;
      };
      for (const it of items) {
        if (!it || !it.style || !it.style.decor) continue;
        // capturePage hands back a LIVE reference to the tile's style; clone it so
        // inlining images here never rewrites the running layout on disk.
        it.style = JSON.parse(JSON.stringify(it.style));
        const d = it.style.decor;
        // Drop only the image when it can't inline — a gradient living alongside
        // it is byte-free and must survive in the shared code (same rule as frame).
        if (d.bg && d.bg.src) { d.bg.src = await conv(d.bg.src, 1400000); if (!d.bg.src) { delete d.bg.src; if (!d.bg.grad) delete d.bg; } }
        if (d.frame && d.frame.src) { d.frame.src = await conv(d.frame.src, 850000); if (!d.frame.src && !d.frame.preset) delete d.frame; }
        if (Array.isArray(d.overlays)) {
          for (const ov of d.overlays) { if (ov && ov.src) ov.src = await conv(ov.src, 850000); }
          d.overlays = d.overlays.filter(ov => ov && (ov.preset || ov.src));
          if (!d.overlays.length) delete d.overlays;
        }
      }
      return warned;
    }
    async function doExportPage(pageId) {
      // Redistribution guard: a page inserted from a shared preset is someone
      // else's layout — only original pages may leave as a new code.
      const meta = listPages().find(p => p.id === pageId);
      if (meta && meta.imported) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      const cp = capturePage(pageId);
      if (!cp || !cp.data || !Array.isArray(cp.data.items) || !cp.data.items.length) {
        toast(tr('preset_share_empty_page', 'This page is empty — nothing to share.'), '', 'error');
        return;
      }
      const dropped = await inlineDecorAssets(cp.data.items);
      if (dropped) toast(tr('preset_decor_too_large', 'Some widget images were too large to fit in the code and were left out.'), '', 'error');
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
        btn.disabled = !p.count || p.imported === true;

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
        meta.textContent = p.imported === true
          ? tr('preset_imported_hint', 'imported — not shareable')
          : p.count
            ? p.count + ' ' + tr('preset_pick_widgets', 'widgets')
            : tr('preset_pick_empty', 'empty');

        btn.appendChild(nm);
        btn.appendChild(meta);
        if (p.count) btn.addEventListener('click', () => { close(); doExportPage(p.id); });
        list.appendChild(btn);
      });
      body.appendChild(list);
    }

    // ---- bundle ("Pacchetto Xenon") export ----
    // A package is a bundle of EVERYTHING you'd hand someone to reproduce your
    // whole setup: theme (font included), page layouts, Deck profiles, the
    // animated background, and your own widgets/Ambient scenes — in one
    // code/file. Widgets travel as their validated file payload (GET
    // /sdk/export) and re-install through the same server boundary. Only the
    // user's OWN creations are packable: imported items show up disabled.
    const BUNDLE_MAX_WIDGETS = 12;
    const BUNDLE_MAX_DECKS = 6;
    // A deck code may embed the packages its keys reference (sdkMacro/sdkHandler/
    // sdkState) — a smaller cap than a bundle: dependencies, not a distribution.
    const DECK_EMBED_MAX_WIDGETS = 4;

    async function listSdkWidgets() {
      try {
        const res = await fetch('/sdk/widgets');
        const d = await res.json();
        return (d && Array.isArray(d.packages)) ? d.packages : [];
      } catch { return []; }
    }

    // Present a checklist of everything installable into a bundle and let the user
    // pick. Nothing is captured until they confirm — widget payloads are only
    // fetched for the ones they keep.
    async function exportBundle() {
      const pages = listPages();
      const widgets = await listSdkWidgets();
      const D = window.Deck;
      const decks = (D && D.listAllDeckProfiles) ? D.listAllDeckProfiles() : [];
      openBundlePicker(pages, widgets, decks);
    }

    function checkRow(labelText, metaText, checked, disabled) {
      const row = document.createElement('label');
      row.className = 'preset-check-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!checked && !disabled;
      cb.disabled = !!disabled;
      const main = document.createElement('span');
      main.className = 'preset-check-main';
      const nm = document.createElement('span');
      nm.className = 'preset-check-name';
      nm.textContent = labelText;
      main.appendChild(nm);
      if (metaText) {
        const meta = document.createElement('span');
        meta.className = 'preset-check-meta';
        meta.textContent = metaText;
        main.appendChild(meta);
      }
      row.appendChild(cb); row.appendChild(main);
      return { row, cb };
    }

    function groupLabel(text) {
      const el = document.createElement('div');
      el.className = 'preset-check-group';
      el.textContent = text;
      return el;
    }

    function openBundlePicker(pages, widgets, decks) {
      const { body, close } = buildModal(tr('preset_bundle_title', 'Create a package'));
      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_bundle_desc', 'Everything you created — theme, pages, Deck profiles, background, widgets and Ambient scenes — in one code or file. Pick what to include.');
      body.appendChild(desc);

      const list = document.createElement('div');
      list.className = 'preset-check-list';
      const importedMeta = tr('preset_imported_hint', 'imported — not shareable');
      // Live summary: every checkbox reports its kind so the footer can say
      // exactly what the package will contain, at a glance.
      const tracked = [];
      let hasImported = false;
      const track = (cb, kind) => { tracked.push({ cb, kind }); cb.addEventListener('change', refreshSummary); };

      // Theme (the current look; blocked when it IS an imported theme).
      list.appendChild(groupLabel('🎨 ' + tr('preset_kind_theme', 'Theme')));
      const themeImported = currentThemeImported();
      hasImported = hasImported || themeImported;
      const themeRow = checkRow(tr('preset_bundle_theme', 'Colours & style'),
        themeImported ? importedMeta : tr('preset_bundle_theme_meta', 'current appearance'), true, themeImported);
      track(themeRow.cb, 'theme');
      list.appendChild(themeRow.row);

      // Pages — one row each; empty and imported pages disabled.
      const pageRows = [];
      if (pages.length) {
        list.appendChild(groupLabel('▦ ' + tr('preset_bundle_pages', 'Pages')));
        pages.forEach((p) => {
          const off = !p.count || p.imported === true;
          hasImported = hasImported || p.imported === true;
          const meta = p.imported === true ? importedMeta
            : p.count ? p.count + ' ' + tr('preset_pick_widgets', 'widgets')
              : tr('preset_pick_empty', 'empty');
          const r = checkRow(p.name, meta, !off, off);
          track(r.cb, 'page');
          list.appendChild(r.row);
          pageRows.push({ id: p.id, cb: r.cb });
        });
      }

      // Deck profiles — sanitized like a single deck export; imported ones disabled.
      const deckRows = [];
      if (decks && decks.length) {
        list.appendChild(groupLabel('🗝 ' + tr('preset_bundle_decks', 'Deck profiles')));
        decks.slice(0, BUNDLE_MAX_DECKS).forEach((p) => {
          const off = p.imported === true;
          hasImported = hasImported || off;
          const meta = off ? importedMeta : p.keys + ' ' + tr('preset_deck_keys', 'keys');
          const r = checkRow(p.name, meta, !off, off);
          track(r.cb, 'deck');
          list.appendChild(r.row);
          deckRows.push({ instanceId: p.instanceId, profileId: p.profileId, cb: r.cb });
        });
      }

      // Animated background — only when one exists; imported ones disabled.
      let bgRow = null;
      const bgCur = HS().bgCustom;
      if (bgCur && typeof bgCur.code === 'string' && bgCur.code.trim()) {
        list.appendChild(groupLabel('🌄 ' + tr('preset_kind_bg', 'Animated background')));
        const off = bgCur.imported === true;
        hasImported = hasImported || off;
        bgRow = checkRow(String(bgCur.name || '').trim() || tr('preset_kind_bg', 'Animated background'),
          off ? importedMeta : tr('preset_bundle_bg_meta', 'current background'), !off, off);
        track(bgRow.cb, 'bg');
        list.appendChild(bgRow.row);
      }

      // Installed SDK widgets and Ambient scenes — separate groups (same payload
      // shape); only the user's OWN packages are selectable, capped so a bundle
      // stays a practical share code.
      const widgetRows = [];
      const addPkgRows = (arr, kind) => {
        arr.forEach((w) => {
          const off = w.exportable === false;
          hasImported = hasImported || off;
          const bits = [];
          if (Array.isArray(w.actions) && w.actions.length) bits.push(w.actions.length + ' ' + tr('preset_bundle_actions', 'actions'));
          if (Array.isArray(w.hosts) && w.hosts.length) bits.push(tr('preset_bundle_network', 'network'));
          const r = checkRow(w.name || w.id, off ? importedMeta : bits.join(' · '), !off, off);
          track(r.cb, kind);
          list.appendChild(r.row);
          widgetRows.push({ id: w.id, cb: r.cb });
        });
      };
      const tiles = widgets.filter(w => w && w.surface !== 'ambient').slice(0, BUNDLE_MAX_WIDGETS);
      const scenes = widgets.filter(w => w && w.surface === 'ambient').slice(0, Math.max(0, BUNDLE_MAX_WIDGETS - tiles.length));
      if (tiles.length) {
        list.appendChild(groupLabel('🧩 ' + tr('preset_bundle_widgets', 'Community widgets')));
        addPkgRows(tiles, 'widget');
      }
      if (scenes.length) {
        list.appendChild(groupLabel('🌙 ' + tr('preset_bundle_scenes', 'Ambient scenes')));
        addPkgRows(scenes, 'scene');
      }
      body.appendChild(list);

      // Live summary footer: exactly what the code will contain.
      const summary = document.createElement('p');
      summary.className = 'preset-modal-desc preset-bundle-summary';
      body.appendChild(summary);
      // Singular/plural labels reuse the per-kind names already translated.
      const KIND_LABELS = {
        theme: [tr('preset_kind_theme', 'Theme'), tr('preset_kind_theme', 'Theme')],
        page: [tr('preset_kind_page', 'Page'), tr('preset_bundle_pages', 'Pages')],
        deck: [tr('preset_kind_deck', 'Deck profile'), tr('preset_bundle_decks', 'Deck profiles')],
        bg: [tr('preset_kind_bg', 'Animated background'), tr('preset_kind_bg', 'Animated background')],
        widget: [tr('preset_kind_widget', 'Widget'), tr('preset_bundle_widgets', 'Community widgets')],
        scene: [tr('preset_kind_ambient', 'Ambient scene'), tr('preset_bundle_scenes', 'Ambient scenes')],
      };
      function refreshSummary() {
        const counts = {};
        tracked.forEach(({ cb, kind }) => { if (cb.checked && !cb.disabled) counts[kind] = (counts[kind] || 0) + 1; });
        const parts = Object.keys(KIND_LABELS)
          .filter(k => counts[k])
          .map(k => counts[k] + ' ' + KIND_LABELS[k][counts[k] > 1 ? 1 : 0]);
        summary.textContent = parts.length
          ? tr('preset_bundle_summary', 'Your package will contain:') + ' ' + parts.join(' · ')
          : tr('preset_bundle_empty', 'Pick at least one thing to include.');
      }
      refreshSummary();
      if (hasImported) {
        const note = document.createElement('p');
        note.className = 'preset-modal-desc preset-bundle-note';
        note.textContent = tr('preset_bundle_imported_note', 'Greyed-out items were installed from someone else and can\'t be redistributed — only your own creations travel in a package.');
        body.appendChild(note);
      }

      const row = actionRow();
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'settings-btn primary';
      go.textContent = tr('preset_bundle_create', 'Create package');
      go.addEventListener('click', async () => {
        const picked = (r) => r.cb.checked && !r.cb.disabled;
        const sel = {
          theme: themeRow.cb.checked && !themeRow.cb.disabled,
          pageIds: pageRows.filter(picked).map(r => r.id),
          deckRefs: deckRows.filter(picked).map(r => ({ instanceId: r.instanceId, profileId: r.profileId })),
          bg: !!(bgRow && picked(bgRow)),
          widgetIds: widgetRows.filter(picked).map(r => r.id),
        };
        if (!sel.theme && !sel.pageIds.length && !sel.deckRefs.length && !sel.bg && !sel.widgetIds.length) {
          toast(tr('preset_bundle_empty', 'Pick at least one thing to include.'), '', 'error');
          return;
        }
        const prev = go.textContent;
        go.disabled = true; go.textContent = tr('preset_bundle_building', 'Packing…');
        try {
          const built = await buildBundle(sel);
          if (!built) { go.disabled = false; go.textContent = prev; toast(tr('preset_bundle_fail', 'Could not build the package.'), '', 'error'); return; }
          // A bundle that embeds widgets can be large; if it can't survive the
          // import decode guard, ask the user to drop some rather than hand out a
          // code that will never import.
          if (b64urlDecode(built.code).length > MAX_CODE_BYTES) {
            go.disabled = false; go.textContent = prev;
            toast(tr('preset_bundle_toobig', 'This package is too big to share — remove a widget and try again.'), '', 'error');
            return;
          }
          close();
          openShareDialog('bundle', built.name, built.code);
        } catch {
          go.disabled = false; go.textContent = prev;
          toast(tr('preset_bundle_fail', 'Could not build the package.'), '', 'error');
        }
      });
      row.appendChild(go);
      body.appendChild(row);
    }

    // Gather the selected parts into a bundle envelope. Widget payloads are read
    // via GET /sdk/export/<id> (already-served files, same asset allowlist/caps —
    // and the server refuses packages that aren't the user's own).
    async function buildBundle(sel) {
      const data = {};
      if (sel.theme) data.theme = await themeExportData();
      const pages = [];
      let decorDropped = false;
      for (const id of sel.pageIds) {
        const cp = capturePage(id);
        if (cp && cp.data && Array.isArray(cp.data.items) && cp.data.items.length) {
          if (await inlineDecorAssets(cp.data.items)) decorDropped = true;
          pages.push({ name: cp.name, data: cp.data });
        }
      }
      if (pages.length) data.pages = pages;
      if (decorDropped) toast(tr('preset_decor_too_large', 'Some widget images were too large to fit in the code and were left out.'), '', 'error');
      // Deck profiles: sanitized exactly like a single deck export, so the code
      // never carries anything the import validator wouldn't accept back.
      const decks = [];
      const D = window.Deck;
      for (const ref of (Array.isArray(sel.deckRefs) ? sel.deckRefs.slice(0, BUNDLE_MAX_DECKS) : [])) {
        const template = (D && D.getProfileTemplate) ? D.getProfileTemplate(ref.instanceId, ref.profileId) : null;
        if (!template || template.imported === true) continue;   // defense in depth: never pack imported work
        const prof = sanitizeDeckProfile(template, deckDeps());
        if (prof && countProfileKeys(prof)) decks.push(prof);
      }
      if (decks.length) data.decks = decks;
      // Animated background: same self-contained shape as the single bg export.
      if (sel.bg) {
        const cb = HS().bgCustom;
        const code = (cb && typeof cb.code === 'string') ? cb.code.trim() : '';
        if (code && cb.imported !== true) {
          const bg = { name: (cb.name && String(cb.name).trim()) || tr('preset_kind_bg', 'Animated background'), code };
          const assets = (window.CustomBg && CustomBg.sanitizeBgAssets) ? CustomBg.sanitizeBgAssets(cb.assets) : {};
          if (Object.keys(assets).length) bg.assets = assets;
          data.bg = bg;
        }
      }
      const widgetsMeta = await listSdkWidgets();
      const byId = new Map(widgetsMeta.map(w => [w.id, w]));
      const widgets = [];
      for (const id of sel.widgetIds.slice(0, BUNDLE_MAX_WIDGETS)) {
        try {
          const res = await fetch('/sdk/export/' + encodeURIComponent(id));
          const d = await res.json();
          if (!res.ok || !d.ok || !d.payload) continue;
          const w = byId.get(id) || {};
          widgets.push({
            id,
            name: String(w.name || id).slice(0, 60),
            surface: w.surface === 'ambient' ? 'ambient' : 'tile',
            actions: Array.isArray(w.actions) ? w.actions.slice() : [],
            hosts: Array.isArray(w.hosts) ? w.hosts.slice() : [],
            streams: Array.isArray(w.streams) ? w.streams.slice() : [],
            hooks: Array.isArray(w.hooks) ? w.hooks.slice() : [],
            payload: d.payload,
          });
        } catch { /* skip a widget that won't export */ }
      }
      if (widgets.length) data.widgets = widgets;
      if (!data.theme && !data.pages && !data.decks && !data.bg && !data.widgets) return null;
      const name = tr('preset_bundle_name', 'My Xenon package');
      return { name, code: encodePreset('bundle', name, data, { exportedAt: stamp(), appVersion: appVersion() }) };
    }

    // ---- single community-widget export ----
    // Share ONE installed widget on its own (a bundle is overkill for that). The
    // payload is the same validated file set a bundle carries, so import reuses
    // the /sdk/install boundary — never auto-granted.
    async function exportWidget() {
      // Ambient scenes have their own export (and their own artifact kind).
      const all = (await listSdkWidgets()).filter(w => w && w.surface !== 'ambient');
      if (!all.length) {
        toast(tr('preset_share_empty_widget', 'No community widgets installed to share.'), '', 'error');
        return;
      }
      // Only the user's own creations are shareable — installed-from-others
      // packages never appear in the picker (the server refuses them anyway).
      const widgets = all.filter(w => w.exportable !== false);
      if (!widgets.length) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      if (widgets.length === 1) { doExportWidget(widgets[0]); return; }
      openWidgetPicker(widgets, 'widget');
    }
    async function exportAmbient() {
      const all = (await listSdkWidgets()).filter(w => w && w.surface === 'ambient');
      if (!all.length) {
        toast(tr('preset_share_empty_ambient', 'No Ambient scenes installed to share.'), '', 'error');
        return;
      }
      const scenes = all.filter(w => w.exportable !== false);
      if (!scenes.length) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      if (scenes.length === 1) { doExportWidget(scenes[0], 'ambient'); return; }
      openWidgetPicker(scenes, 'ambient');
    }
    // Export ONE specific installed package (Settings → installed list row) —
    // no picker detour, and imported packages are refused with the reason.
    function exportWidgetPkg(pkg) {
      if (!pkg || !pkg.id) return;
      if (pkg.exportable === false) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      doExportWidget(pkg, pkg.surface === 'ambient' ? 'ambient' : undefined);
    }
    async function doExportWidget(meta, kind) {
      const presetKind = kind === 'ambient' ? 'ambient' : 'widget';
      const id = meta && meta.id;
      if (!id) return;
      let entry = null;
      try {
        const res = await fetch('/sdk/export/' + encodeURIComponent(id));
        const d = await res.json();
        if (res.ok && d.ok && d.payload) {
          entry = {
            id,
            name: String(meta.name || id).slice(0, 60),
            // Display-only summary of the payload (the manifest inside the
            // payload is the authority at install time).
            surface: meta.surface === 'ambient' ? 'ambient' : 'tile',
            actions: Array.isArray(meta.actions) ? meta.actions.slice() : [],
            hosts: Array.isArray(meta.hosts) ? meta.hosts.slice() : [],
            streams: Array.isArray(meta.streams) ? meta.streams.slice() : [],
            hooks: Array.isArray(meta.hooks) ? meta.hooks.slice() : [],
            payload: d.payload,
          };
        }
      } catch { /* fall through to the error toast below */ }
      if (!entry) { toast(tr('preset_widget_fail', 'Could not export this widget.'), '', 'error'); return; }
      const code = encodePreset(presetKind, entry.name, entry, { exportedAt: stamp(), appVersion: appVersion() });
      if (b64urlDecode(code).length > MAX_CODE_BYTES) {
        toast(tr('preset_widget_toobig', 'This widget is too big to share as a code.'), '', 'error');
        return;
      }
      openShareDialog(presetKind, entry.name, code);
    }

    // ── Native canvas Ambient scene (kind 'ambient-layout') ──────────────────
    // Inline a scene's machine-local /uploads images into base64 data: URIs so the
    // shared layout is self-contained on any install (mirrors inlineDecorAssets for
    // pages). Mutates the passed CLONE; resolves true if anything had to be dropped
    // for size/read failure. Caps mirror the tile-image allowlist so nothing inlined
    // here is rejected by the normalizer on import.
    async function inlineSceneAssets(scene) {
      let warned = false; let total = 0;
      const conv = async (src, maxChars) => {
        if (typeof src !== 'string' || !src.startsWith('/uploads/')) return src;
        try {
          const uri = await _fetchAsDataUri(src);
          if (uri.length <= maxChars && total + uri.length <= 3200000) { total += uri.length; return uri; }
          warned = true; return '';
        } catch { warned = true; return ''; }
      };
      if (scene.bg && scene.bg.url) {
        scene.bg.url = await conv(scene.bg.url, 1100000);
        if (!scene.bg.url && scene.bg.type === 'image') scene.bg.type = scene.bg.grad ? 'gradient' : 'color';
      }
      for (const comp of (Array.isArray(scene.components) ? scene.components : [])) {
        if (comp && comp.props && typeof comp.props.url === 'string' && comp.props.url) {
          comp.props.url = await conv(comp.props.url, 1100000);
        }
      }
      // Per-component decor images ride the shared tile-decor inliner (clones style,
      // owns its own byte budget) — same code the page/bundle export uses.
      if (await inlineDecorAssets(scene.components)) warned = true;
      return warned;
    }
    // Bundle every SDK widget a scene's 'sdk' components reference as a validated
    // /sdk/export payload, so the recipient's scene resolves without hunting the
    // widget down. A widget imported from someone else can't be re-exported (server
    // refuses) — it's skipped and counted so we can tell the user.
    async function collectSceneWidgets(scene) {
      const ids = [];
      for (const c of (Array.isArray(scene.components) ? scene.components : [])) {
        if (c && c.type === 'sdk' && c.props && c.props.pkgId && ids.indexOf(c.props.pkgId) < 0) ids.push(c.props.pkgId);
      }
      const widgets = []; let missing = 0;
      for (const id of ids.slice(0, BUNDLE_MAX_WIDGETS)) {
        try {
          const res = await fetch('/sdk/export/' + encodeURIComponent(id));
          const d = await res.json().catch(() => ({}));
          if (res.ok && d.ok && d.payload) widgets.push({ id, payload: d.payload });
          else missing++;
        } catch { missing++; }
      }
      return { widgets, missing };
    }
    // Share a native canvas Ambient scene from the Settings scene manager.
    async function exportAmbientLayout(sceneId) {
      const AS = window.AmbientScene;
      const scenes = Array.isArray(HS().ambientScenes) ? HS().ambientScenes : [];
      const src = scenes.find(s => s && s.id === sceneId);
      if (!src || !AS) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
      // Redistribution guard: a scene imported from someone else is not re-shareable.
      if (src.imported === true) {
        toast(tr('preset_export_imported', 'This was imported from someone else — you can only share your own creations.'), '', 'error');
        return;
      }
      const scene = AS.normalizeScene(JSON.parse(JSON.stringify(src)));
      delete scene.imported;
      const dropped = await inlineSceneAssets(scene);
      const { widgets, missing } = await collectSceneWidgets(scene);
      const data = { scene };
      if (widgets.length) data.widgets = widgets;
      const name = scene.name || tr('ambient_editor_untitled', 'Untitled scene');
      const code = encodePreset('ambient-layout', name, data, { exportedAt: stamp(), appVersion: appVersion() });
      if (b64urlDecode(code).length > MAX_CODE_BYTES) {
        toast(tr('preset_widget_toobig', 'This is too big to share as a code.'), '', 'error');
        return;
      }
      if (dropped) toast(tr('preset_decor_too_large', 'Some images were too large to fit in the code and were left out.'), '', 'error');
      if (missing) toast(tr('preset_ambient_widget_skipped', 'Some widgets you didn’t create were left out of the code.'), '', 'error');
      openShareDialog('ambient-layout', name, code);
    }

    function openWidgetPicker(widgets, kind) {
      const { body, close } = buildModal(tr('preset_widget_pick', 'Which widget do you want to share?'));
      const list = document.createElement('div');
      list.className = 'preset-page-list';
      widgets.forEach((w) => {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'preset-page-item';
        const nm = document.createElement('span');
        nm.className = 'preset-page-name';
        nm.textContent = w.name || w.id;
        const bits = [];
        if (Array.isArray(w.actions) && w.actions.length) bits.push(w.actions.length + ' ' + tr('preset_bundle_actions', 'actions'));
        if (Array.isArray(w.hosts) && w.hosts.length) bits.push(tr('preset_bundle_network', 'network'));
        const meta = document.createElement('span');
        meta.className = 'preset-page-meta';
        meta.textContent = bits.join(' · ');
        btn.appendChild(nm); btn.appendChild(meta);
        btn.addEventListener('click', () => { close(); doExportWidget(w, kind); });
        list.appendChild(btn);
      });
      body.appendChild(list);
    }

    // ---- apply an imported preset (re-validated per kind) ----
    async function applyPreset(env) {
      if (!env) return false;
      if (env.kind === 'theme') return applyTheme(env.data, env.name);
      if (env.kind === 'page') return applyPage(env.data, env.name, env.gridCols);
      if (env.kind === 'bundle') { const r = await applyBundle(env.data, env.name, env.gridCols); return !!(r && (r.theme || r.pages || r.decks || r.bg || r.widgets.installed)); }
      if (env.kind === 'bg') return applyBg(env.data);
      if (env.kind === 'ambient-layout') return applyAmbientLayout(env.data, env.name);
      // An ambient scene is the same validated /sdk/install payload as a widget.
      if (env.kind === 'widget' || env.kind === 'ambient') return applyWidget(env.data);
      return false;
    }
    // Install a single imported widget through the server boundary (same validate +
    // no-auto-grant path as a bundle). Returns true on a confirmed install.
    async function applyWidget(w) {
      if (!w || typeof w !== 'object' || !w.payload) return false;
      try {
        // origin:'import' marks the package as someone else's work — the server
        // records it and refuses to re-export it as a new share code.
        const res = await fetch('/sdk/install', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(Object.assign({}, w.payload, { origin: 'import' })),
        });
        const d = await res.json().catch(() => ({}));
        const ok = !!(res.ok && d.ok);
        // Refresh the shared package list so a freshly installed widget/scene
        // appears in the picker, palette and Ambient list immediately — without a
        // full dashboard reload. Covers every install path (single widget, ambient
        // scene, bundle, deck dependencies) from the one place they share.
        // Best-effort: a failed refresh never turns a successful install into a
        // failure.
        if (ok && window.CustomWidget && typeof CustomWidget.getPackages === 'function') {
          try { await CustomWidget.getPackages(true); } catch { /* list refresh is best-effort */ }
        }
        return ok;
      } catch { return false; }
    }
    // Drop an imported animated background into bgCustom and enable it. Goes
    // through normalizeSettings (→ normalizeBgCustom: code capped, name trimmed,
    // assets rebuilt entry-by-entry against the data:image allowlist + size caps,
    // enabled only when code is non-empty), so an untrusted code can't set any
    // other field. The code itself only ever runs inside the sandbox iframe.
    function applyBg(data) {
      if (!data || typeof data !== 'object' || typeof data.code !== 'string' || !data.code.trim()) return false;
      try {
        const cur = (HS().bgCustom && typeof HS().bgCustom === 'object') ? HS().bgCustom : {};
        const name = String(data.name || cur.name || '').slice(0, 60);
        hubSettings = normalizeSettings(Object.assign({}, HS(), {
          // imported: someone else's background — export refuses to re-share it
          // until the user replaces the code with their own.
          bgCustom: { code: data.code, name, assets: data.assets, enabled: true, imported: true },
        }));
        if (typeof saveHubSettings === 'function') saveHubSettings();
        if (typeof applyHubSettings === 'function') applyHubSettings();
        if (typeof syncBgFxControls === 'function') syncBgFxControls();
        if (typeof syncSettingsControls === 'function') syncSettingsControls();
        return true;
      } catch { return false; }
    }
    // Import a native canvas Ambient scene: install its bundled SDK widgets first
    // (same validated /sdk/install boundary, never auto-granted), then re-normalize
    // the scene through AmbientScene with a FRESH id + imported marker (so it can't
    // clobber a local scene or be re-shared as the user's own), add it to the scene
    // library, and set it as the active Ambient scene. Returns true on success.
    async function applyAmbientLayout(data, name) {
      const AS = window.AmbientScene;
      if (!AS || !data || typeof data !== 'object' || !data.scene || typeof data.scene !== 'object') return false;
      // Bundled widgets — best-effort: a widget that fails to install renders as a
      // quiet placeholder in the scene, never a hard import failure.
      if (Array.isArray(data.widgets)) {
        for (const w of data.widgets.slice(0, BUNDLE_MAX_WIDGETS)) {
          if (!w || !w.payload) continue;
          try {
            await fetch('/sdk/install', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(Object.assign({}, w.payload, { origin: 'import' })),
            });
          } catch { /* best-effort */ }
        }
        if (window.CustomWidget && typeof CustomWidget.getPackages === 'function') {
          try { await CustomWidget.getPackages(true); } catch { /* list refresh is best-effort */ }
        }
      }
      const norm = AS.normalizeScene(Object.assign({}, data.scene, {
        id: '',
        name: String(name || data.scene.name || '').slice(0, AS.MAX_NAME),
        imported: true,
      }));
      if (!norm) return false;
      try {
        const list = Array.isArray(HS().ambientScenes) ? HS().ambientScenes.slice() : [];
        list.push(norm);
        hubSettings = normalizeSettings(Object.assign({}, HS(), {
          ambientScenes: list,
          ambientMode: Object.assign({}, HS().ambientMode, { sceneId: 'canvas:' + norm.id }),
        }));
        if (typeof saveHubSettings === 'function') saveHubSettings();
        if (typeof applyHubSettings === 'function') applyHubSettings();
        if (typeof window.onAmbientScenesChanged === 'function') window.onAmbientScenesChanged();
        return true;
      } catch { return false; }
    }
    // Install a bundle: theme, pages, Deck profiles, background, then each
    // widget package (server re-validates every file and does NOT auto-grant —
    // the user approves each widget's permissions afterwards). Every part is
    // re-validated by its own boundary and marked imported, so nothing that
    // arrives in a bundle can be re-exported as the user's own. Returns a
    // summary for the toast/dialog.
    async function applyBundle(data, name, gridCols) {
      const out = { theme: false, pages: 0, decks: 0, decksAsPresets: false, bg: false, widgets: { installed: 0, failed: 0 } };
      if (!data || typeof data !== 'object') return out;
      if (data.theme && typeof data.theme === 'object') {
        // Name the saved theme card after the package (e.g. "Cyberpunk / Neon"),
        // not the auto-numbered default — a bundle carries an identity too.
        out.theme = await applyTheme(data.theme, name || null);
      }
      if (Array.isArray(data.pages)) {
        for (const p of data.pages) {
          if (p && p.data && applyPage(p.data, p.name, gridCols)) out.pages++;
        }
      }
      // Deck profiles: rebuilt through sanitizeDeckProfile (untrusted!) and landed
      // on the first Deck — or the Deck preset library when none is on the
      // dashboard, so the import is never a dead end.
      if (Array.isArray(data.decks)) {
        const D = window.Deck;
        const targets = (D && D.listDeckTargets) ? D.listDeckTargets() : [];
        const tgt = targets.length ? targets[0].instanceId : '';
        for (const raw of data.decks.slice(0, BUNDLE_MAX_DECKS)) {
          const prof = sanitizeDeckProfile(raw, deckDeps());
          if (!prof || !countProfileKeys(prof) || !D || !D.importSharedProfile) continue;
          const r = D.importSharedProfile(tgt, prof);
          if (r && r.ok) { out.decks++; if (r.savedAsPreset) out.decksAsPresets = true; }
        }
      }
      // Background AFTER the theme, so a bundle that ships both keeps its
      // explicit background (a theme snapshot can carry its own bgCustom).
      if (data.bg && typeof data.bg === 'object') out.bg = applyBg(data.bg);
      if (Array.isArray(data.widgets)) {
        for (const w of data.widgets.slice(0, BUNDLE_MAX_WIDGETS)) {
          if (!w || !w.payload) { out.widgets.failed++; continue; }
          try {
            const res = await fetch('/sdk/install', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(Object.assign({}, w.payload, { origin: 'import' })),
            });
            const d = await res.json().catch(() => ({}));
            if (res.ok && d.ok) out.widgets.installed++; else out.widgets.failed++;
          } catch { out.widgets.failed++; }
        }
      }
      return out;
    }
    // Persist an embedded font to this machine through POST /font (same validated,
    // server-generated-name path as a manual upload) and return its uiFont ref, or
    // null if there's nothing valid to write. Never throws — a bad font just means
    // the theme imports colours-only.
    async function writeEmbeddedFont(fd) {
      if (!fd || typeof fd !== 'object' || typeof fd.data !== 'string') return null;
      const ext = String(fd.ext || '').toLowerCase();
      if (!/^(woff2|woff|ttf|otf)$/.test(ext)) return null;
      try {
        const bytes = base64ToBytes(fd.data);
        if (!bytes.length) return null;
        const form = new FormData();
        form.append('font', new Blob([bytes]), `imported.${ext}`);
        const res = await fetch('/font', { method: 'POST', body: form });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.url) return null;
        return { url: out.url, name: out.name || String(fd.name || '').slice(0, 120), version: String(Date.now()) };
      } catch { return null; }
    }
    async function applyTheme(data, name) {
      if (!data || typeof data !== 'object') return false;
      const patch = {};
      for (const k of THEME_KEYS) if (k in data) patch[k] = data[k];
      // A theme can carry its own animated background (bgCustom.code). Mirror
      // applyBg: force the imported marker so the installer can use the backdrop
      // but the export guard refuses to let them re-share someone else's work as
      // their own. The payload's own flag is untrusted (a re-sharer could strip
      // it), so we always stamp it here rather than trusting what arrived.
      if (patch.bgCustom && typeof patch.bgCustom === 'object'
          && typeof patch.bgCustom.code === 'string' && patch.bgCustom.code.trim()) {
        patch.bgCustom = Object.assign({}, patch.bgCustom, { imported: true });
      }
      // Only touch the font when the code actually carries one — a colours-only
      // theme must never wipe the user's current typeface.
      const uiFont = await writeEmbeddedFont(data.fontData);
      if (uiFont) patch.uiFont = uiFont;
      if (!Object.keys(patch).length) return false;
      try {
        // normalizeSettings rebuilds known keys only, coercing each field (hex,
        // clamped numbers, aurora/grid, uiFont) — untrusted values can't slip through.
        hubSettings = normalizeSettings(Object.assign({}, HS(), patch));
        if (typeof saveHubSettings === 'function') saveHubSettings();
        if (typeof applyHubSettings === 'function') applyHubSettings();
        if (typeof syncSettingsControls === 'function') syncSettingsControls();
        // Keep the imported look as a card in the Temi gallery so it can be
        // re-applied later (snapshots the now-live settings; skips duplicates).
        if (typeof saveImportedThemeCard === 'function') saveImportedThemeCard(name);
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
        // Someone else's layout: the preset — and every page inserted from it —
        // is marked so it can't be re-exported as the user's own.
        imported: true,
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
    // Reminder shown when importing a community PACKAGE (widget / Ambient scene):
    // these live outside settings, so a backup carries their placement but NOT the
    // package itself — the user must keep the import code to reinstall it later.
    function appendKeepCodeNote(body) {
      const note = document.createElement('p');
      note.className = 'preset-modal-desc preset-keep-code';
      note.textContent = tr('preset_keep_code', 'Keep this import code somewhere safe — your backup saves your settings and layout, but not community widgets or scenes themselves. You\'ll need this code to reinstall it if you ever lose it.');
      body.appendChild(note);
    }
    function codeField(value, readOnly) {
      const f = document.createElement('textarea');
      f.className = 'preset-code-field';
      f.rows = 3;
      if (readOnly) { f.readOnly = true; f.value = value; f.addEventListener('focus', () => f.select()); }
      return f;
    }

    function openShareDialog(kind, name, code, deckProfile, bgData) {
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

      // A background export has nothing to pick from — there is only ever ONE
      // code-defined background (the current setting), just like "Export theme"
      // exports the current theme. Spell out which one is going out, since the
      // button offers no selector.
      if (kind === 'bg') {
        const which = document.createElement('p');
        which.className = 'preset-modal-desc preset-modal-note';
        which.textContent = tr('preset_share_bg_which', 'This is the animated background currently applied to your dashboard. Give it a name in Settings → Background so the recipient knows what it is.');
        body.appendChild(which);
      }

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
      // Same escape hatch for a background whose bundled images push it past the
      // link-practical size: re-export just the code. (A snippet that uses an
      // image unguarded will surface the usual runtime status to the recipient —
      // same as any code edit; well-written snippets check `assets.name` first.)
      if (oversize && kind === 'bg' && bgData && bgData.assets) {
        const noImg = document.createElement('button');
        noImg.type = 'button'; noImg.className = 'settings-btn subtle';
        noImg.textContent = tr('preset_share_noimg', 'Share without images');
        noImg.addEventListener('click', () => {
          close();
          const slim = { name: bgData.name, code: bgData.code };
          openShareDialog('bg', name, encodePreset('bg', name, slim, { exportedAt: stamp(), appVersion: appVersion() }), null, slim);
        });
        row.appendChild(noImg);
      }
      // "Share card" — a canvas-composed PNG with theme swatches + a QR that
      // leads to this creation (public landing/gallery, never 127.0.0.1).
      if (window.ShareCard) {
        const cardBtn = document.createElement('button');
        cardBtn.type = 'button'; cardBtn.className = 'settings-btn subtle';
        cardBtn.textContent = tr('sharecard_open', '🖼 Create share card');
        cardBtn.addEventListener('click', () => { ShareCard.open({ kind, name, code }); });
        row.appendChild(cardBtn);
      }
      // "Publish to the community catalog" — copies the code to the clipboard
      // and opens a prefilled GitHub submission (the code itself is far too big
      // for a URL, hence the paste step). The maintainer reviews and merges;
      // there is no self-publishing backend, by design.
      const pubBtn = document.createElement('button');
      pubBtn.type = 'button'; pubBtn.className = 'settings-btn subtle';
      pubBtn.textContent = tr('preset_publish', '✨ Publish to the catalog');
      pubBtn.addEventListener('click', async () => {
        await copy(code);
        // Prefill only fields whose id + value match the issue form exactly.
        // `kind` is a dropdown: its value must equal the option string VERBATIM
        // ("bg (animated background)" …) or GitHub silently ignores it — this map
        // mirrors .github/ISSUE_TEMPLATE/community-submission.yml, so what you
        // export lands pre-selected on the matching catalog kind/filter. NB:
        // GitHub resolves ?template= against the DEFAULT branch; the template
        // must be on `main` or the link falls back to a blank issue.
        const KIND_OPTIONS = {
          theme: 'theme',
          bg: 'bg (animated background)',
          page: 'page (dashboard page)',
          deck: 'deck (Deck profile)',
          widget: 'widget (community widget)',
          ambient: 'ambient (Ambient scene)',
          bundle: 'bundle (full package)',
        };
        const params = new URLSearchParams({
          template: 'community-submission.yml',
          title: '[Community] ' + String(name || kind).slice(0, 60),
          name: String(name || '').slice(0, 60),
        });
        if (KIND_OPTIONS[kind]) params.set('kind', KIND_OPTIONS[kind]);
        window.open('https://github.com/marcimastro98/Xenon/issues/new?' + params.toString(), '_blank', 'noopener');
        toast(tr('preset_publish_hint', 'Code copied — paste it into the "Share code" field of the GitHub form.'), '', 'info');
      });
      row.appendChild(pubBtn);
      body.appendChild(row);

      // ANY export can additionally be protected with a set of access codes: the
      // shared file installs only for someone who also has a code. The lock just
      // encrypts the inner code string, so it is kind-agnostic (unlock → decode →
      // the normal per-kind import path runs).
      addLockSection(body, close, kind, name, code);
    }

    // Optional "protect with access codes" panel under the theme share dialog.
    function addLockSection(body, closeDialog, kind, name, code) {
      const wrap = document.createElement('div');
      wrap.className = 'preset-lock-section';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'settings-btn subtle preset-lock-toggle';
      toggle.textContent = tr('preset_lock_toggle', '🔒 Protect with access codes');
      wrap.appendChild(toggle);

      const form = document.createElement('div');
      form.className = 'preset-lock-form';
      form.hidden = true;

      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_lock_desc', 'Generate a set of access codes. Share the protected file with anyone — it only installs for someone who also has one of the codes. Hand a different code to each person.');
      form.appendChild(desc);

      const label = document.createElement('label');
      label.className = 'preset-lock-count';
      const labelText = document.createElement('span');
      labelText.textContent = tr('preset_lock_count', 'How many codes?');
      const num = document.createElement('input');
      num.type = 'number'; num.min = '1'; num.max = String(LOCK_MAX_KEYS); num.value = '10';
      num.className = 'preset-lock-count-input';
      label.appendChild(labelText); label.appendChild(num);
      form.appendChild(label);

      const genRow = actionRow();
      const gen = document.createElement('button');
      gen.type = 'button'; gen.className = 'settings-btn primary';
      gen.textContent = tr('preset_lock_generate', 'Generate codes');
      gen.addEventListener('click', async () => {
        const n = Math.max(1, Math.min(LOCK_MAX_KEYS, parseInt(num.value, 10) || 10));
        const prev = gen.textContent;
        gen.disabled = true; gen.textContent = tr('preset_lock_generating', 'Generating…');
        try {
          // Encrypt the raw envelope JSON, not the re-encoded code: locking the
          // b64url code would base64 an already-base64 payload, inflating a
          // font-embedded theme past MAX_CODE_BYTES so it could never be decoded
          // back on import. decodePreset() accepts the JSON form directly.
          let inner = code;
          try { inner = b64urlDecode(code); } catch { /* not b64url (already JSON) → lock as-is */ }
          const res = await lockPreset(inner, { kind, name, appVersion: appVersion(), exportedAt: stamp() }, n);
          closeDialog();
          openLockedShareDialog(kind, name, res.code, res.codes);
        } catch {
          gen.disabled = false; gen.textContent = prev;
          toast(tr('preset_lock_fail', 'Could not protect this export. Try again.'), '', 'error');
        }
      });
      genRow.appendChild(gen);
      form.appendChild(genRow);

      toggle.addEventListener('click', () => {
        form.hidden = !form.hidden;
        toggle.classList.toggle('is-open', !form.hidden);
      });
      wrap.appendChild(form);
      body.appendChild(wrap);
    }

    // Result dialog for a protected export: the shareable (encrypted) bundle plus
    // the one-time codes to hand out. The codes are shown ONCE — there is no copy
    // kept anywhere, so the exporter must save them now.
    function openLockedShareDialog(kind, name, lockedCode, codes) {
      const { body } = buildModal(tr('preset_share_title', 'Share preset'));

      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = tr('preset_kind_' + kind, kind);
      what.appendChild(chip);
      const lockChip = document.createElement('span');
      lockChip.className = 'preset-modal-kind preset-locked-chip';
      lockChip.textContent = '🔒 ' + tr('preset_locked_chip', 'Protected');
      what.appendChild(lockChip);
      if (name) {
        const nm = document.createElement('span');
        nm.className = 'preset-modal-whatname';
        nm.textContent = name;
        what.appendChild(nm);
      }
      body.appendChild(what);

      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_lock_result_desc', 'Share this file or link with anyone. It only installs for someone who also has one of the access codes below — give a different code to each person.');
      body.appendChild(desc);

      const oversize = lockedCode.length > LINK_SOFT_MAX;
      const link = linkFor(lockedCode);
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
      // Primary action here: this file IS the exported (protected) theme — label it
      // so it can't be mistaken for a generic download.
      dlBtn.type = 'button'; dlBtn.className = 'settings-btn';
      dlBtn.textContent = tr('preset_lock_download', 'Download protected file');
      dlBtn.addEventListener('click', () => {
        let pretty = link;
        try { pretty = JSON.stringify(JSON.parse(b64urlDecode(lockedCode)), null, 2); } catch { /* keep link */ }
        const safe = String(name || kind).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 40) || kind;
        download('xenon-' + kind + '-' + safe + '-locked.json', pretty);
      });
      row.appendChild(dlBtn);
      body.appendChild(row);

      const codesHead = document.createElement('p');
      codesHead.className = 'preset-modal-desc preset-lock-codes-head';
      codesHead.textContent = tr('preset_lock_codes_head', 'Access codes');
      body.appendChild(codesHead);

      const list = document.createElement('div');
      list.className = 'preset-lock-codes';
      codes.forEach((c, i) => {
        const rowc = document.createElement('div');
        rowc.className = 'preset-lock-code-row';
        const idx = document.createElement('span');
        idx.className = 'preset-lock-code-idx';
        idx.textContent = String(i + 1);
        const val = document.createElement('code');
        val.className = 'preset-lock-code-val';
        val.textContent = c;
        const cp = document.createElement('button');
        cp.type = 'button'; cp.className = 'settings-btn subtle preset-lock-code-copy';
        cp.textContent = tr('preset_copy', 'Copy');
        cp.addEventListener('click', async () => {
          const ok = await copy(c);
          cp.textContent = ok ? tr('preset_copied', 'Copied!') : tr('preset_copy_fail', 'Select & copy');
          setTimeout(() => { cp.textContent = tr('preset_copy', 'Copy'); }, 1400);
        });
        rowc.appendChild(idx); rowc.appendChild(val); rowc.appendChild(cp);
        list.appendChild(rowc);
      });
      body.appendChild(list);

      const codesText = () => codes.map((c, i) => (i + 1) + '. ' + c).join('\n');
      const tools = actionRow();
      const copyAll = document.createElement('button');
      copyAll.type = 'button'; copyAll.className = 'settings-btn';
      copyAll.textContent = tr('preset_lock_copy_all', 'Copy all codes');
      copyAll.addEventListener('click', async () => {
        const ok = await copy(codesText());
        copyAll.textContent = ok ? tr('preset_lock_copied_all', 'Codes copied!') : tr('preset_copy_fail', 'Select & copy');
        setTimeout(() => { copyAll.textContent = tr('preset_lock_copy_all', 'Copy all codes'); }, 1600);
      });
      tools.appendChild(copyAll);
      const dlCodes = document.createElement('button');
      dlCodes.type = 'button'; dlCodes.className = 'settings-btn subtle';
      dlCodes.textContent = tr('preset_lock_download_codes', 'Download codes (.txt)');
      dlCodes.addEventListener('click', () => {
        const safe = String(name || kind).replace(/[^a-z0-9._-]+/gi, '-').slice(0, 40) || kind;
        const header = tr('preset_lock_codes_head', 'Access codes') + (name ? ' — ' + name : '') + '\n\n';
        download('xenon-' + kind + '-' + safe + '-codes.txt', header + codesText() + '\n', 'text/plain');
      });
      tools.appendChild(dlCodes);
      body.appendChild(tools);

      const note = document.createElement('p');
      note.className = 'preset-modal-desc preset-lock-note';
      note.textContent = tr('preset_lock_codes_note', 'Save these codes now — they are shown only once. Each unlocks the theme and can be reused, so give one to each person and keep them private. If you lose them you cannot hand out new copies.');
      body.appendChild(note);
    }

    function openImport(prefill) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const desc = document.createElement('p');
      desc.className = 'preset-modal-desc';
      desc.textContent = tr('preset_import_desc', 'Paste a preset link or code, or choose a .json file.');
      body.appendChild(desc);

      const field = codeField('', false);
      field.placeholder = tr('preset_import_placeholder', 'Paste the link or code here…');
      body.appendChild(field);

      // A protected preset needs an unlock code too — reveal this field the
      // moment the pasted content is recognised as a locked bundle.
      const unlockWrap = document.createElement('div');
      unlockWrap.className = 'preset-unlock-wrap';
      unlockWrap.hidden = true;
      const unlockLabel = document.createElement('label');
      unlockLabel.className = 'preset-unlock-label';
      const unlockText = document.createElement('span');
      unlockText.textContent = tr('preset_unlock_label', 'Unlock code');
      const unlockField = document.createElement('input');
      unlockField.type = 'text';
      unlockField.className = 'preset-unlock-field';
      unlockField.placeholder = tr('preset_unlock_placeholder', 'Enter your code…');
      unlockLabel.appendChild(unlockText); unlockLabel.appendChild(unlockField);
      unlockWrap.appendChild(unlockLabel);

      const syncUnlockVisibility = () => { unlockWrap.hidden = !peekLocked(field.value); };
      field.addEventListener('input', syncUnlockVisibility);
      if (prefill) { field.value = prefill; syncUnlockVisibility(); }
      body.appendChild(unlockWrap);

      const fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.style.display = 'none';
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => { field.value = String(reader.result || ''); syncUnlockVisibility(); };
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
      importBtn.addEventListener('click', async () => {
        // Protected preset: unwrap it with the recipient's code first, then treat
        // the decrypted inner code exactly like a normal paste.
        const locked = peekLocked(field.value);
        let env;
        if (locked) {
          if (unlockWrap.hidden) {
            unlockWrap.hidden = false; unlockField.focus();
            toast(tr('preset_unlock_needed', 'This preset is protected. Enter the access code to import it.'), '', 'info');
            return;
          }
          if (!canonCode(unlockField.value)) { unlockField.focus(); return; }
          const inner = await unlockPreset(locked, unlockField.value);
          if (!inner) { toast(tr('preset_unlock_bad', 'Wrong or invalid code.'), '', 'error'); return; }
          env = decodePreset(inner);
        } else {
          env = decodePreset(field.value);
        }
        if (!env) {
          // Pasting a raw draw() snippet here is a common mix-up — send them to
          // the "Code" editor instead of a bare "not a valid code" dead end.
          if (!locked && looksLikeBgCode(field.value)) {
            toast(tr('preset_import_looks_like_code', 'That looks like animated-background code — paste it into the "Code" box under Animated background, not here. Import only accepts a shared preset code, link, or .json file.'), '', 'info');
            return;
          }
          toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return;
        }
        // Deck profiles carry actions → their own review step (what's inside +
        // which deck it goes to), never applied straight from the paste box.
        if (env.kind === 'deck') {
          const prof = sanitizeDeckProfile(env.data, deckDeps());
          if (!prof || !countProfileKeys(prof)) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
          // Embedded widget dependencies (v4.4 codes): reviewed + installed via
          // the normal /sdk/install boundary; older codes simply have none.
          const deckWidgets = (env.data && Array.isArray(env.data.widgets)) ? env.data.widgets.slice(0, DECK_EMBED_MAX_WIDGETS) : [];
          close();
          openDeckImport(env.name || prof.name, prof, deckWidgets);
          return;
        }
        // A bundle can install community widgets → its own review step (what's
        // inside + the permission caution) before anything is written.
        if (env.kind === 'bundle') {
          close();
          openBundleImport(env.name, env.data, env.gridCols);
          return;
        }
        // A single community widget also installs code → its own review step
        // (name + what it can do + trust caution) before /sdk/install runs.
        if (env.kind === 'widget') {
          close();
          openWidgetImport(env.name, env.data);
          return;
        }
        // An Ambient scene installs code too → same review step, plus the
        // opt-in "use it as my scene" choice after install.
        if (env.kind === 'ambient') {
          close();
          openAmbientImport(env.name, env.data);
          return;
        }
        // A native canvas scene may bundle SDK widgets AND change the active
        // screensaver → its own review step (thumbnail + what's inside) first.
        if (env.kind === 'ambient-layout') {
          close();
          openAmbientLayoutImport(env.name, env.data);
          return;
        }
        // Theme / background / page don't install code, but the user should still
        // SEE what they're about to change before it happens — a preview step, so
        // every import kind feels the same (never apply-on-first-click).
        if (env.kind === 'theme') { close(); openThemeImport(env.name, env.data); return; }
        if (env.kind === 'bg') { close(); openBgImport(env.name, env.data); return; }
        if (env.kind === 'page') { close(); openPageImport(env.name, env.data, env.gridCols); return; }
        // Defensive fallback: any future kind applies directly rather than silently
        // doing nothing.
        if (await applyPreset(env)) {
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
    function openDeckImport(name, prof, deckWidgets) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const widgets = Array.isArray(deckWidgets) ? deckWidgets.filter((w) => w && w.payload) : [];
      // Install the embedded dependencies (skipping same-id+version already
      // installed) BEFORE the profile lands, so its keys work right away. Each
      // payload goes through the normal /sdk/install validation; grants stay
      // per-user (approved when the widget is first assigned/used).
      const installDeps = async () => {
        if (!widgets.length) return 0;
        let installed = 0;
        const have = new Map((await listSdkWidgets()).map((w) => [w.id, String(w.version || '')]));
        for (const w of widgets) {
          const id = String(w.id || (w.payload && w.payload.id) || '');
          if (id && have.has(id) && have.get(id) === String(w.version || '')) continue;   // same build present
          // applyWidget is the ONE client-side wrapper around /sdk/install —
          // a dependency install failure never blocks the profile itself.
          if (await applyWidget(w)) installed++;
        }
        return installed;
      };

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

      // Embedded widget dependencies: named + trust caution, like a bundle.
      if (widgets.length) {
        const wHead = document.createElement('p');
        wHead.className = 'preset-modal-desc';
        wHead.textContent = tr('preset_deck_deps_incoming', 'It also installs the community widgets its keys use:');
        body.appendChild(wHead);
        const wl = document.createElement('div');
        wl.className = 'preset-check-list preset-bundle-widgets';
        widgets.forEach((w) => {
          const bits = [];
          if (Array.isArray(w.actions) && w.actions.length) bits.push(w.actions.length + ' ' + tr('preset_bundle_actions', 'actions'));
          if (Array.isArray(w.hosts) && w.hosts.length) bits.push(tr('preset_bundle_network', 'network'));
          const r = document.createElement('div');
          r.className = 'preset-check-row is-static';
          const main = document.createElement('span');
          main.className = 'preset-check-main';
          const wnm = document.createElement('span');
          wnm.className = 'preset-check-name';
          wnm.textContent = String((w && w.name) || (w && w.id) || '');
          main.appendChild(wnm);
          if (bits.length) {
            const meta = document.createElement('span');
            meta.className = 'preset-check-meta';
            meta.textContent = bits.join(' · ');
            main.appendChild(meta);
          }
          r.appendChild(main);
          wl.appendChild(r);
        });
        body.appendChild(wl);
        const wCaution = document.createElement('p');
        wCaution.className = 'preset-modal-desc preset-deck-caution';
        wCaution.textContent = tr('preset_bundle_caution', 'This package installs community widgets — code written by others. They run sandboxed with no network, stay hidden until you approve each one\'s permissions, and every action is re-checked by Xenon. Only import packages from people you trust.');
        body.appendChild(wCaution);
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
          btn.addEventListener('click', async () => {
            btn.disabled = true;
            await installDeps();
            finish(D.importSharedProfile(tgt.instanceId, prof));
          });
          list.appendChild(btn);
        });
        body.appendChild(list);
      } else {
        const row = actionRow();
        const go = document.createElement('button');
        go.type = 'button'; go.className = 'settings-btn primary';
        go.textContent = tr('preset_import_apply', 'Import');
        go.addEventListener('click', async () => {
          if (!D || !D.importSharedProfile) { finish(null); return; }
          go.disabled = true;
          await installDeps();
          finish(D.importSharedProfile(targets.length ? targets[0].instanceId : '', prof));
        });
        row.appendChild(go);
        body.appendChild(row);
      }
    }

    // Review step for an imported bundle: shows WHAT it will do — apply a theme,
    // add N pages, and install M community widgets (with the same permission
    // caution as a manual widget install, since bundle widgets carry code) —
    // before anything is written. `data` is the raw envelope data; each part is
    // still re-validated by its own boundary when applied.
    function openBundleImport(name, data, gridCols) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));

      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = tr('preset_kind_bundle', 'Package');
      what.appendChild(chip);
      if (name) {
        const nm = document.createElement('span');
        nm.className = 'preset-modal-whatname';
        nm.textContent = name;
        what.appendChild(nm);
      }
      body.appendChild(what);

      const d = (data && typeof data === 'object') ? data : {};
      const pages = Array.isArray(d.pages) ? d.pages : [];
      const widgets = Array.isArray(d.widgets) ? d.widgets.slice(0, BUNDLE_MAX_WIDGETS) : [];
      // Deck profiles are pre-sanitized HERE so the review reflects exactly what
      // would be stored (same boundary as a single deck import).
      const deckProfiles = (Array.isArray(d.decks) ? d.decks.slice(0, BUNDLE_MAX_DECKS) : [])
        .map(raw => sanitizeDeckProfile(raw, deckDeps()))
        .filter(p => p && countProfileKeys(p));

      const head = document.createElement('p');
      head.className = 'preset-modal-desc';
      head.textContent = tr('preset_bundle_contains', 'This package includes:');
      body.appendChild(head);

      const items = document.createElement('div');
      items.className = 'preset-deck-acts';
      const chipFor = (text) => {
        const c = document.createElement('span');
        c.className = 'preset-deck-act';
        c.textContent = text;
        items.appendChild(c);
      };
      // Ambient scenes travel in the same widgets array (surface is a display
      // hint; the manifest inside the payload is the authority) — name them
      // separately so the summary says what's really inside.
      const sceneCount = widgets.filter(w => w && w.surface === 'ambient').length;
      const tileCount = widgets.length - sceneCount;
      if (d.theme && typeof d.theme === 'object') chipFor('🎨 ' + tr('preset_bundle_theme', 'Colours & style'));
      if (pages.length) chipFor('▦ ' + pages.length + ' ' + tr('preset_bundle_pages', 'Pages'));
      if (deckProfiles.length) chipFor('🗝 ' + deckProfiles.length + ' ' + tr('preset_bundle_decks', 'Deck profiles'));
      if (d.bg && typeof d.bg === 'object' && typeof d.bg.code === 'string' && d.bg.code.trim()) chipFor('🌄 ' + tr('preset_kind_bg', 'Animated background'));
      if (tileCount) chipFor('🧩 ' + tileCount + ' ' + tr('preset_bundle_widgets', 'Community widgets'));
      if (sceneCount) chipFor('🌙 ' + sceneCount + ' ' + tr('preset_bundle_scenes', 'Ambient scenes'));
      if (!items.childNodes.length) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); close(); return; }
      body.appendChild(items);

      // Deck profiles carry ACTIONS → the same transparency a single deck import
      // gets: every action type the keys contain, plus the plain-words caution.
      if (deckProfiles.length) {
        const merged = new Map();
        deckProfiles.forEach((prof) => {
          profileActionSummary(prof, deckDeps()).forEach((s) => merged.set(s.type, (merged.get(s.type) || 0) + s.count));
        });
        if (merged.size) {
          const dHead = document.createElement('p');
          dHead.className = 'preset-modal-desc';
          dHead.textContent = tr('preset_deck_contains', 'This profile contains actions:');
          body.appendChild(dHead);
          const acts = document.createElement('div');
          acts.className = 'preset-deck-acts';
          const DA = window.DeckActions;
          merged.forEach((count, type) => {
            const spec = DA && DA.actionSpec ? DA.actionSpec(type) : null;
            const chipEl = document.createElement('span');
            chipEl.className = 'preset-deck-act';
            chipEl.textContent = tr(spec && spec.labelKey, type) + (count > 1 ? ' ×' + count : '');
            acts.appendChild(chipEl);
          });
          body.appendChild(acts);
          const dCaution = document.createElement('p');
          dCaution.className = 'preset-modal-desc preset-deck-caution';
          dCaution.textContent = tr('preset_deck_caution', 'Only import profiles from people you trust. Actions run only when you tap their key, and each one is re-checked by Xenon before it runs.');
          body.appendChild(dCaution);
        }
      }

      // Name every widget and, when it declares them, its action/network needs —
      // the same transparency a manual install gets.
      if (widgets.length) {
        const wl = document.createElement('div');
        wl.className = 'preset-check-list preset-bundle-widgets';
        widgets.forEach((w) => {
          const bits = [];
          if (Array.isArray(w.actions) && w.actions.length) bits.push(w.actions.length + ' ' + tr('preset_bundle_actions', 'actions'));
          if (Array.isArray(w.hosts) && w.hosts.length) bits.push(tr('preset_bundle_network', 'network'));
          const r = document.createElement('div');
          r.className = 'preset-check-row is-static';
          const main = document.createElement('span');
          main.className = 'preset-check-main';
          const nm = document.createElement('span');
          nm.className = 'preset-check-name';
          nm.textContent = String(w && w.name || w && w.id || '') || tr('preset_kind_bundle', 'Package');
          main.appendChild(nm);
          if (bits.length) {
            const meta = document.createElement('span');
            meta.className = 'preset-check-meta';
            meta.textContent = bits.join(' · ');
            main.appendChild(meta);
          }
          r.appendChild(main);
          wl.appendChild(r);
        });
        body.appendChild(wl);
        const caution = document.createElement('p');
        caution.className = 'preset-modal-desc preset-deck-caution';
        caution.textContent = tr('preset_bundle_caution', 'This package installs community widgets — code written by others. They run sandboxed with no network, stay hidden until you approve each one\'s permissions, and every action is re-checked by Xenon. Only import packages from people you trust.');
        body.appendChild(caution);
      }

      const row = actionRow();
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'settings-btn primary';
      go.textContent = tr('preset_import_apply', 'Import');
      go.addEventListener('click', async () => {
        go.disabled = true; go.textContent = tr('preset_bundle_installing', 'Installing…');
        const res = await applyBundle(d, name, gridCols);
        close();
        if (!res || (!res.theme && !res.pages && !res.decks && !res.bg && !res.widgets.installed && !res.widgets.failed)) {
          toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error');
          return;
        }
        const parts = [];
        if (res.theme) parts.push(tr('preset_bundle_theme', 'Colours & style'));
        if (res.pages) parts.push(res.pages + ' ' + tr('preset_bundle_pages', 'Pages'));
        if (res.decks) parts.push(res.decks + ' ' + tr('preset_bundle_decks', 'Deck profiles'));
        if (res.bg) parts.push(tr('preset_kind_bg', 'Animated background'));
        if (res.widgets.installed) parts.push(res.widgets.installed + ' ' + tr('preset_bundle_widgets', 'Community widgets'));
        toast(tr('preset_import_ok', 'Preset imported'), parts.join(' · ') || tr('preset_kind_bundle', 'Package'), 'success');
        if (res.decksAsPresets) {
          toast(tr('preset_import_ok', 'Preset imported'),
            tr('preset_deck_saved_preset', 'No Deck on the dashboard — saved to the Deck presets. Add a Deck widget and insert it from its profile menu.'), 'info');
        }
        if (res.widgets.installed) {
          toast(tr('preset_bundle_widgets_note_title', 'Widgets installed'),
            tr('preset_bundle_widgets_note', 'Enable the Community widgets switch and approve each one\'s permissions to use them.'), 'info');
        }
        if (res.widgets.failed) {
          toast(tr('preset_bundle_widgets_failed', 'Some widgets could not be installed.'), '', 'error');
        }
      });
      row.appendChild(go);
      body.appendChild(row);
    }

    // Review step for a single imported community widget: its name, what it can
    // do, and the trust caution — before /sdk/install runs. Mirrors the bundle
    // widget review, scoped to one package.
    function openWidgetImport(name, w) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      if (!w || typeof w !== 'object' || !w.payload) {
        toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); close(); return;
      }
      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = tr('preset_kind_widget', 'Widget');
      what.appendChild(chip);
      const nm = document.createElement('span');
      nm.className = 'preset-modal-whatname';
      nm.textContent = String(name || w.name || w.id || '');
      what.appendChild(nm);
      body.appendChild(what);

      const bits = [];
      if (Array.isArray(w.actions) && w.actions.length) bits.push(w.actions.length + ' ' + tr('preset_bundle_actions', 'actions'));
      if (Array.isArray(w.hosts) && w.hosts.length) bits.push(tr('preset_bundle_network', 'network'));
      if (bits.length) {
        const meta = document.createElement('p');
        meta.className = 'preset-modal-desc';
        meta.textContent = bits.join(' · ');
        body.appendChild(meta);
      }
      const caution = document.createElement('p');
      caution.className = 'preset-modal-desc preset-deck-caution';
      caution.textContent = tr('preset_widget_caution', 'This is a community widget — code written by someone else. It runs sandboxed with no network, stays hidden until you approve its permissions, and every action is re-checked by Xenon. Only import widgets from people you trust.');
      body.appendChild(caution);
      appendKeepCodeNote(body);

      const row = actionRow();
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'settings-btn primary';
      go.textContent = tr('preset_import_apply', 'Import');
      go.addEventListener('click', async () => {
        go.disabled = true; go.textContent = tr('preset_bundle_installing', 'Installing…');
        const ok = await applyWidget(w);
        close();
        if (!ok) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
        toast(tr('preset_import_ok', 'Preset imported'), String(name || w.name || ''), 'success');
        toast(tr('preset_bundle_widgets_note_title', 'Widgets installed'),
          tr('preset_bundle_widgets_note', 'Enable the Community widgets switch and approve each one\'s permissions to use them.'), 'info');
      });
      row.appendChild(go);
      body.appendChild(row);
    }

    // Review step for an imported AMBIENT SCENE — the fullscreen screensaver
    // package. Same trust boundary as a widget (/sdk/install, never
    // auto-granted); the extra checkbox sets it as the active scene on success.
    function openAmbientImport(name, w) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      if (!w || typeof w !== 'object' || !w.payload) {
        toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); close(); return;
      }
      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = tr('preset_kind_ambient', 'Ambient scene');
      what.appendChild(chip);
      const nm = document.createElement('span');
      nm.className = 'preset-modal-whatname';
      nm.textContent = String(name || w.name || w.id || '');
      what.appendChild(nm);
      body.appendChild(what);

      const bits = [];
      if (Array.isArray(w.streams) && w.streams.length) bits.push(w.streams.length + ' ' + tr('preset_ambient_streams', 'data feeds'));
      if (Array.isArray(w.actions) && w.actions.length) bits.push(w.actions.length + ' ' + tr('preset_bundle_actions', 'actions'));
      if (Array.isArray(w.hosts) && w.hosts.length) bits.push(tr('preset_bundle_network', 'network'));
      if (bits.length) {
        const meta = document.createElement('p');
        meta.className = 'preset-modal-desc';
        meta.textContent = bits.join(' · ');
        body.appendChild(meta);
      }
      const caution = document.createElement('p');
      caution.className = 'preset-modal-desc preset-deck-caution';
      caution.textContent = tr('preset_ambient_caution', 'This is a community Ambient scene — code written by someone else. It runs fullscreen but sandboxed with no network, and it only sees the data you approve. Only import scenes from people you trust.');
      body.appendChild(caution);
      appendKeepCodeNote(body);

      // Opt-in: make it the active scene right after installing.
      const setRow = document.createElement('label');
      setRow.className = 'preset-check-row';
      const setChk = document.createElement('input');
      setChk.type = 'checkbox'; setChk.checked = true; setChk.className = 'settings-check';
      const setTxt = document.createElement('span');
      setTxt.className = 'preset-check-name';
      setTxt.textContent = tr('preset_ambient_set_active', 'Use it as my Ambient scene');
      setRow.appendChild(setChk); setRow.appendChild(setTxt);
      body.appendChild(setRow);

      const row = actionRow();
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'settings-btn primary';
      go.textContent = tr('preset_import_apply', 'Import');
      go.addEventListener('click', async () => {
        go.disabled = true; go.textContent = tr('preset_bundle_installing', 'Installing…');
        const ok = await applyWidget(w);
        close();
        if (!ok) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
        // applyWidget already refreshed the package list on success.
        if (setChk.checked && typeof updateAmbientSetting === 'function' && typeof w.id === 'string') {
          updateAmbientSetting('sceneId', w.id);   // also prompts for its permissions
        }
        toast(tr('preset_import_ok', 'Preset imported'), String(name || w.name || ''), 'success');
        // A scene needs the SDK subsystem on, exactly like a tile widget —
        // without this hint an SDK-off user only ever sees the builtin fallback.
        const sdkOn = HS().sdkWidgets && HS().sdkWidgets.enabled;
        if (!sdkOn) {
          toast(tr('preset_bundle_widgets_note_title', 'Widgets installed'),
            tr('preset_bundle_widgets_note', 'Enable the Community widgets switch and approve each one\'s permissions to use them.'), 'info');
        }
      });
      row.appendChild(go);
      body.appendChild(row);
    }

    // Shared "kind chip + name" header for the preview dialogs below.
    function presetWhat(kindLabel, name) {
      const what = document.createElement('div');
      what.className = 'preset-modal-what';
      const chip = document.createElement('span');
      chip.className = 'preset-modal-kind';
      chip.textContent = kindLabel;
      what.appendChild(chip);
      if (name) {
        const nm = document.createElement('span');
        nm.className = 'preset-modal-whatname';
        nm.textContent = String(name);
        what.appendChild(nm);
      }
      return what;
    }
    // A small "Apply" action row wired to run `fn` (which returns truthy on
    // success) and then toast + close. Keeps the three preview dialogs uniform.
    function previewApplyRow(close, fn, okName, kindLabel) {
      const row = actionRow();
      const go = document.createElement('button');
      go.type = 'button'; go.className = 'settings-btn primary';
      go.textContent = tr('preset_import_apply', 'Import');
      go.addEventListener('click', async () => {
        go.disabled = true;
        let ok = false;
        try { ok = await fn(); } catch { ok = false; }
        close();
        if (!ok) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); return; }
        toast(tr('preset_import_ok', 'Preset imported'), (okName ? okName + ' · ' : '') + kindLabel, 'success');
      });
      row.appendChild(go);
      return row;
    }

    // Review step for an imported THEME: its accent/background/text colours, the
    // skin (Liquid Glass / Pixel Retro) and whether it bundles a font — shown
    // before the look changes, so a theme import is a choice, not a surprise.
    function openThemeImport(name, data) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const d = (data && typeof data === 'object') ? data : {};
      const kindLabel = tr('preset_kind_theme', 'Theme');
      body.appendChild(presetWhat(kindLabel, name));

      const head = document.createElement('p');
      head.className = 'preset-modal-desc';
      head.textContent = tr('preset_theme_contains', 'This theme sets:');
      body.appendChild(head);

      // Colour swatches. Values are hex strings from the untrusted code — used only
      // as a CSS background (never markup), and each label comes via textContent.
      const sw = document.createElement('div');
      sw.className = 'preset-theme-swatches';
      const addSwatch = (val, labelKey, fallback) => {
        if (typeof val !== 'string' || !/^#?[0-9a-fA-F]{3,8}$/.test(val.trim())) return;
        const item = document.createElement('span');
        item.className = 'preset-theme-sw';
        const dot = document.createElement('span');
        dot.className = 'preset-swatch-dot';
        dot.style.background = val;
        const lab = document.createElement('span');
        lab.className = 'preset-swatch-label';
        lab.textContent = tr(labelKey, fallback);
        item.appendChild(dot); item.appendChild(lab);
        sw.appendChild(item);
      };
      addSwatch(d.accent, 'settings_accent', 'Accent');
      addSwatch(d.background, 'settings_background', 'Background');
      addSwatch(d.text, 'settings_text', 'Text');
      if (sw.childNodes.length) body.appendChild(sw);

      const chips = document.createElement('div');
      chips.className = 'preset-deck-acts';
      const chipFor = (text) => { const c = document.createElement('span'); c.className = 'preset-deck-act'; c.textContent = text; chips.appendChild(c); };
      chipFor((d.styleMode === 'retro')
        ? '🕹️ ' + tr('settings_style_retro', 'Pixel Retro')
        : '💎 ' + tr('settings_style_glass', 'Liquid Glass'));
      if (d.fontData && typeof d.fontData === 'object') chipFor('🔤 ' + tr('preset_theme_font', 'Custom font'));
      body.appendChild(chips);

      body.appendChild(previewApplyRow(close, () => applyTheme(d, name || null), name, kindLabel));
    }

    // Review step for an imported BACKGROUND: name + a live mini-preview of the
    // animated code (same sandboxed srcdoc the real backdrop uses), before it's
    // enabled as the dashboard background.
    function openBgImport(name, data) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const d = (data && typeof data === 'object') ? data : {};
      const kindLabel = tr('preset_kind_bg', 'Background');
      body.appendChild(presetWhat(kindLabel, name || d.name));

      const note = document.createElement('p');
      note.className = 'preset-modal-desc';
      note.textContent = tr('preset_bg_note', 'Animated background');
      body.appendChild(note);

      // Bundled images: say HOW MANY (and how big) ride inside this code, in the
      // same chip style the deck import uses for actions — the user sees what
      // they're importing. Counted after the same sanitizer the apply path uses.
      const assets = (window.CustomBg && CustomBg.sanitizeBgAssets) ? CustomBg.sanitizeBgAssets(d.assets) : {};
      const assetKeys = Object.keys(assets);
      if (assetKeys.length) {
        const chips = document.createElement('div');
        chips.className = 'preset-deck-acts';
        const c = document.createElement('span');
        c.className = 'preset-deck-act';
        const kb = Math.max(1, Math.round(assetKeys.reduce((s, k) => s + assets[k].length, 0) * 3 / 4 / 1024));
        c.textContent = '🖼 ' + assetKeys.length + ' ' + tr('preset_bg_images', 'images') + ' · ' + kb + ' KB';
        chips.appendChild(c);
        body.appendChild(chips);
      }

      // Mini live preview — reuse CustomBg.buildSrcdoc (code + images) so what
      // you see is exactly what will render. Sandboxed, null-origin, no network
      // (identical to the real backdrop frame). Silently skipped if the code is
      // missing/oversized.
      const code = (d && typeof d.code === 'string') ? d.code : '';
      if (code.trim() && window.CustomBg && typeof window.CustomBg.buildSrcdoc === 'function') {
        const frame = document.createElement('iframe');
        frame.className = 'preset-bg-preview';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        frame.setAttribute('aria-hidden', 'true');
        try { frame.srcdoc = window.CustomBg.buildSrcdoc(code, assets); body.appendChild(frame); } catch { /* skip preview */ }
      }

      body.appendChild(previewApplyRow(close, () => applyBg(d), name || d.name, kindLabel));
    }

    // Review step for an imported PAGE layout: name + widget count, before it's
    // added to the saved presets and dropped onto a fresh page.
    function openPageImport(name, data, gridCols) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const d = (data && typeof data === 'object') ? data : {};
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); close(); return; }
      const kindLabel = tr('preset_kind_page', 'Page');
      body.appendChild(presetWhat(kindLabel, name));

      const head = document.createElement('p');
      head.className = 'preset-modal-desc';
      head.textContent = tr('preset_page_contains', 'This page contains:');
      body.appendChild(head);
      const chips = document.createElement('div');
      chips.className = 'preset-deck-acts';
      const c = document.createElement('span');
      c.className = 'preset-deck-act';
      c.textContent = '▦ ' + items.length + ' ' + tr('preset_pick_widgets', 'widgets');
      chips.appendChild(c);
      body.appendChild(chips);

      body.appendChild(previewApplyRow(close, () => applyPage(d, name, gridCols), name, kindLabel));
    }

    // Review step for an imported native canvas SCENE: a true scaled thumbnail
    // (rendered through the exact AmbientCanvas pipeline), the component count and
    // how many SDK widgets ride along — before it's added and set as the active
    // Ambient scene.
    function openAmbientLayoutImport(name, data) {
      const { body, close } = buildModal(tr('preset_import_title', 'Import preset'));
      const AS = window.AmbientScene;
      const d = (data && typeof data === 'object') ? data : {};
      const scene = (AS && d.scene) ? AS.normalizeScene(JSON.parse(JSON.stringify(d.scene))) : null;
      if (!scene || !Array.isArray(scene.components)) { toast(tr('preset_import_bad', 'Not a valid preset code.'), '', 'error'); close(); return; }
      const kindLabel = tr('preset_kind_ambient-layout', 'Ambient scene');
      body.appendChild(presetWhat(kindLabel, name || scene.name));

      const head = document.createElement('p');
      head.className = 'preset-modal-desc';
      head.textContent = tr('preset_ambient_layout_contains', 'This scene contains:');
      body.appendChild(head);

      const chips = document.createElement('div');
      chips.className = 'preset-deck-acts';
      const chipFor = (text) => { const c = document.createElement('span'); c.className = 'preset-deck-act'; c.textContent = text; chips.appendChild(c); };
      chipFor('◳ ' + scene.components.length + ' ' + tr('preset_ambient_components', 'components'));
      const widgetCount = Array.isArray(d.widgets) ? d.widgets.length : 0;
      if (widgetCount) chipFor('🧩 ' + widgetCount + ' ' + tr('preset_ambient_bundled', 'bundled widgets'));
      body.appendChild(chips);

      // True scaled thumbnail — same build pipeline the screensaver uses, one static
      // update pass (no rAF). SDK components render as quiet placeholders here (their
      // widgets aren't installed until the user confirms). Silently skipped if the
      // renderer isn't present.
      const ACP = window.AmbientCanvas && window.AmbientCanvas.preview;
      if (ACP) {
        try {
          const stage = document.createElement('div');
          stage.className = 'preset-ambient-preview';
          stage.appendChild(ACP.buildBg(scene.bg));
          scene.components.slice().sort((a, b) => (a.z || 0) - (b.z || 0)).forEach(comp => {
            const item = ACP.buildItem(comp, { noSdkFrame: true });
            if (item) { ACP.update(item); stage.appendChild(item.el); }
          });
          body.appendChild(stage);
        } catch { /* skip preview */ }
      }

      body.appendChild(previewApplyRow(close, () => applyAmbientLayout(d, name), name || scene.name, kindLabel));
    }

    // A …/#preset=CODE link opens the dashboard straight into the import dialog,
    // prefilled (never auto-applied — the user confirms). Clear the hash so a
    // refresh doesn't re-prompt.
    function checkHash() {
      try {
        const h = location.hash || '';
        if (!/[#&?]preset=/.test(h)) return;
        const valid = decodePreset(h) || peekLocked(h);
        try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
        if (valid) openImport(h.replace(/^#/, ''));
      } catch { /* ignore */ }
    }

    window.PresetShare = { exportTheme, exportPage, exportCurrentPage: exportPage, exportDeck, exportBundle, exportBg, exportWidget, exportAmbient, exportAmbientLayout, exportWidgetPkg, shareDeckProfile, openImport, encodePreset, decodePreset };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', checkHash, { once: true });
    else checkHash();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { encodePreset, decodePreset, sanitizeDeckProfile, profileActionSummary, stripProfileImages, countProfileKeys, lockPreset, unlockPreset, peekLocked, canonCode };
  }
})();
