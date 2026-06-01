# XenonEdge Hub — Redesign "Liquid Glass / Bento" — Design Spec

**Data:** 2026-06-01
**Area:** `server/` (server/web widget di produzione)
**Versione proposta:** v2.1.0 (miglioramento UX significativo, nessuna rottura di contratti settings/API)
**Stato:** Design approvato in brainstorming — in attesa di review finale prima del piano di implementazione

---

## 1. Obiettivo

Ridisegnare completamente l'interfaccia del web widget XenonEdge Hub mantenendo **tutte** le informazioni e funzionalità attuali, ma riorganizzandole con un linguaggio visivo unico, minimale e premium ispirato ad Apple / "Liquid Glass".

Il redesign risolve quattro problemi identificati nell'attuale UI:

1. **Densità eccessiva** — troppe informazioni ravvicinate, poco respiro.
2. **Stile poco coeso** — i componenti hanno look leggermente diversi.
3. **Gerarchia poco chiara** — tutto ha lo stesso peso visivo.
4. **Leggibilità/contrasto** — testi piccoli, difficili su sfondo personalizzato.

### Non-obiettivi (YAGNI)

- Nessun React / Framer Motion / build step. Il widget resta vanilla JS servito da `server/server.js`.
- Nessuna modifica ai contratti dei dati server (endpoint, SSE, storage keys).
- Nessuna riscrittura della logica funzionale (mic, media, sistema, AI, ecc.): si tocca **presentazione e layout**, non il comportamento.
- Nessun nuovo drag-and-drop builder (resta nel roadmap): si restyla il sistema di personalizzazione esistente.

---

## 2. Vincoli da preservare

- **Sistema di personalizzazione layout**: attributi `data-dashboard-size` (`compact·normal·wide·tall·large·full`), `data-dashboard-order`, `data-dashboard-hidden`, e gli equivalenti `data-system-card-*` / `data-system-tab-*`. **I layout già salvati dagli utenti devono continuare a funzionare.**
- **Install per-componente via iframe**: le modalità embed `?panel=mic|notes|media|system|audio` restano funzionanti e vengono restilizzate.
- **Persistenza**: settings client sotto `xeneonedge.settings.v1`, sync via `/settings`. Nessun cambio di chiave/schema; eventuali nuovi campi con default e normalizzazione lato client+server.
- **SSE**: `GET /sse` e gli eventi `status·media·system·audio` invariati.
- **i18n**: tutte le stringhe restano con `data-i18n*` (EN/IT/KO/JA/ZH). Nessuna stringa hardcoded nuova senza chiave.
- **Sfondo personalizzato** (immagine/GIF/video fino a 200MB) e i controlli opacità/dim/blur restano e diventano parte integrante dell'estetica vetro.

---

## 3. Sistema di design (fondamenta)

### 3.1 Due materiali, una famiglia

Il design usa **due materiali** con un linguaggio coerente:

- **Liquid Glass** → elementi flottanti sopra lo sfondo: topbar, lock screen, tutte le modali (meteo, impostazioni, AI, picker dispositivi, app switcher, tab switcher), toast, dock della modalità modifica.
  - `background: linear-gradient(135deg, rgba(255,255,255,.15), rgba(255,255,255,.04))`
  - `border: 1px solid rgba(255,255,255,.26)` (bordo "specular")
  - `backdrop-filter: blur(20px) saturate(170%)`
  - highlight interno superiore + ombra esterna morbida
  - overlay `::after` con gradiente bianco→trasparente al 38% (riflesso vetro)
- **Deep OLED** → pannelli dati densi: media, sistema, audio, note, task, timer, calendario, dettaglio meteo interno.
  - `background: rgba(8,10,12,.92)` (segue `--panel-alpha` utente)
  - `border: 1px solid rgba(255,255,255,.07)`
  - **barretta accento** verticale a sinistra (3px, colore per-categoria) come segno distintivo e ancora di gerarchia.

Su sfondo personalizzato i pannelli OLED mantengono leggibilità (quasi opachi) mentre i flottanti lasciano passare lo sfondo (vetro).

### 3.2 Token colore

