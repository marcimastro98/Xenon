# Redesign Fase 1 — Fondamenta del Design System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilire i token, la tipografia (Inter), i due materiali condivisi (Liquid Glass / Deep OLED) e i controlli base unificati, su cui tutte le fasi successive del redesign costruiranno.

**Architecture:** Approccio token-first. Si aggiornano i token globali in `server/styles/global.css`, si introducono due nuovi file CSS condivisi (`materials.css`, `components-base.css`) caricati presto nell'ordine, e si imposta Inter come font primario. Le classi materiali/controlli sono **additive**: definite qui, adottate dai componenti nelle fasi successive. Nessuna modifica a logica JS o contratti dati.

**Tech Stack:** Vanilla CSS (custom properties, `@property`, `backdrop-filter`, `color-mix` opzionale), Google Fonts (Inter), HTML statico servito da `server/server.js`. Nessun build step.

**Riferimento spec:** `docs/superpowers/specs/2026-06-01-dashboard-redesign-liquid-glass-bento-design.md` (§3 Sistema di design).

**Nota sulla verifica:** Il progetto non ha framework di test. La verifica per ogni task usa: `git diff --check` (whitespace/conflitti), `node --check` per i JS toccati (in questa fase nessuno), ispezione visiva nel browser su `http://127.0.0.1:3030` (server gestito dall'utente — **non avviarlo dall'agente**) e criteri di accettazione espliciti. Il server può essere già attivo; se non lo è, chiedere all'utente di avviarlo invece di farlo.

---

## File interessati

- **Modify:** `server/index.html` — `<head>`: aggiunta preconnect+font Inter, link a `materials.css` e `components-base.css`.
- **Modify:** `server/styles/global.css` — token colore/raggio/spazio/ombre aggiornati ed estesi; `font-family` body → Inter; cifre tabular sui dati.
- **Create:** `server/styles/materials.css` — classi `.material-glass` e `.material-oled` + barretta accento + utility.
- **Create:** `server/components/Base/components-base.css` — controlli base unificati (`.ui-btn`, `.ui-toggle`, `.ui-slider`, `.ui-segmented`, `.ui-chip`, focus ring).
- **Modify:** `CHANGELOG.md` — voce sotto sezione non rilasciata.

L'ordine di caricamento CSS sarà: `global.css` → `materials.css` → `components-base.css` → (componenti) → `breakpoints.css` (resta ultimo per override).

---

## Task 1: Caricare Inter e i nuovi CSS condivisi in `index.html`

**Files:**
- Modify: `server/index.html` (sezione `<head>`)

- [ ] **Step 1: Aggiungere preconnect + Inter e i link CSS condivisi**

Trovare nel `<head>` la riga:

```html
<!-- Global styles & design tokens -->
<link rel="stylesheet" href="styles/global.css">
```

Sostituirla con (preconnect + font prima di global, materials/base subito dopo global):

```html
<!-- Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">

<!-- Global styles & design tokens -->
<link rel="stylesheet" href="styles/global.css">

<!-- Shared materials & base controls (load before components) -->
<link rel="stylesheet" href="styles/materials.css">
<link rel="stylesheet" href="components/Base/components-base.css">
```

- [ ] **Step 2: Verifica statica**

Run: `git diff --check`
Expected: nessun output (nessun errore di whitespace).

Controllo manuale: i due file referenziati verranno creati nei Task 3 e 4; finché non esistono il browser darà 404 su quei due CSS ma la pagina resta funzionante. Procedere ai task successivi prima della verifica visiva.

- [ ] **Step 3: Commit**

```bash
git add server/index.html
git commit -m "redesign(foundations): load Inter font and shared CSS entrypoints"
```

> NOTA: eseguire i `git commit` di questo piano solo se l'utente ha dato il via libera ai commit. Il progetto richiede consenso esplicito per committare (vedi CLAUDE.md). Se non c'è consenso, completare gli step ma saltare il commit.

---

## Task 2: Estendere i token in `global.css` (colori, raggi, spazio, ombre)

**Files:**
- Modify: `server/styles/global.css` (blocco `:root`)

I nomi token esistenti (`--accent`, `--accent-rgb`, `--bg`, `--panel*`, `--text`, `--muted-text`, `--dim-text`, `--radius`, `--red/--cyan/--amber/--blue`) **vanno preservati** perché usati ovunque. Si aggiungono nuovi token e si aggiornano solo i valori sicuri.

- [ ] **Step 1: Aggiungere i nuovi token di scala**

Trovare in `server/styles/global.css` la riga finale del blocco `:root`:

```css
  --radius: 8px;
}
```

Sostituirla con:

