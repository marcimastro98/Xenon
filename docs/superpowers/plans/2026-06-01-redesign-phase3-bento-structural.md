# Redesign Fase 3 — Bento strutturale (split Audio + Agenda, griglia 4 colonne) — Implementation Plan

> Esecuzione **inline** (non subagent): cambiamento strutturale su 6 file interdipendenti + stato persistito. Verifica visiva dell'utente ai checkpoint di milestone.

**Goal:** Trasformare la dashboard nella griglia Bento: *Audio* e *Agenda (Calendario/Task/Timer)* diventano widget Bento autonomi (oggi sono, rispettivamente, un gruppo di card dentro Sistema e una vista-toggle dentro Media), su una griglia a 4 colonne, mantenendo funzionanti i layout salvati.

**Architecture:** Si estende il modello `dashboardLayout` (in `server/js/settings.js` E nel mirror `server/server.js`) con i widget `audio` e `agenda`. Il DOM sposta `#audio-block` e `#calendar-view` in nuove `section.dashboard-widget`. La logica `mediaView` (media↔calendar dentro il pannello Media) viene neutralizzata: Media mostra solo Now-Playing, Agenda è sempre il suo pannello. `showCalendar` diventa un no-op sicuro. Migrazione tollerante: i layout salvati guadagnano i nuovi widget ai default, niente errori.

**Tech Stack:** Vanilla JS/CSS, nessun build. Token/materiali dalle Fasi 1-2.

**Vincoli:** layout salvati non si rompono; embed `?panel=` invariati; device 720px (no padding verticale extra); i18n con `data-i18n` per ogni nuova label; normalizzazione speculare client+server.

**Verifica:** `node --check` sui JS toccati; `git diff --check`; verifica visiva utente su `127.0.0.1:3030` ad ogni milestone (l'agente NON avvia il server). Niente commit (gestiti dall'utente).

---

## Modello target (DEFAULT_DASHBOARD_LAYOUT)

`DASHBOARD_WIDGET_IDS`: `['media','mic','system','notes','tasks']` → `['media','agenda','mic','audio','system','notes','tasks']`.