| Ruolo | Valore | Note |
|------|--------|------|
| Base BG | `#06080A` | dietro tutto (oggi `#070808`) |
| Panel OLED | `#0B0E13` | superfici dati |
| Glass | bianco translucido | flottanti |
| Accent | a tema, default verde Xenon `#1ED760` | preset + hex personalizzato **mantenuti** |
| Danger | `#E5484D` | |
| Warn | `#F0B84F` | temperature, GPU |
| Info | `#46C7E8` | sistema, rete |
| Text | `#F0F3F1` / muted `#A6B1AD` / dim `#7F8A86` | |

Si mantengono `@property --accent`/`--bg` e la transizione animata del tema. Si mantengono i 5 preset (Xenon, Ocean, Ember, Violet, Mono) e la personalizzazione hex.

**Barrette accento per categoria** (suggerite): Media = accent, Sistema = info `#46C7E8`, Agenda = blue `#6AA7FF`, Note = warn `#F0B84F`, Audio/Mic = accent. Configurabile, default coerente.

### 3.3 Tipografia — Inter

- Sostituisce `Segoe UI` come font primario (fallback `system-ui`).
- Import Google Fonts con `display=swap` (pesi 400–800), oppure self-host per offline-safety (da decidere in impl).
- **Cifre tabular** (`font-variant-numeric: tabular-nums`) su tutti i dati numerici (stat, volume, timer, orologio) per evitare "ballo" delle cifre.
- Scala: display 32px / title 20px / number 24–26px / body 14px / label 10px uppercase.

### 3.4 Forma e spazio

- Raggi più morbidi: tile `16px`, modali `18–22px`, controlli `10–12px` (oggi `8px`).
- Scala spaziatura 4/8px.
- Ombre su scala consistente (sm/md/lg/xl).

### 3.5 Componenti base unificati

Bottoni (primary accent / secondary glass-outline), toggle, slider (track + thumb), segmented control, chip, custom-select, time-picker: un unico set di stili condiviso. Tutti con `cursor:pointer`, stati hover/active/focus visibili (focus ring 2px accent), transizioni 150–250ms.

### 3.6 Animazioni

- **Solo native**: CSS `@keyframes`, transizioni, e Web Animations API dove serve controllo.
- Solo `transform`/`opacity` (GPU). Niente animazioni di `width/height/top/left`.
- `will-change` sugli elementi con animazioni continue (già pattern del progetto).
- `document.startViewTransition()` per show/hide/reorder tile (già presente) con fallback.
- Entrata tile a cascata (stagger 30–50ms), uscita più rapida dell'entrata.
- **`prefers-reduced-motion`**: rispettato ovunque — animazioni decorative disattivate/ridotte.

---

## 4. Dashboard Bento

### 4.1 Griglia

- Landscape (32:9): griglia **4 colonne × 2 righe** di default (oggi 3×2), `grid-auto-flow: dense`.
- Le tile usano i token dimensione esistenti: `normal` (1×1), `wide` (2×1), `tall` (1×2), `large` (2×2), `full`.
- Portrait (720×2560): la **stessa** griglia collassa a 1–2 colonne con `grid-auto-rows`; le tile `wide/large/full` diventano full-width, le `tall` tornano a altezza naturale. Nessun layout separato da mantenere — si gestisce con media/container query sull'orientamento.
- Browser desktop: breakpoint coerenti (≥1440 / 1024 / 768 / 375) — la griglia si riduce di colonne progressivamente; nessuno scroll orizzontale.

### 4.2 Disposizione di default (landscape)

| Tile | Dimensione | Contenuto |
|------|-----------|-----------|
| **Media** | tall (col 1) | album art, titolo/artista, controlli, sorgente media |
| **Microfono** | normal (col 2, r1) | mute circolare grande, stato, sensibilità |
| **Audio** | normal (col 2, r2) | volume + mute + righe dispositivi (speaker/mic) |
| **Sistema** | tall (col 3) | CPU/GPU/RAM/Disco con barre + temp; tab "Rete & Gaming"; uptime |
| **Agenda** | tall (col 4) | tab Calendario / Task / Timer / **Note** |