```css
  /* legacy radius (kept for existing components) */
  --radius: 8px;

  /* ── Redesign tokens (Phase 1) ───────────────────────────── */
  /* Radii */
  --radius-control: 10px;
  --radius-tile: 16px;
  --radius-modal: 20px;

  /* Spacing scale (4 / 8 base) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.28);
  --shadow-md: 0 6px 18px rgba(0,0,0,0.30);
  --shadow-lg: 0 14px 38px rgba(0,0,0,0.38);
  --shadow-xl: 0 24px 60px rgba(0,0,0,0.48);

  /* Liquid Glass material */
  --glass-bg: linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.04));
  --glass-border: rgba(255,255,255,0.26);
  --glass-blur: 20px;
  --glass-saturate: 170%;
  --glass-highlight: rgba(255,255,255,0.45);
  --glass-sheen: linear-gradient(180deg, rgba(255,255,255,0.18), transparent 38%);

  /* Deep OLED material */
  --oled-bg-rgb: 8, 10, 12;
  --oled-border: rgba(255,255,255,0.07);
  --oled-accent-bar: 3px;

  /* Semantic aliases (map onto existing tokens) */
  --color-info: var(--cyan);
  --color-warn: var(--amber);
  --color-danger: var(--red);

  /* Motion */
  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-in: cubic-bezier(0.55, 0, 1, 0.45);
  --dur-fast: 160ms;
  --dur-mid: 240ms;
}
```

- [ ] **Step 2: Allineare la base BG al nuovo valore**

Trovare nel blocco `:root`:

```css
  --bg: #070808;
```

Sostituire con:

```css
  --bg: #06080A;
```

E nel blocco `@property --bg { ... initial-value: #070808; }` trovare:

```css
  initial-value: #070808;
```

Sostituire con:

```css
  initial-value: #06080A;
```

- [ ] **Step 3: Verifica statica**

Run: `git diff --check`
Expected: nessun output.

Controllo manuale: nessun nome token esistente è stato rimosso o rinominato (cercare che `--radius:` 8px sia ancora presente; `--accent`, `--panel`, `--text` invariati).

- [ ] **Step 4: Commit**

```bash
git add server/styles/global.css
git commit -m "redesign(foundations): add radius/space/shadow/material/motion tokens"
```

---

## Task 3: Creare `materials.css` (Liquid Glass + Deep OLED)

**Files:**
- Create: `server/styles/materials.css`

- [ ] **Step 1: Scrivere il file dei materiali**

Creare `server/styles/materials.css` con:

```css
/* ── Shared surface materials ─────────────────────────────────
   Two materials, one family:
   .material-glass  → floating elements (topbar, lock, modals, toasts)
   .material-oled   → data-dense panels (media, system, audio, notes…)
   Additive: applied by components in later redesign phases. */

/* Liquid Glass */
.material-glass {
  position: relative;
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-modal);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: inset 0 1px 1px var(--glass-highlight), var(--shadow-lg);
}

/* specular sheen on the top edge */
.material-glass::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--glass-sheen);
  pointer-events: none;
}

/* Deep OLED */
.material-oled {
  position: relative;
  background: rgba(var(--oled-bg-rgb), var(--panel-alpha));
  border: 1px solid var(--oled-border);
  border-radius: var(--radius-tile);
  box-shadow: var(--shadow-md);
}

/* category accent bar on OLED panels */
.material-oled[data-accent]::before {
  content: "";
  position: absolute;
  left: 0;
  top: var(--space-3);
  bottom: var(--space-3);
  width: var(--oled-accent-bar);
  border-radius: var(--oled-accent-bar);
  background: var(--accent);
}
.material-oled[data-accent="info"]::before { background: var(--color-info); }
.material-oled[data-accent="warn"]::before { background: var(--color-warn); }
.material-oled[data-accent="blue"]::before { background: var(--blue); }
.material-oled[data-accent="danger"]::before { background: var(--color-danger); }

/* Readability helper for content over user backgrounds */
body.has-user-bg .material-oled { text-shadow: var(--readability-shadow); }

/* Reduced transparency / motion fallbacks */
@media (prefers-reduced-transparency: reduce) {
  .material-glass {
    background: rgba(14, 18, 22, 0.92);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
  .material-glass::after { display: none; }
}
```

- [ ] **Step 2: Verifica statica**

Run: `git diff --check`
Expected: nessun output.

- [ ] **Step 3: Verifica visiva di smoke (sandbox)**

Creare un controllo temporaneo NON committato per vedere i materiali. Aprire `http://127.0.0.1:3030/?panel=mic` nel browser (embed esistente) e in DevTools console eseguire:

```js
document.querySelector('.mic-panel').classList.add('material-oled');
document.querySelector('.mic-panel').setAttribute('data-accent','info');
```

