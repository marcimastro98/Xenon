'use strict';
// Teleprompter — first-party widget for the Xenon Widget SDK (API v1).
//
// A script library feeds a large auto-scrolling prompter: sentence rows lit as
// they cross the focus band, a 3-2-1 countdown into playback, [2s] markers
// that auto-hold the scroll, drag-to-reposition on the touchscreen, mirror
// mode for beam-splitter glass, and a live time-remaining estimate. The
// scroll mutates ONLY transform (translate3d) — rAF while visible, a slow
// heartbeat while the tile is hidden (rAF never fires in a display:none
// iframe) so Deck keys and the island stay live. Deck keys drive it through
// manifest handlers (play / speed / reset) and read three published states
// (playing, speed, remaining); the current sentence is projected into the
// minimal-topbar dynamic island (`island` bridge message, granted capability)
// with the next sentence dimmed and a speed · remaining meta column.
// Full protocol reference: docs/WIDGET_SDK.md in the Xenon repository.
(function () {
  const $ = (id) => document.getElementById(id);
  let reqId = 0;

  const SPEED_MIN = 0.5;
  const SPEED_MAX = 3;
  const SPEED_STEP = 0.25;
  const BASE_PX_PER_S = 40;         // scroll rate at 1.0× (scaled by font size)
  const ISLAND_THROTTLE_MS = 600;   // widget-side; the host coalesces at ~200ms anyway
  const SAVE_DEBOUNCE_MS = 800;
  const CFG_DEBOUNCE_MS = 400;
  const COUNTDOWN_FROM = 3;
  const COUNT_TICK_MS = 700;
  const MAX_SCRIPTS = 24;
  // Sentence boundary: end punctuation, keep the mark, split on the spaces.
  const SENTENCE_RE = /(?<=[.!?…])\s+/;
  // Pause marker, standalone once split out: [2s] [pausa] [pause 1.5s] […]
  const PAUSE_TOKEN_RE = /^\[\s*(?:pausa|pause)?\s*(\d+(?:[.,]\d+)?)?\s*s?\s*\]$/i;
  const PAUSE_SPLIT_RE = /(\[[^\][]{0,24}\])/;
  const PAUSE_DEFAULT_S = 2;
  const PAUSE_MIN_S = 0.5;
  const PAUSE_MAX_S = 30;

  function send(msg) {
    window.parent.postMessage({ xenonSdk: 1, ...msg }, '*');
  }

  function applyTheme(theme) {
    if (!theme) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', theme.accent || '#1ed760');
    root.style.setProperty('--bg', theme.background || '#070808');
    root.style.setProperty('--text', theme.text || '#f0f3f1');
    root.dataset.appearance = theme.appearance === 'light' ? 'light' : 'dark';
  }

  // ── Localization — the host sends its UI language in `init.lang` ──
  // The HTML ships English as the pre-init fallback; init swaps it out.
  const STRINGS = {
    en: { ph: 'Write or paste your script here…\n\nOne sentence per line works best — each line becomes a prompter row, and the highlighted row is what the island shows.', start: 'Start', saved: 'Saved', edit: 'Edit script', slower: 'Slower', playPause: 'Play/Pause', faster: 'Faster', rewind: 'Back to top', mirror: 'Mirror text', newScript: 'New script', delScript: 'Delete script', confirmDel: 'Sure?', scriptName: 'Script name', defaultName: 'Script', hint: '[2s] in the text = automatic pause', island: 'Show in island' },
    it: { ph: 'Scrivi o incolla qui il tuo copione…\n\nUna frase per riga rende meglio — ogni riga diventa una riga del prompter, e quella evidenziata è ciò che mostra l\'isola.', start: 'Avvia', saved: 'Salvato', edit: 'Modifica copione', slower: 'Più lento', playPause: 'Play/Pausa', faster: 'Più veloce', rewind: 'Torna all\'inizio', mirror: 'Specchia il testo', newScript: 'Nuovo copione', delScript: 'Elimina copione', confirmDel: 'Sicuro?', scriptName: 'Nome del copione', defaultName: 'Copione', hint: '[2s] nel testo = pausa automatica', island: 'Mostra nell\'isola' },
    ko: { ph: '여기에 대본을 쓰거나 붙여넣으세요…\n\n한 줄에 한 문장이 가장 좋습니다 — 각 줄이 프롬프터 줄이 되고, 강조된 줄이 아일랜드에 표시됩니다.', start: '시작', saved: '저장됨', edit: '대본 편집', slower: '느리게', playPause: '재생/일시정지', faster: '빠르게', rewind: '처음으로', mirror: '좌우 반전', newScript: '새 대본', delScript: '대본 삭제', confirmDel: '확실해요?', scriptName: '대본 이름', defaultName: '대본', hint: '텍스트의 [2s] = 자동 일시정지', island: '아일랜드에 표시' },
    ja: { ph: 'ここに台本を入力または貼り付けてください…\n\n1行に1文がおすすめです — 各行がプロンプターの行になり、ハイライトされた行がアイランドに表示されます。', start: '開始', saved: '保存済み', edit: '台本を編集', slower: '遅く', playPause: '再生/一時停止', faster: '速く', rewind: '先頭に戻る', mirror: '左右反転', newScript: '新しい台本', delScript: '台本を削除', confirmDel: '本当に？', scriptName: '台本名', defaultName: '台本', hint: 'テキスト内の [2s] = 自動一時停止', island: 'アイランドに表示' },
    zh: { ph: '在此输入或粘贴你的稿件…\n\n每行一句效果最佳——每一行都会成为提词器的一行，高亮的那一行就是灵动岛显示的内容。', start: '开始', saved: '已保存', edit: '编辑稿件', slower: '慢一点', playPause: '播放/暂停', faster: '快一点', rewind: '回到开头', mirror: '镜像文本', newScript: '新建稿件', delScript: '删除稿件', confirmDel: '确定？', scriptName: '稿件名称', defaultName: '稿件', hint: '文本中的 [2s] = 自动暂停', island: '在灵动岛显示' },
    es: { ph: 'Escribe o pega aquí tu guion…\n\nUna frase por línea funciona mejor — cada línea se convierte en una fila del prompter, y la fila resaltada es la que muestra la isla.', start: 'Iniciar', saved: 'Guardado', edit: 'Editar guion', slower: 'Más lento', playPause: 'Reproducir/Pausa', faster: 'Más rápido', rewind: 'Volver al inicio', mirror: 'Reflejar texto', newScript: 'Nuevo guion', delScript: 'Eliminar guion', confirmDel: '¿Seguro?', scriptName: 'Nombre del guion', defaultName: 'Guion', hint: '[2s] en el texto = pausa automática', island: 'Mostrar en la isla' },
    fr: { ph: 'Écrivez ou collez votre script ici…\n\nUne phrase par ligne fonctionne mieux — chaque ligne devient une ligne du prompteur, et la ligne surlignée est celle affichée dans l\'îlot.', start: 'Démarrer', saved: 'Enregistré', edit: 'Modifier le script', slower: 'Plus lent', playPause: 'Lecture/Pause', faster: 'Plus rapide', rewind: 'Revenir au début', mirror: 'Texte en miroir', newScript: 'Nouveau script', delScript: 'Supprimer le script', confirmDel: 'Sûr ?', scriptName: 'Nom du script', defaultName: 'Script', hint: '[2s] dans le texte = pause automatique', island: 'Afficher dans l\'îlot' },
    de: { ph: 'Schreibe oder füge dein Skript hier ein…\n\nEin Satz pro Zeile funktioniert am besten — jede Zeile wird zu einer Prompter-Zeile, und die hervorgehobene Zeile zeigt die Insel.', start: 'Start', saved: 'Gespeichert', edit: 'Skript bearbeiten', slower: 'Langsamer', playPause: 'Wiedergabe/Pause', faster: 'Schneller', rewind: 'Zum Anfang', mirror: 'Text spiegeln', newScript: 'Neues Skript', delScript: 'Skript löschen', confirmDel: 'Sicher?', scriptName: 'Skriptname', defaultName: 'Skript', hint: '[2s] im Text = automatische Pause', island: 'In der Insel anzeigen' },
    pt: { ph: 'Escreva ou cole o seu roteiro aqui…\n\nUma frase por linha funciona melhor — cada frase vira uma linha do prompter, e a linha destacada é a que a ilha mostra.', start: 'Iniciar', saved: 'Salvo', edit: 'Editar roteiro', slower: 'Mais lento', playPause: 'Reproduzir/Pausar', faster: 'Mais rápido', rewind: 'Voltar ao início', mirror: 'Espelhar texto', newScript: 'Novo roteiro', delScript: 'Excluir roteiro', confirmDel: 'Tem certeza?', scriptName: 'Nome do roteiro', defaultName: 'Roteiro', hint: '[2s] no texto = pausa automática', island: 'Mostrar na ilha' },
    ru: { ph: 'Напишите или вставьте сюда свой сценарий…\n\nЛучше всего — одно предложение на строку: каждая строка становится строкой суфлёра, а выделенная строка показывается в «острове».', start: 'Старт', saved: 'Сохранено', edit: 'Редактировать сценарий', slower: 'Медленнее', playPause: 'Пуск/Пауза', faster: 'Быстрее', rewind: 'В начало', mirror: 'Зеркальный текст', newScript: 'Новый сценарий', delScript: 'Удалить сценарий', confirmDel: 'Точно?', scriptName: 'Название сценария', defaultName: 'Сценарий', hint: '[2s] в тексте = автопауза', island: 'Показывать в «острове»' },
    nl: { ph: 'Schrijf of plak hier je script…\n\nEén zin per regel werkt het best — elke regel wordt een prompterregel, en de gemarkeerde regel is wat het eiland toont.', start: 'Start', saved: 'Opgeslagen', edit: 'Script bewerken', slower: 'Langzamer', playPause: 'Afspelen/Pauze', faster: 'Sneller', rewind: 'Terug naar begin', mirror: 'Tekst spiegelen', newScript: 'Nieuw script', delScript: 'Script verwijderen', confirmDel: 'Zeker?', scriptName: 'Scriptnaam', defaultName: 'Script', hint: '[2s] in de tekst = automatische pauze', island: 'Tonen in het eiland' }
  };
  let L = STRINGS.en;
  function applyLang(lang) {
    const base = String(lang || '').toLowerCase().split('-')[0];
    L = STRINGS[base] || STRINGS.en;
    $('script').placeholder = L.ph;
    $('start').textContent = '▶ ' + L.start;
    $('hint').textContent = L.hint;
    const tips = { back: L.edit, slower: L.slower, toggle: L.playPause, faster: L.faster, rewind: L.rewind, mirrorbtn: L.mirror, islandbtn: L.island };
    for (const id of Object.keys(tips)) {
      $(id).setAttribute('aria-label', tips[id]);
      $(id).title = tips[id];
    }
    if (scripts.length) renderTabs();   // ＋ chip title / armed label language
  }

  // ── State ─────────────────────────────────────────────────────
  let hasStorage = false;
  let playing = false;
  let speed = 1;
  let mirror = false;
  let islandOn = true;      // project the current line into the topbar island
  let offset = 0;           // current scroll offset in px (transform only)
  let rafId = 0;
  let beatTimer = 0;        // hidden-tile heartbeat (rAF doesn't fire there)
  let lastTick = 0;         // performance.now() of the last advance
  let lineTops = [];        // measured line offsets for focus-line detection
  let maxScroll = 0;        // cached — a hidden iframe measures 0
  let stageH = 0;           // cached stage height, same reason
  let focusIdx = -1;
  let holdUntil = 0;        // a [pausa] marker holds the scroll until this ts
  let countTimer = 0;       // 3-2-1 countdown into playback
  let countLeft = 0;
  let dragging = false;     // drag-to-reposition on the stage
  let dragStartY = 0;
  let dragStartOffset = 0;
  let dragMoved = false;
  let squelchClick = false; // a drag must not double as a play/pause tap
  let etaText = '';         // formatted time remaining ("2:40")
  let lastEtaAt = 0;
  let lastIslandAt = 0;
  let lastIslandText = '';
  let lastIslandNext = '';
  let lastIslandBadge = '';
  let islandTimer = 0;

  // Script library: `scripts` is the ordered index, texts are cached per id
  // and stored under their own key (s.<id>) so one long script can't crowd
  // the others out of the store's per-value cap.
  let scripts = [];         // [{ id, name }]
  let curId = '';
  const texts = {};         // id → script text (lazy cache)

  // ── Persistence (SDK storage, granted via manifest storage:true) ──
  // Ops go through one queue spaced ≥120ms apart: the server rate-gates a
  // package's store, and a burst (cfg + idx + text) must never lose a write.
  const pendingStores = new Map();
  let opChain = Promise.resolve();
  let lastOpAt = 0;
  function storeOp(op) {
    if (!hasStorage) return Promise.resolve({ ok: false, error: 'not_granted' });
    const p = opChain.then(async () => {
      const wait = Math.max(0, 120 - (Date.now() - lastOpAt));
      if (wait) await new Promise((r) => setTimeout(r, wait));
      lastOpAt = Date.now();
      return new Promise((resolve) => {
        const id = ++reqId;
        pendingStores.set(id, resolve);
        send({ type: 'store', id, op });
      });
    });
    opChain = p.then(() => {}, () => {});
    return p;
  }
  const sGet = (key) => storeOp({ op: 'get', key });
  const sSet = (key, value) => storeOp({ op: 'set', key, value });
  const sDel = (key) => storeOp({ op: 'delete', key });

  let cfgTimer = 0;
  function saveCfg() {
    clearTimeout(cfgTimer);
    cfgTimer = setTimeout(() => { sSet('cfg', { speed, mirror, island: islandOn, cur: curId }); }, CFG_DEBOUNCE_MS);
  }

  let saveTimer = 0;
  let saveDirtyId = '';
  function scheduleSave() {
    saveDirtyId = curId;
    texts[curId] = $('script').value;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!saveDirtyId) return;
    const id = saveDirtyId;
    saveDirtyId = '';
    const r = await sSet('s.' + id, texts[id] == null ? '' : texts[id]);
    if (r && r.ok) {
      $('saved').textContent = L.saved;
      setTimeout(() => { $('saved').textContent = ''; }, 1500);
    }
  }

  let idxTimer = 0;
  function saveIdx(immediate) {
    clearTimeout(idxTimer);
    const doIt = () => sSet('idx', scripts.map((s) => ({ id: s.id, name: s.name })));
    if (immediate) doIt();
    else idxTimer = setTimeout(doIt, 500);
  }

  // ── Script library: cue-card chips ────────────────────────────
  // Tap a chip to switch, tap the ACTIVE chip to rename it inline, ✕ deletes
  // with a two-step confirm (the sandbox has no dialogs), ＋ adds.
  function newScriptId() {
    return 's' + Math.random().toString(36).slice(2, 8);
  }
  function currentMeta() {
    return scripts.find((s) => s.id === curId);
  }
  function renderTabs() {
    const host = $('tabs');
    host.replaceChildren();
    for (const s of scripts) {
      const chip = document.createElement('div');
      chip.className = 'tab' + (s.id === curId ? ' is-on' : '');
      chip.dataset.id = s.id;
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = s.name;   // user text → textContent, never innerHTML
      chip.appendChild(label);
      if (s.id === curId) {
        const x = document.createElement('span');
        x.className = 'tab-x';
        x.textContent = '✕';
        x.title = L.delScript;
        x.setAttribute('aria-label', L.delScript);
        chip.appendChild(x);
      }
      host.appendChild(chip);
    }
    if (scripts.length < MAX_SCRIPTS) {
      const add = document.createElement('div');
      add.className = 'tab tab-add';
      add.textContent = '＋';
      add.title = L.newScript;
      add.setAttribute('role', 'button');
      add.setAttribute('aria-label', L.newScript);
      add.tabIndex = 0;
      host.appendChild(add);
    }
    const on = host.querySelector('.tab.is-on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function startRename(chip) {
    if (chip.querySelector('.tab-edit')) return;
    disarmDelete();
    const cur = currentMeta();
    const label = chip.querySelector('.tab-label');
    if (!cur || !label) return;
    const input = document.createElement('input');
    input.className = 'tab-edit';
    input.maxLength = 40;
    input.value = cur.name;
    input.setAttribute('aria-label', L.scriptName);
    input.style.width = Math.max(6, cur.name.length + 1) + 'ch';
    label.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener('input', () => {
      input.style.width = Math.max(6, input.value.length + 1) + 'ch';
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      else if (ev.key === 'Escape') { input.value = cur.name; input.blur(); }
    });
    input.addEventListener('blur', () => {
      cur.name = input.value.trim().slice(0, 40) || L.defaultName;
      saveIdx(false);
      renderTabs();
    });
  }
  async function switchScript(id) {
    if (id === curId || !scripts.some((s) => s.id === id)) return;
    await flushSave();   // never carry pending edits into another script
    curId = id;
    saveCfg();
    if (texts[id] != null) {
      $('script').value = texts[id];
    } else {
      $('script').value = '';
      const r = await sGet('s.' + id);
      if (r && r.ok && typeof r.value === 'string' && curId === id) {
        texts[id] = r.value;
        $('script').value = r.value;
      }
    }
    renderTabs();
  }
  function addScript() {
    if (scripts.length >= MAX_SCRIPTS) return;
    flushSave();
    const id = newScriptId();
    scripts.push({ id, name: L.defaultName + ' ' + (scripts.length + 1) });
    texts[id] = '';
    curId = id;
    $('script').value = '';
    renderTabs();
    saveIdx(true);
    saveCfg();
    // A fresh script starts life being named — rename mode right away.
    const chip = $('tabs').querySelector('.tab.is-on');
    if (chip) startRename(chip);
  }
  let delArmedAt = 0;
  function disarmDelete() {
    if (!delArmedAt) return;
    delArmedAt = 0;
    const chip = $('tabs').querySelector('.tab.is-armed');
    if (chip) {
      chip.classList.remove('is-armed');
      const cur = currentMeta();
      const lb = chip.querySelector('.tab-label');
      if (lb && cur) lb.textContent = cur.name;
    }
  }
  function deleteScript() {
    const now = Date.now();
    if (!delArmedAt || now - delArmedAt > 3000) {
      delArmedAt = now;
      const chip = $('tabs').querySelector('.tab.is-on');
      if (chip) {
        chip.classList.add('is-armed');
        const lb = chip.querySelector('.tab-label');
        if (lb) lb.textContent = L.confirmDel;
      }
      setTimeout(() => { if (delArmedAt && Date.now() - delArmedAt >= 2900) disarmDelete(); }, 3000);
      return;
    }
    delArmedAt = 0;
    const gone = curId;
    clearTimeout(saveTimer);
    saveDirtyId = '';
    delete texts[gone];
    scripts = scripts.filter((s) => s.id !== gone);
    sDel('s.' + gone);
    if (!scripts.length) {
      const id = newScriptId();
      scripts.push({ id, name: L.defaultName + ' 1' });
      texts[id] = '';
    }
    curId = scripts[0].id;
    $('script').value = texts[curId] != null ? texts[curId] : '';
    if (texts[curId] == null) {
      sGet('s.' + curId).then((r) => {
        if (r && r.ok && typeof r.value === 'string') {
          texts[curId] = r.value;
          $('script').value = r.value;
        }
      });
    }
    renderTabs();
    saveIdx(true);
    saveCfg();
  }

  async function restore() {
    if (!hasStorage) {
      // No grant: the library still works, just in-memory for this session.
      const id = newScriptId();
      scripts = [{ id, name: L.defaultName + ' 1' }];
      texts[id] = '';
      curId = id;
      renderTabs();
      return;
    }
    const cfg = await sGet('cfg');
    const c = cfg && cfg.ok && cfg.value && typeof cfg.value === 'object' ? cfg.value : {};
    const n = Number(c.speed);
    if (Number.isFinite(n) && n >= SPEED_MIN && n <= SPEED_MAX) setSpeed(n, true);
    setMirror(c.mirror === true, true);
    setIsland(c.island !== false, true);   // absent in older cfg blobs → on
    const idx = await sGet('idx');
    scripts = [];
    if (idx && idx.ok && Array.isArray(idx.value)) {
      for (const s of idx.value.slice(0, MAX_SCRIPTS)) {
        if (s && typeof s.id === 'string' && /^[A-Za-z0-9._-]{1,20}$/.test(s.id)) {
          scripts.push({ id: s.id, name: String(s.name == null ? '' : s.name).slice(0, 40) || L.defaultName });
        }
      }
    }
    if (!scripts.length) {
      // First run — seed the library (migrating the pre-library single-script
      // key if one exists).
      const legacy = await sGet('script');
      const t = legacy && legacy.ok && typeof legacy.value === 'string' ? legacy.value : '';
      const id = newScriptId();
      scripts = [{ id, name: L.defaultName + ' 1' }];
      texts[id] = t;
      curId = id;
      $('script').value = t;
      renderTabs();
      saveIdx(true);
      saveCfg();
      if (t) sSet('s.' + id, t);
      return;
    }
    curId = typeof c.cur === 'string' && scripts.some((s) => s.id === c.cur) ? c.cur : scripts[0].id;
    renderTabs();
    const r = await sGet('s.' + curId);
    if (r && r.ok && typeof r.value === 'string') {
      texts[curId] = r.value;
      $('script').value = r.value;
    }
  }

  // ── Island projection (granted via manifest island:true) ─────
  function pushIsland(text, next, badgeOverride) {
    if (!islandOn) text = '';   // muted → the island stays empty, whatever we're told
    next = text ? (next || '') : '';
    const badge = text
      ? (badgeOverride || speedLabel() + (playing && etaText ? ' · ' + etaText : ''))
      : '';
    if (text === lastIslandText && next === lastIslandNext && badge === lastIslandBadge) return;
    const now = Date.now();
    const wait = Math.max(0, ISLAND_THROTTLE_MS - (now - lastIslandAt));
    clearTimeout(islandTimer);
    islandTimer = setTimeout(() => {
      lastIslandAt = Date.now();
      lastIslandText = text;
      lastIslandNext = next;
      lastIslandBadge = badge;
      if (text) send({ type: 'island', op: 'show', text, next, badge });
      else send({ type: 'island', op: 'clear' });
    }, wait);
  }
  function rowText(i) {
    const kids = $('lines').children;
    return kids[i] ? kids[i].textContent.trim() : '';
  }
  // Re-project the current + next line (resume, speed change, ETA tick — the
  // island's meta column must refresh even mid-sentence).
  function pushCurrent() {
    if (!playing) return;
    const at = focusIdx >= 0 ? focusIdx : 0;
    const cur = rowText(at);
    if (cur) pushIsland(cur, rowText(at + 1));
  }

  // ── Play-mode build + measure ─────────────────────────────────
  function mkLine(text) {
    const div = document.createElement('div');
    div.className = 'line';
    // The script is the user's own text, but the rule stays the rule:
    // untrusted text renders via textContent, never innerHTML.
    div.textContent = text;
    return div;
  }
  function buildLines() {
    const box = $('lines');
    box.replaceChildren();
    const rows = $('script').value.split(/\r?\n/);
    for (const row of rows) {
      if (!row.trim()) { box.appendChild(mkLine(' ')); continue; }
      // Pull [pausa]/[2s] markers out of the prose, then split what remains
      // into sentences — a pasted paragraph arrives as ONE long row, and the
      // focus highlight should advance sentence by sentence.
      for (const piece of row.split(PAUSE_SPLIT_RE)) {
        const t = piece.trim();
        if (!t) continue;
        const m = t.match(PAUSE_TOKEN_RE);
        if (m) {
          const secs = Math.min(PAUSE_MAX_S, Math.max(PAUSE_MIN_S, m[1] ? parseFloat(m[1].replace(',', '.')) : PAUSE_DEFAULT_S));
          const div = mkLine('⏸ ' + (secs === Math.round(secs) ? String(secs) : secs.toFixed(1)) + 's');
          div.classList.add('is-pause');
          div.dataset.pause = String(secs);
          box.appendChild(div);
        } else {
          for (const part of t.split(SENTENCE_RE)) {
            if (part.trim()) box.appendChild(mkLine(part));
          }
        }
      }
    }
    measureLines();
  }
  function measureLines() {
    lineTops = Array.from($('lines').children, (el) => el.offsetTop);
    maxScroll = $('lines').scrollHeight || maxScroll;
    focusIdx = -1;
  }

  // Which line sits in the focus band (upper third of the stage)?
  function syncFocus() {
    stageH = $('stage').clientHeight || stageH;
    const band = stageH * 0.3;
    let idx = 0;
    for (let i = 0; i < lineTops.length; i++) {
      if (lineTops[i] - offset <= band) idx = i;
      else break;
    }
    if (idx === focusIdx) return;
    focusIdx = idx;
    const kids = $('lines').children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('is-focus', i === idx);
    // Reaching a [pausa] marker row auto-holds the scroll for its duration
    // (only while actually playing — a drag passing over it must not arm it).
    const row = kids[idx];
    if (playing && !dragging && row && row.dataset.pause) {
      holdUntil = performance.now() + Number(row.dataset.pause) * 1000;
    }
    pushCurrent();
  }

  // ── Time remaining: scroll distance ÷ rate + pending [pausa] holds ──
  function pxRate() {
    const fontPx = parseFloat(getComputedStyle($('lines')).fontSize) || 24;
    return BASE_PX_PER_S * (fontPx / 24) * speed;
  }
  function fmtTime(s) {
    s = Math.max(0, Math.round(s));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function updateEta(now) {
    if (now && now - lastEtaAt < 500) return;   // ~2 refreshes/s is plenty
    lastEtaAt = now || performance.now();
    const rate = pxRate();
    let secs = rate > 0 ? Math.max(0, maxScroll - offset) / rate : 0;
    const kids = $('lines').children;
    for (let i = Math.max(0, focusIdx) + 1; i < kids.length; i++) {
      const p = Number(kids[i].dataset.pause);
      if (p) secs += p;
    }
    if (playing && holdUntil) secs += Math.max(0, (holdUntil - lastEtaAt) / 1000);
    etaText = fmtTime(secs);
    $('etalbl').textContent = '≈ ' + etaText;
    if (playing) {
      // Deck keys bound to the `remaining` live value tick down in real time,
      // and the island's meta column carries the fresh countdown.
      send({ type: 'state', id: 'remaining', value: etaText });
      pushCurrent();
    }
  }

  // ── Scroll engine: transform only. rAF drives it while the tile is visible;
  // a slow heartbeat keeps it advancing when the tile is hidden (page switch —
  // rAF never fires in a display:none iframe) so Deck keys and the island stay
  // live. Layout reads fall back to cached values: a hidden iframe measures 0.
  function applyOffset() {
    $('lines').style.transform = 'translate3d(0,' + (-Math.round(offset * 10) / 10) + 'px,0)';
  }
  function advance(now) {
    const dt = lastTick ? now - lastTick : 0;
    lastTick = now;
    if (dt <= 0 || dragging) return;
    if (now < holdUntil) { updateEta(now); return; }   // [pausa] marker holding
    offset += (pxRate() * dt) / 1000;
    maxScroll = $('lines').scrollHeight || maxScroll;
    if (maxScroll > 0 && offset >= maxScroll) { offset = maxScroll; setPlaying(false); }
    applyOffset();
    syncFocus();
    updateEta(now);
  }
  function frame() {
    if (!playing) { rafId = 0; return; }
    advance(performance.now());
    rafId = requestAnimationFrame(frame);
  }
  function beat() {
    if (!playing) return;
    const now = performance.now();
    if (now - lastTick > 400) advance(now);   // rAF stalled (hidden tile) — step manually
  }

  function setPlaying(next) {
    next = !!next;
    if (playing === next) return;
    playing = next;
    $('toggle').textContent = playing ? '⏸' : '▶';
    // Deck keys bound to "Reflect a widget state" light up while playing.
    send({ type: 'state', id: 'playing', value: playing });
    if (playing) {
      lastTick = 0;
      if (!rafId) rafId = requestAnimationFrame(frame);
      if (!beatTimer) beatTimer = setInterval(beat, 500);
      // Resume re-projects the current line: focus hasn't changed, so
      // syncFocus alone would stay silent and the island would stay empty.
      pushCurrent();
      updateEta(0);
    } else {
      clearInterval(beatTimer);
      beatTimer = 0;
      holdUntil = 0;
      send({ type: 'state', id: 'remaining', value: etaText ? '⏸ ' + etaText : '' });
      pushIsland('');   // pause/stop/end → clear the island
    }
  }

  // ── 3-2-1 countdown into playback (fresh starts only; resume is instant) ──
  function startCountdown() {
    cancelCountdown();
    countLeft = COUNTDOWN_FROM;
    const el = $('count');
    el.hidden = false;
    const tick = () => {
      if (countLeft <= 0) {
        el.hidden = true;
        countTimer = 0;
        setPlaying(true);
        return;
      }
      el.textContent = String(countLeft);
      el.classList.remove('is-tick');
      void el.offsetWidth;   // restart the pop animation
      el.classList.add('is-tick');
      // The island counts down with the stage — first line already readable.
      const cur = rowText(focusIdx >= 0 ? focusIdx : 0);
      if (cur) pushIsland(cur, rowText((focusIdx >= 0 ? focusIdx : 0) + 1), countLeft + '…');
      countLeft--;
      countTimer = setTimeout(tick, COUNT_TICK_MS);
    };
    tick();
  }
  function cancelCountdown() {
    if (!countTimer) return;
    clearTimeout(countTimer);
    countTimer = 0;
    countLeft = 0;
    $('count').hidden = true;
    pushIsland('');
  }
  function togglePlay() {
    if (countTimer) { cancelCountdown(); return; }   // tap during countdown = abort
    if (playing) setPlaying(false);
    else if (offset <= 0.5) startCountdown();
    else setPlaying(true);
  }

  function speedLabel() {
    return speed.toFixed(speed === Math.round(speed) ? 1 : 2) + '×';
  }
  function setSpeed(next, fromRestore) {
    speed = Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(next * 100) / 100));
    $('speedlbl').textContent = speedLabel();
    // Deck keys bound to the `speed` live value show the rate in real time.
    send({ type: 'state', id: 'speed', value: speedLabel() });
    updateEta(0);
    pushCurrent();   // refresh the island's meta column mid-sentence
    if (!fromRestore) saveCfg();
  }

  // Mirror mode: flip the stage for beam-splitter teleprompter glass.
  function setMirror(next, fromRestore) {
    mirror = next === true;
    $('play').classList.toggle('mirror', mirror);
    $('mirrorbtn').classList.toggle('is-on', mirror);
    if (!fromRestore) saveCfg();
  }

  // Island line: on by default (it's the point of the widget), but some takes
  // read better with the top bar left alone — muting clears it immediately and
  // stops every further projection until it's back on.
  function setIsland(next, fromRestore) {
    islandOn = next !== false;
    $('islandbtn').classList.toggle('is-on', islandOn);
    $('islandbtn').setAttribute('aria-pressed', islandOn ? 'true' : 'false');
    if (islandOn) pushCurrent();
    else pushIsland('');
    if (!fromRestore) saveCfg();
  }

  function rewind() {
    offset = 0;
    lastTick = 0;
    holdUntil = 0;
    applyOffset();
    syncFocus();
    updateEta(0);
  }

  function enterPlay() {
    flushSave();
    disarmDelete();
    $('edit').hidden = true;
    $('play').hidden = false;
    buildLines();
    rewind();
    startCountdown();
  }
  function enterEdit() {
    cancelCountdown();
    setPlaying(false);
    $('play').hidden = true;
    $('edit').hidden = false;
  }

  // ── Drag to reposition: 1:1 with the finger, precise like a real prompter.
  // The engine keeps its playing state and simply holds while dragging.
  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;
    dragging = true;
    dragMoved = false;
    dragStartY = e.clientY;
    dragStartOffset = offset;
    if ($('stage').setPointerCapture) {
      try { $('stage').setPointerCapture(e.pointerId); } catch { /* mouse without pointerId */ }
    }
  }
  function onPointerMove(e) {
    if (!dragging) return;
    const dy = dragStartY - e.clientY;   // drag up = move forward
    if (!dragMoved && Math.abs(dy) < 7) return;
    dragMoved = true;
    if (countTimer) cancelCountdown();
    maxScroll = $('lines').scrollHeight || maxScroll;
    offset = Math.min(Math.max(0, dragStartOffset + dy), Math.max(0, maxScroll));
    holdUntil = 0;
    applyOffset();
    syncFocus();
    updateEta(0);
  }
  function onPointerUp() {
    if (!dragging) return;
    dragging = false;
    lastTick = 0;   // no time-jump when the engine resumes
    if (dragMoved) squelchClick = true;
  }

  // ── Deck handlers (manifest deck.handlers) ────────────────────
  // Always ack with the callId — the server parks the key press ~3s for it.
  function onHandler(m) {
    let ok = true;
    if (m.handler === 'play') {
      if ($('play').hidden) enterPlay();
      else togglePlay();
    } else if (m.handler === 'speed') {
      const dir = m.args && m.args.dir === 'slower' ? -1 : 1;
      setSpeed(speed + dir * SPEED_STEP);
    } else if (m.handler === 'reset') {
      rewind();
    } else {
      ok = false;
    }
    send({ type: 'handler_ack', callId: m.callId, ok });
  }

  // ── Bridge ────────────────────────────────────────────────────
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object' || m.xenonSdk !== 1) return;
    if (m.type === 'init') {
      applyTheme(m.theme);
      applyLang(m.lang);
      hasStorage = m.storage === true;
      restore();
      // Publish the initial rate so a bound Deck key isn't blank before the
      // first change (restore re-sends if a saved speed differs).
      send({ type: 'state', id: 'speed', value: speedLabel() });
    } else if (m.type === 'theme') {
      applyTheme(m.theme);
    } else if (m.type === 'size') {
      // Scale the prompter type with the real tile width so it reads the same
      // on the desktop browser and the Xeneon Edge.
      const scale = Math.max(0.7, Math.min(2.5, (m.width || 480) / 480));
      document.documentElement.style.setProperty('--prompter-scale', String(scale));
      if (!$('play').hidden) measureLines();
    } else if (m.type === 'handler') {
      onHandler(m);
    } else if (m.type === 'store_result') {
      const done = pendingStores.get(m.id);
      if (done) { pendingStores.delete(m.id); done(m); }
    }
  });

  // ── UI wiring ─────────────────────────────────────────────────
  $('start').addEventListener('click', enterPlay);
  $('back').addEventListener('click', enterEdit);
  $('toggle').addEventListener('click', togglePlay);
  $('faster').addEventListener('click', () => setSpeed(speed + SPEED_STEP));
  $('slower').addEventListener('click', () => setSpeed(speed - SPEED_STEP));
  $('rewind').addEventListener('click', rewind);
  $('mirrorbtn').addEventListener('click', () => setMirror(!mirror));
  $('islandbtn').addEventListener('click', () => setIsland(!islandOn));
  $('script').addEventListener('input', () => { disarmDelete(); scheduleSave(); });
  // Library chips: one delegated handler (chips re-render on every change).
  $('tabs').addEventListener('click', (e) => {
    if (e.target.closest('.tab-x')) { deleteScript(); return; }
    if (e.target.closest('.tab-add')) { disarmDelete(); addScript(); return; }
    const chip = e.target.closest('.tab');
    if (!chip || !chip.dataset.id) return;
    if (chip.dataset.id !== curId) { disarmDelete(); switchScript(chip.dataset.id); }
    else startRename(chip);
  });
  $('tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (e.target.classList && e.target.classList.contains('tab-edit')) return;
    const chip = e.target.closest ? e.target.closest('.tab') : null;
    if (chip) { e.preventDefault(); chip.click(); }
  });
  // Tap the stage to play/pause; drag it to reposition. A drag squelches the
  // tap so letting go never accidentally toggles playback.
  $('stage').addEventListener('pointerdown', onPointerDown);
  $('stage').addEventListener('pointermove', onPointerMove);
  $('stage').addEventListener('pointerup', onPointerUp);
  $('stage').addEventListener('pointercancel', onPointerUp);
  $('stage').addEventListener('click', () => {
    if (squelchClick) { squelchClick = false; return; }
    togglePlay();
  });

  send({ type: 'hello' });
})();