- **Note** entra come tab dentro "Agenda" per liberare spazio; resta estraibile come tile singola via personalizzazione (e via `?panel=notes`).
- **Meteo**: non è tile di default; vive nella pill della topbar (tap → modale) e nei widget del lock screen.

### 4.3 Topbar (Liquid Glass)

Barra flottante a tutta larghezza in vetro liquido:
- Sinistra: quick actions (blocca schermo, tab switcher, lock-screen widget).
- Centro: orologio grande + data + **pill meteo** (icona animata + temp + luogo).
- Destra: Xenon AI, modalità modifica layout, impostazioni, app switcher + preferiti.
- In embed mode resta la versione compatta esistente.

### 4.4 Modalità modifica (personalizzazione)

- Restyling in vetro liquido del dock e dei controlli per-tile.
- Controlli: ridimensiona (ciclo tra i token), trascina/riordina, nascondi, reset.
- Outline tratteggiato accent sulle tile in edit (già presente), ripulito.
- Stesso data-model → retrocompatibilità piena.

---

## 5. Superfici flottanti

### 5.1 Lock screen (focus)

- Overlay vetro liquido full-screen sopra lo sfondo.
- **Orologio gigante** + data a sinistra (animazione tick al secondo via rAF, già presente).
- Colonna di **widget in vetro**: meteo (icona animata + percepita/umidità/vento), now playing (cover + controlli), prossimi eventi.
- Widget attivabili/disattivabili da Impostazioni (toggle esistenti: clock/weather/media/calendar).
- Pulsante uscita in alto a destra.
- Portrait: widget impilati sotto l'orologio.

### 5.2 Meteo — "bellissima app meteo"

- Modale immersiva con **hero card a cielo dinamico** che cambia con ora del giorno + condizione (gradienti sole/luna/temporale/notte).
- **Icone meteo SVG animate** per ogni condizione: sereno giorno/notte, nuvoloso, pioggia, temporale, vento, neve, nebbia. Set tipo **Meteocons** (open source) o SVG custom; animazioni native.
- Effetti scena animati (sole che ruota/pulsa, nuvole che scorrono, gocce/fiocchi che cadono, lampo, banchi di nebbia) — prototipati e validati in CSS.
- Contenuto: hero (luogo, temp, condizione, max/min, aggiornamento), chip metriche (percepita/vento/pioggia/umidità), **timeline oraria** (prossime 8h), **previsione 3 giorni**, griglia metriche.
- Riusa la logica meteo esistente (auto/manuale, città) e le animazioni `weather-viz` già presenti, elevandole.
- `prefers-reduced-motion`: scene statiche con sola icona.

### 5.3 Impostazioni — sidebar a categorie

- Da un singolo scroll lungo a **modale con sidebar** di categorie:
  `Aspetto` (preset, accento, sfondo base, testo, opacità/dim/blur) · `Lock screen` (toggle widget) · `Meteo` (auto/manuale, città) · `Xenon AI` (key, TTS, sensibilità, guida) · `Sfondo` (upload media) · `Lingua`.
- Anteprima live mantenuta.
- Portrait / schermi stretti: la sidebar diventa una fila di tab orizzontali in alto.
- Tutti i controlli e le stringhe i18n esistenti preservati, solo riorganizzati.

---

## 6. Componenti restanti (stesso linguaggio)

Tutti adottano materiale + token + tipografia + animazioni del design system:

- **MediaPanel**: art più grande, gerarchia titolo/artista, controlli unificati; vista calendario/task/timer integrata come tab "Agenda".
- **MicPanel**: pulsante mute circolare focale, ring/glow animati ricondotti al nuovo accent, slider sensibilità unificato.
- **AudioSection**: volume con track unificato, righe dispositivo come list-item glass-on-OLED, picker invariato nel comportamento.
- **SystemPanel**: stat-box come righe compatte con barra+valore tabular+temp; tab Sistema/Rete; card net (ping/fps/latency/bandwidth) coerenti.
- **TasksPanel / TimerPanel / CalendarView / DayModal / EventToast**: controlli, liste e form ristilizzati; toast in vetro liquido con progress accent.
- **DevicePicker / AppSwitcher / TabSwitcher**: modali in vetro liquido, list-item coerenti, icone SVG.
- **AIPanel (Xenon AI)**: shell della modale in vetro liquido; la **resonance orb** mantiene la sua identità tech/plasma e gli stati listen/think/speak (no look glossy, moto lineare fluido); FAB voce e siri-ring ricondotti al nuovo accent. Solo restyling del contenitore e armonizzazione colori — nessuna modifica al comportamento voce/funzioni.
- **CustomSelect / time-picker**: dropdown coerenti col set base.
- **Embed modes** (`?panel=…`): ogni pannello a tutto schermo eredita il nuovo stile; breakpoint compatti aggiornati.