Expected: il pannello mic mostra bordo sottile, raggio 16px e barretta accento cyan a sinistra (le classi sono additive e sovrascrivono lo sfondo del pannello). Ricaricare per annullare. Questo conferma che `materials.css` è caricato e valido.

- [ ] **Step 4: Commit**

```bash
git add server/styles/materials.css
git commit -m "redesign(foundations): add shared glass and OLED surface materials"
```

---

## Task 4: Creare `components-base.css` (controlli base unificati)

**Files:**
- Create: `server/components/Base/components-base.css`

- [ ] **Step 1: Scrivere i controlli base**

Creare `server/components/Base/components-base.css` con:

```css
/* ── Unified base controls ────────────────────────────────────
   Shared control language. Additive: components migrate to these
   classes in later phases. Class prefix `ui-` to avoid clashes. */

:root {
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
}

/* Buttons */
.ui-btn {
  font: inherit;
  font-weight: 600;
  font-size: 13px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 9px 16px;
  border: 0;
  border-radius: var(--radius-control);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out),
              filter var(--dur-fast) var(--ease-out),
              transform var(--dur-fast) var(--ease-out);
}
.ui-btn:active { transform: scale(0.97); }
.ui-btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }

.ui-btn--primary { background: var(--accent); color: #04140a; }
.ui-btn--primary:hover { filter: brightness(1.08); }

.ui-btn--secondary {
  background: rgba(255,255,255,0.06);
  color: var(--text);
  border: 1px solid rgba(255,255,255,0.14);
}
.ui-btn--secondary:hover { background: rgba(255,255,255,0.12); }

.ui-btn--danger { background: var(--color-danger); color: #fff; }

/* Toggle (checkbox-driven) */
.ui-toggle { position: relative; display: inline-block; width: 42px; height: 24px; }
.ui-toggle input { position: absolute; opacity: 0; width: 100%; height: 100%; margin: 0; cursor: pointer; }
.ui-toggle .ui-toggle-track {
  position: absolute; inset: 0; border-radius: 99px;
  background: rgba(255,255,255,0.16);
  transition: background var(--dur-fast) var(--ease-out);
}
.ui-toggle .ui-toggle-track::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 20px; height: 20px; border-radius: 50%; background: #fff;
  transition: transform var(--dur-fast) var(--ease-out);
}
.ui-toggle input:checked + .ui-toggle-track { background: var(--accent); }
.ui-toggle input:checked + .ui-toggle-track::after { transform: translateX(18px); }
.ui-toggle input:focus-visible + .ui-toggle-track { box-shadow: var(--focus-ring); }

/* Range slider */
.ui-slider {
  -webkit-appearance: none; appearance: none;
  width: 100%; height: 6px; border-radius: 6px;
  background: rgba(255,255,255,0.14);
  cursor: pointer;
}
.ui-slider::-webkit-slider-thumb {
  -webkit-appearance: none; appearance: none;
  width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: var(--shadow-sm);
  border: 2px solid var(--accent);
}
.ui-slider::-moz-range-thumb {
  width: 16px; height: 16px; border-radius: 50%;
  background: #fff; border: 2px solid var(--accent);
}
.ui-slider:focus-visible { outline: none; box-shadow: var(--focus-ring); }

/* Segmented control */
.ui-segmented { display: inline-flex; gap: 2px; padding: 3px; border-radius: var(--radius-control); background: rgba(255,255,255,0.06); }
.ui-segmented button {
  font: inherit; font-size: 12px; font-weight: 600;
  padding: 6px 12px; border: 0; border-radius: 8px;
  background: transparent; color: var(--muted-text); cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.ui-segmented button[aria-selected="true"],
.ui-segmented button.active { background: rgba(255,255,255,0.12); color: var(--text); }
.ui-segmented button:focus-visible { outline: none; box-shadow: var(--focus-ring); }

/* Chip */
.ui-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 999px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
  font-size: 11.5px; font-weight: 600; color: var(--text); cursor: pointer;
}
.ui-chip.active { background: rgba(var(--accent-rgb),0.14); border-color: rgba(var(--accent-rgb),0.4); color: var(--accent); }

/* Respect reduced motion for all base controls */
@media (prefers-reduced-motion: reduce) {
  .ui-btn, .ui-toggle .ui-toggle-track, .ui-toggle .ui-toggle-track::after,
  .ui-segmented button { transition: none; }
}
```

- [ ] **Step 2: Verifica statica**

Run: `git diff --check`
Expected: nessun output.

- [ ] **Step 3: Verifica visiva di smoke**

Aprire `http://127.0.0.1:3030/` e in console:

```js
const b=document.createElement('button'); b.className='ui-btn ui-btn--primary'; b.textContent='Test';
document.body.appendChild(b); b.style.position='fixed'; b.style.top='60px'; b.style.left='20px'; b.style.zIndex=9999;
```

