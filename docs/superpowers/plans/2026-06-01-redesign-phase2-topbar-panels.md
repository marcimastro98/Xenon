# Redesign Fase 2 — Topbar Liquid Glass + Superficie Pannelli — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Dare alla topbar l'aspetto "liquid glass" e unificare la superficie dei pannelli (raggio tile + bordo/ombra coerenti), usando i materiali/token della Fase 1, sulla struttura DOM attuale. Passo a basso rischio che migliora coesione, gerarchia e premium-feel senza ristrutturare il layout.

**Architecture:** Solo CSS, additivo/mirato. La topbar diventa vetro **solo in modalità dashboard completa** (`body:not([data-panel])`), così le modalità embed `?panel=` restano intatte. I pannelli `.panel` ereditano il raggio tile e un bordo/ombra raffinati. Nessuna modifica a JS, markup o contratti.

**Tech Stack:** Vanilla CSS, token già definiti in `server/styles/global.css` (`--glass-*`, `--radius-tile`, `--radius-modal`, `--shadow-*`, `--space-*`).

**Riferimento spec:** `docs/superpowers/specs/2026-06-01-dashboard-redesign-liquid-glass-bento-design.md` (§4.3 Topbar, §3.1 materiali).

**Vincoli:**
- Le modalità embed (`?panel=mic|notes|media|system|audio`) NON devono cambiare aspetto in modo rotto.
- Lo schermo device è alto solo 720px: NON aumentare il padding verticale esterno (spazio prezioso). Il "respiro" si otterrà internamente nelle fasi successive.
- `prefers-reduced-transparency`: fallback opaco.

**Verifica:** nessun framework di test. Per ogni task: `git diff --check`, ispezione del diff, e verifica visiva dell'utente su `http://127.0.0.1:3030` (NON avviare il server dall'agente). Niente commit (l'utente li gestisce).

---

## File interessati

- **Modify:** `server/components/Topbar/Topbar.css` — append regola topbar in vetro liquido (scoping `body:not([data-panel])`).
- **Modify:** `server/styles/global.css` — regola `.panel`: `border-radius` → `var(--radius-tile)`, bordo/ombra raffinati.

---

## Task 1: Topbar in Liquid Glass (solo dashboard completa)

**Files:**
- Modify: `server/components/Topbar/Topbar.css`

- [ ] **Step 1: Append la regola topbar-glass**

In fondo a `server/components/Topbar/Topbar.css`, aggiungere:

```css

/* ── Liquid Glass topbar ──────────────────────────────────────
   Applies only in the full dashboard. Embed modes (?panel=…) keep
   their own compact topbar styling from breakpoints.css. */
body:not([data-panel]) .topbar {
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-modal);
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: inset 0 1px 1px var(--glass-highlight), var(--shadow-lg);
}

@media (prefers-reduced-transparency: reduce) {
  body:not([data-panel]) .topbar {
    background: rgba(14, 18, 22, 0.92);
    -webkit-backdrop-filter: none;
    backdrop-filter: none;
  }
}
```

Rationale: niente pseudo-`::after` sheen sulla topbar per mantenere il testo (orologio/data) perfettamente nitido; si usa solo l'highlight interno + bordo specular. Lo scoping `body:not([data-panel])` evita di toccare le topbar compatte/fisse delle modalità embed.

- [ ] **Step 2: Verifica statica**

Run: `git diff --check` → nessun output.
Rileggere il diff: la regola è in coda al file, usa solo token esistenti (`--space-2`, `--space-4`, `--glass-border`, `--radius-modal`, `--glass-bg`, `--glass-blur`, `--glass-saturate`, `--glass-highlight`, `--shadow-lg`), ed è scoping `body:not([data-panel])`.

- [ ] **Step 3: Niente commit** (l'utente gestisce i commit). Verifica visiva delegata all'utente: la topbar appare come una barra in vetro flottante, orologio/data/pulsanti leggibili; in `?panel=mic` la topbar resta compatta/trasparente come prima.

---

## Task 2: Superficie pannelli unificata (raggio tile + bordo/ombra)

**Files:**
- Modify: `server/styles/global.css`

- [ ] **Step 1: Aggiornare la regola `.panel`**

Trovare in `server/styles/global.css`:

```css
.panel {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius);
  background: var(--panel);
  box-shadow: inset 0 1px 0 rgba(255,255,255,var(--panel-highlight-alpha)), 0 12px 34px rgba(0,0,0,var(--panel-shadow-alpha));
}
```

Sostituire con:

```css
.panel {
  min-width: 0;
  min-height: 0;
  border: 1px solid var(--panel-border);
  border-radius: var(--radius-tile);
  background: var(--panel);
  box-shadow: inset 0 1px 0 rgba(255,255,255,var(--panel-highlight-alpha)), var(--shadow-lg);
}
```

Note: si mantiene lo sfondo `var(--panel)` (rispetta l'opacità utente `--panel-alpha`) e il bordo/inset-highlight esistenti. Cambiano solo: raggio `var(--radius)` → `var(--radius-tile)` (8px → 16px, look tile Apple) e l'ombra esterna passa al token `var(--shadow-lg)` (mantiene profondità coerente col resto del design system). L'inset highlight controllato dall'utente resta invariato.

- [ ] **Step 2: Verifica statica**

Run: `git diff --check` → nessun output.
Confermare che è stata cambiata SOLO la regola `.panel` (raggio + ombra), che `--radius` (8px legacy) resta definito per altri usi, e che nessun altro selettore è stato toccato.

- [ ] **Step 3: Niente commit.** Verifica visiva delegata all'utente: tutti i pannelli (media, mic, note, sistema) hanno angoli più morbidi (16px) e ombra coerente; nessuna regressione di layout; le viste compatte (`@media max-height:560px` che imposta `box-shadow:none`) restano corrette.

---

## Verifica finale della fase

- [ ] Dashboard completa su `http://127.0.0.1:3030/`: topbar in vetro, pannelli con angoli morbidi, nessun errore console.
- [ ] Embed: `?panel=mic`, `?panel=system`, `?panel=media` invariati/non rotti (topbar compatta come prima).
- [ ] `prefers-reduced-transparency`: la topbar diventa opaca leggibile.
- [ ] Editor layout (pulsante personalizza) ancora funzionante con i nuovi raggi.

La Fase 3 (ristrutturazione Bento: separare Audio/Agenda in widget propri, griglia 4 colonne, accent bar OLED interni, portrait) avrà il proprio piano.

---

## Self-review (autore del piano)

- **Copertura spec:** topbar liquid glass (§4.3) ✓; superficie pannelli verso il linguaggio tile/OLED (§3.1, §4) ✓. Accent bar interni e split strutturale esplicitamente rinviati a Fase 3 (scelta di sicurezza). 
- **Placeholder:** nessuno; CSS completo. ✓
- **Coerenza:** token usati tutti definiti in Fase 1 (`--glass-*`, `--radius-tile`, `--radius-modal`, `--shadow-lg`, `--space-2`, `--space-4`). ✓
- **Rischi:** embed modes protette da `body:not([data-panel])`; nessun aumento di padding verticale (device 720px); sfondo pannello e opacità utente preservati. ✓