### Icone

- Set icone SVG coerente (stroke uniforme), niente emoji come icone strutturali nell'UI finale (le emoji nei mockup del companion sono solo placeholder).

---

## 7. Architettura implementativa

- Si lavora dentro la struttura esistente: `server/styles/global.css` (token), `server/styles/breakpoints.css` (orientamento/responsive), e i CSS per-componente in `server/components/<Nome>/<Nome>.css`.
- **Approccio token-first**: prima si aggiornano i token globali e i materiali condivisi, poi i singoli componenti ereditano. Questo massimizza la coesione e riduce il rischio.
- Markup HTML in `server/index.html`: modifiche mirate dove serve la nuova struttura (es. Note come tab in Agenda, sidebar Impostazioni), preservando tutti gli `id`, gli hook `onclick`/`data-i18n` e i data-attribute di layout.
- JS: modifiche minime e mirate (es. gestione tab "Agenda" con Note, sidebar settings, montaggio icone meteo animate). Nessun cambio ai moduli di logica/dati.
- Nuovo file CSS opzionale `server/styles/materials.css` per i due materiali condivisi (glass/OLED), caricato presto nell'ordine.

### Fasi suggerite (per il piano di implementazione)

1. **Fondamenta**: token colore, Inter, materiali glass/OLED, componenti base, raggi/spaziatura.
2. **Topbar + griglia Bento** (landscape) + retro-compatibilità layout.
3. **Pannelli dati** (Media, Sistema, Audio, Mic) in OLED.
4. **Agenda** (Calendario/Task/Timer/Note a tab).
5. **Lock screen** in vetro liquido.
6. **Meteo** app animata + icone SVG.
7. **Impostazioni** con sidebar.
8. **Modali restanti** (AI shell, picker, app/tab switcher, toast).
9. **Portrait + responsive + embed modes**.
10. **Modalità modifica** restyling.
11. **Pass finale**: reduced-motion, contrasto/leggibilità, validazione.

---

## 8. Criteri di successo

- Tutte le informazioni e funzioni attuali presenti e raggiungibili.
- Layout/settings salvati dagli utenti continuano a funzionare senza migrazione manuale.
- Linguaggio visivo coeso su tutte le superfici.
- Gerarchia chiara: un punto focale per tile, dati leggibili a colpo d'occhio.
- Contrasto AA (≥4.5:1) per il testo, anche su sfondo personalizzato.
- Funziona in landscape 32:9, portrait 720×2560 e finestre browser standard, senza scroll orizzontale.
- 60fps sulle animazioni; rispetto di `prefers-reduced-motion`.
- Embed `?panel=` funzionanti e ristilizzati.

## 9. Validazione

```powershell
git diff --check
node --check server/server.js
node --check server/js/<file-modificati>.js
```
Più ispezione responsive (375 / 768 / 1024 / 1440 e portrait) e verifica overflow/contrasto. `CHANGELOG.md` aggiornato sotto la sezione non rilasciata. Bump versione a v2.1.0 in `package.json` (da confermare).

---

## 10. Rischi e mitigazioni

- **`backdrop-filter` su molte superfici** → costo GPU. Mitigazione: vetro solo sui flottanti (pochi, non sui pannelli dati densi); `will-change` mirato; test sul device.
- **Leggibilità del vetro su sfondi chiari** → bordo specular + ombra + dim sfondo controllabile dall'utente.
- **Regressioni nel sistema di personalizzazione** → mantenere identici i data-attribute e testare i layout salvati.
- **Scope ampio (~20 componenti)** → implementazione fasata e token-first; ogni fase validabile in isolamento.