Expected: appare un bottone accent con raggio 10px, hover che schiarisce, focus ring visibile con Tab. Ricaricare per annullare.

- [ ] **Step 4: Commit**

```bash
git add server/components/Base/components-base.css
git commit -m "redesign(foundations): add unified base controls (ui-* classes)"
```

---

## Task 5: Applicare Inter e cifre tabular globalmente

**Files:**
- Modify: `server/styles/global.css` (regola `body` e regole numeriche)

- [ ] **Step 1: Impostare Inter come font primario**

Trovare in `server/styles/global.css`:

```css
  font-family: 'Segoe UI', 'Inter', system-ui, sans-serif;
```

Sostituire con:

```css
  font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
```

- [ ] **Step 2: Aggiungere utility cifre tabular**

In fondo a `server/styles/global.css` (dopo l'ultima regola, la transizione del tema), aggiungere:

```css
/* ── Tabular figures for data ────────────────────────────────
   Numbers in stats, volume, timers and the clock must not jitter. */
.clock-h, .clock-m,
.lock-time-h, .lock-time-m,
.stat-value, .bw-value, .stat-unit,
.vol-value, .mic-vol-value,
.weather-temp { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 3: Verifica statica**

Run: `git diff --check`
Expected: nessun output.

- [ ] **Step 4: Verifica visiva**

Aprire `http://127.0.0.1:3030/`. Expected:
- Il testo dell'intera dashboard usa Inter (confrontare il peso/forma delle lettere, p.es. la "a" e "g" a doppio occhiello sono diverse da Segoe UI).
- I valori numerici (orologio, CPU/GPU %, volume) hanno larghezza cifre costante (cambiando valore non "ballano").

- [ ] **Step 5: Commit**

```bash
git add server/styles/global.css
git commit -m "redesign(foundations): switch primary font to Inter, tabular figures for data"
```

---

## Task 6: Aggiornare il CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Aggiungere la voce**

Aprire `CHANGELOG.md`, individuare la sezione non rilasciata in cima (o crearla se assente, sopra l'ultima versione, nel formato già usato nel file). Aggiungere sotto di essa:

```markdown
### Aggiunto
- Fondamenta del nuovo design "Liquid Glass / Bento": font Inter, materiali condivisi (vetro liquido e OLED), controlli base unificati e token di colore/spazio/animazione. Prima fase del redesign completo dell'interfaccia; nessun cambiamento funzionale.
```

(Adattare i titoli di sezione — "Added/Aggiunto" — allo stile esistente del file.)

- [ ] **Step 2: Verifica**

Run: `git diff --check`
Expected: nessun output. Rileggere la voce: deve essere comprensibile a un utente finale.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): note redesign foundations"
```

---

## Verifica finale della fase

- [ ] **Smoke test completo:** Aprire `http://127.0.0.1:3030/` e verificare che la dashboard sia pienamente funzionante, senza errori 404 in console (i due nuovi CSS si caricano), font Inter attivo, cifre tabular sui dati. Nessun pannello rotto o regressione di layout (i materiali non sono ancora applicati ai componenti — è atteso che l'aspetto sia ancora quello attuale, salvo font e BG base).
- [ ] **Embed test:** Aprire `http://127.0.0.1:3030/?panel=mic` e `?panel=system` e confermare che caricano senza errori.
- [ ] **Reduced motion:** Con SO impostato su "riduci movimento", confermare che la pagina non introduce nuove animazioni.
- [ ] **Console pulita:** Nessun errore JS, nessun 404 CSS.

Al termine, la Fase 2 (Topbar + griglia Bento) avrà il proprio piano, che consumerà `material-glass`, `material-oled` e i controlli `ui-*` introdotti qui.

---

## Self-review (autore del piano)

- **Copertura spec §3:** token colore (Task 2), Inter + tabular (Task 5), due materiali (Task 3), componenti base (Task 4), forma/spazio/ombre (Task 2), animazioni/motion token + reduced-motion (Task 2/3/4). ✓
- **Placeholder:** nessun "TBD/TODO"; tutto il CSS è completo e incollabile. ✓
- **Coerenza nomi:** token usati nei file coincidono con quelli definiti in Task 2 (`--glass-*`, `--oled-*`, `--radius-*`, `--space-*`, `--shadow-*`, `--dur-*`, `--ease-*`, `--color-*`). Classi `.material-glass/.material-oled/.ui-*` coerenti tra Task 3/4 e i riferimenti nella verifica. ✓
- **Vincoli:** nessun token esistente rimosso/rinominato; nessuna modifica a JS/contratti; ordine di caricamento CSS con `breakpoints.css` ancora ultimo. ✓