Nuovi default `widgets` (4 col × 2 righe come base; l'utente può riordinare/ridimensionare):
```
media:  { order: 0, size: 'tall',   visible: true }
agenda: { order: 1, size: 'tall',   visible: true }
system: { order: 2, size: 'tall',   visible: true }
mic:    { order: 3, size: 'normal', visible: true }
audio:  { order: 4, size: 'normal', visible: true }
notes:  { order: 5, size: 'normal', visible: true }
tasks:  { order: 6, size: 'normal', visible: false }
```
`cards.audio` (volume/speaker/microphone) resta invariato: l'`#audio-block` con le sue card si limita a cambiare contenitore DOM. `mediaView` resta nello schema (normalizzato) ma non più applicato (retrocompat).

---

## Milestone A — Split Audio in widget autonomo

### Task A1 — Estendere il modello (client + server, speculari)
**Files:** `server/js/settings.js`, `server/server.js`

- [ ] In ENTRAMBI i file: `DASHBOARD_WIDGET_IDS` → aggiungere `'audio'` e `'agenda'`: `Object.freeze(['media','agenda','mic','audio','system','notes','tasks'])`.
- [ ] In ENTRAMBI: in `DEFAULT_DASHBOARD_LAYOUT.widgets` aggiungere le voci `agenda` e `audio` e impostare gli `order` come da "Modello target" sopra (media 0, agenda 1, system 2, mic 3, audio 4, notes 5, tasks 6).
- [ ] Verifica: `node --check server/server.js` e `node --check server/js/settings.js` → OK. Caricando la dashboard, nessun crash anche prima dello spostamento DOM (i `querySelector` dei widget mancanti restituiscono null → no-op in `applyDashboardWidgets`).

### Task A2 — Spostare l'Audio block in un widget
**Files:** `server/index.html`

- [ ] Creare una nuova `<aside class="panel audio-panel dashboard-widget" data-dashboard-widget="audio" data-dashboard-size="normal" data-dashboard-order="4" data-accent>` e spostarci dentro l'intero `#audio-block` (volume + righe dispositivi) attualmente dentro `.side-panel`.
- [ ] Rimuovere `#audio-block` dal `.side-panel` (che resta il widget "system" con solo `#system-block`).
- [ ] Mantenere TUTTI gli `id` interni (`vol-slider`, `spk-name`, `mic-name`, ecc.) e gli attributi `data-system-card-group="audio"` invariati → volume.js/picker.js continuano a funzionare.
- [ ] Aggiungere `data-accent="info"` al `.side-panel` (Sistema) per la barra accento cyan; `data-accent` (default) all'audio-panel.

### Task A3 — Verifiche e adattamenti
**Files:** `server/js/dashboard-layout.js` (controllo), CSS audio
- [ ] `applyDashboardCards` gestisce `audio-block` via `getElementById('audio-block')` → continua a funzionare ovunque sia nel DOM. Confermare.
- [ ] `AudioSection.css` / `DashboardLayout.css`: assicurare che `.audio-panel` come `.panel` renda bene (padding, niente regressioni). Aggiungere padding-left se la barra accento confligge col contenuto (in genere il padding del pannello basta).
- [ ] Embed `?panel=audio`: oggi `body[data-panel="audio"]` nasconde `#system-block` e mostra l'audio. Aggiornare i selettori embed in `breakpoints.css` se necessario perché l'audio ora è in `.audio-panel` e non più in `.side-panel`.
- [ ] **CHECKPOINT VISIVO UTENTE**: Audio appare come tile separata; Sistema senza audio; embed audio/system ok; layout salvati non in errore.

---

## Milestone B — Split Agenda (Calendario/Task/Timer) in widget autonomo

### Task B1 — Spostare la calendar-view in un widget
**Files:** `server/index.html`
- [ ] Creare `<section class="panel agenda-panel dashboard-widget" data-dashboard-widget="agenda" data-dashboard-size="tall" data-dashboard-order="1" data-accent="blue">` e spostarci dentro l'intero `#calendar-view` (tabs cal/task/timer + pane) oggi dentro `.media-panel`.
- [ ] `.media-panel` resta widget "media" con solo Now-Playing (rimuovere il bottone "Calendario" di toggle e la `media-header` di switch se diventano ridondanti; mantenere però i pulsanti media).
- [ ] Mantenere tutti gli `id` (`calendar-view`, `calendar-days`, `cal-pane-*`, ecc.) invariati.

### Task B2 — Neutralizzare mediaView e ricablare
**Files:** `server/js/media.js`, `server/js/dashboard-layout.js`
- [ ] `media.js`: `showCalendar()` → no-op sicuro (o rimuovere la logica di `calendar-mode` sul media-panel) dato che Agenda è ora un pannello sempre presente. Mantenere la funzione esportata per non rompere chiamanti.
- [ ] `dashboard-layout.js`: rimuovere la chiamata `applyDashboardMediaView(layout)` da `applyDashboardLayout` (o renderla no-op). `getDashboardMediaView/persistDashboardMediaView` restano inerti.
- [ ] `tasks.js`: confermare che `syncTasksWidgetPlacement` funzioni con la calendar-view nel nuovo pannello (sposta i task tra tab agenda e widget tasks standalone). Adattare i selettori se puntano al media-panel.
- [ ] La `calendar-mini-player` dentro la calendar-view (mini Now-Playing) diventa ridondante (Media è separato) → nasconderla di default nel pannello agenda.
- [ ] Verifica: `node --check` sui 3 file. **CHECKPOINT VISIVO UTENTE**: Agenda tile con tab Cal/Task/Timer funzionanti; Media mostra solo Now-Playing; reminder/eventi/timer ok; layout salvati ok.

---

## Milestone C — Griglia 4 colonne + accent bar + responsive/portrait

### Task C1 — Griglia Bento a 4 colonne
**Files:** `server/styles/global.css`, `server/components/DashboardLayout/DashboardLayout.css`
- [ ] `.dashboard` `grid-template-columns`: da 3 colonne fisse a 4 colonne fluide, es. `repeat(4, minmax(0, 1fr))` (rimuovere le minmax specifiche a 3 colonne in global.css).
- [ ] Mantenere `grid-auto-flow: dense` e `grid-template-rows: repeat(2, minmax(0,1fr))` + `grid-auto-rows`.
- [ ] Verificare che i token size (`tall`/`normal`/`wide`/`large`/`full`) producano la composizione attesa con 7 widget.

### Task C2 — Accent bar OLED sui widget
**Files:** `server/styles/materials.css` o `DashboardLayout.css`
- [ ] Aggiungere regola `.dashboard-widget[data-accent]::before` (barra 3px, come `.material-oled[data-accent]`) anchored sul widget (già `position:relative`). Varianti info/blue/warn/danger.
- [ ] `data-accent` già messi in A2/B1; aggiungere a media (default), mic (default), notes ("warn").
- [ ] Garantire che la barra non si sovrapponga al contenuto (padding sinistro dei pannelli sufficiente; altrimenti aggiungere `padding-left`).

### Task C3 — Responsive + portrait
**Files:** `server/styles/breakpoints.css`
- [ ] Aggiornare i breakpoint: 4 col → 2 col (≤1120px) → 1 col (≤720px), come oggi ma per 7 widget.
- [ ] Portrait (orientation: portrait / larghezza < altezza): 1-2 colonne impilate; `tall`→altezza naturale.
- [ ] Verificare nessuno scroll orizzontale; embed modes intatti.
- [ ] **CHECKPOINT VISIVO UTENTE**: Bento 4 colonne in landscape, impilato in portrait, accent bar visibili, tutto leggibile.

---

## Self-review (autore)
- **Copertura:** split Audio (A), split Agenda (B), griglia+accent+responsive (C) → realizza il Bento approvato. ✓
- **Retrocompat:** normalizzatore tollerante + nuovi widget con default + `mediaView` mantenuto inerte → layout salvati non si rompono. ✓
- **Speculare client/server:** A1 aggiorna sia settings.js sia server.js. ✓
- **Rischi:** ricablaggio `showCalendar`/`syncTasksWidgetPlacement` (B) è il punto più delicato → milestone isolata con checkpoint visivo prima di C. Embed `?panel=audio` da aggiornare (A3). ✓
