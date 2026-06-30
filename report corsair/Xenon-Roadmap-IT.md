# Xenon — Roadmap dei Widget Nativi

*Marcello Mastroeni · per CORSAIR / iCUE · giugno 2026*

Xenon è una dashboard all-in-one per il Xeneon Edge — monitoraggio di sistema, media, audio, AI, RGB, una griglia di tasti stile Stream Deck e altro, tutto in locale. È un prodotto reale e già rilasciato, con utenti attivi oggi (companion web sull'Edge), non un concept. L'obiettivo è portarla sul Marketplace come widget iCUE nativi, così che il giorno dell'apertura il Marketplace abbia già dentro una dashboard completa e collaudata — dando ai proprietari dell'Edge un motivo in più per acquistarlo, e al Marketplace un prodotto di punta con cui lanciarsi.

**L'idea portante: la fattibilità nativa di una funzione è la sua posizione nella roadmap.** Alcuni widget possono uscire il giorno stesso dell'apertura del Marketplace senza modifiche all'SDK; altri richiedono prima capacità SDK specifiche. Il rollout qui sotto è ordinato per ciò che la piattaforma può fare — una mappa condivisa, per il tuo team e per me, di chi costruisce cosa e quando.

---

## Il rollout

**Fase 1 — Lancio del Marketplace. Nessuna modifica SDK necessaria; escono il giorno uno.**

| Widget | Diventa nativo con |
|---|---|
| Monitor di sistema (CPU/GPU/RAM, temperature, carico) | Plugin Sensori *(disponibile oggi)* |
| FPS in gioco | Plugin Sensori, tipo di sensore `fps` *(disponibile oggi)* |
| Orologio / barra superiore | UI integrata |
| Timer · Task · Note | UI integrata *(nota sull'archiviazione sotto)* |
| Temi e impostazioni | Sistema di impostazioni integrato |

*Cosa significa "fatto":* questi tile sono live sul Marketplace il giorno del lancio. *Dalla mia parte:* li impacchetto e li invio, con temi completi e tutte e cinque le lingue, in tempo per il lancio.

*Timer, Task e Note si renderizzano nativamente al lancio; l'archiviazione affidabile con backup (quella che hanno oggi) richiede l'accesso ai file locali, quindi arriva col Companion Bridge (Fase 4) — una versione al lancio userebbe il localStorage, limitato nello spazio e con possibile perdita di dati.*

**Fasi 2–4 — dipendono da capacità SDK. Ogni riga diventa nativa quando CORSAIR rilascia la capacità nella colonna centrale; fino ad allora resta nel companion web.**

| Widget | Cosa deve rilasciare prima CORSAIR | Priorità |
|---|---|---|
| Media (copertina, posizione, sorgente) | Plugin Media più ricco | Fase 2 |
| Meteo | Plugin Network/HTTP | Fase 2 |
| Sync calendario · Focus lock screen | Plugin Network/HTTP | Fase 2 |
| Microfono · Mixer audio/volume | Plugin Audio | Fase 3 |
| Deck · App switcher · Controlli Performance | Plugin System/Action | Fase 3 |
| Xenon AI · Illuminazione RGB · Streaming · Controllo remoto · Browser · Second screen | Local Companion Bridge | Fase 4 |

- *Fase 2 fatta:* Media, Meteo, sync calendario e Focus lock screen girano come tile nativi. *Dalla mia parte:* costruisco ogni widget sui plugin Network/HTTP e Media man mano che arrivano.
- *Fase 3 fatta:* Microfono, mixer audio/volume, Deck, app switcher e controlli Performance girano nativamente. *Dalla mia parte:* li costruisco sui plugin Audio e System/Action man mano che arrivano.
- *Fase 4 fatta:* le funzioni di punta — AI, RGB, streaming, remoto, browser, second screen — girano nativamente tramite il bridge. *Dalla mia parte:* costruisco il lato companion e i widget sul modello di permessi del bridge.

Le fasi sono un ordine di priorità suggerito — prima le capacità più utili in generale — non un calendario; il ritmo è dato da quando ogni capacità viene rilasciata agli sviluppatori.

---

## Cosa può sbloccare CORSAIR

| Aggiunta SDK | Sblocca | Fase |
|---|---|---|
| **Plugin Media più ricco** — copertina, posizione/durata, seek, sorgente | Widget Media completo | 2 |
| **Plugin Network/HTTP** — su allowlist, domini autorizzati dall'utente | Meteo, sync calendario, lock screen | 2 |
| **Plugin Audio** — mute/livello mic, lista dispositivi, volume per-app | Microfono, mixer audio | 3 |
| **Plugin System/Action** — avvia app, focus finestra, esegui azione su allowlist | Deck, app switcher, controlli performance | 3 |
| **Local Companion Bridge** — canale sancito widget↔processo-locale con un vero modello di permessi (consenso, capacità dichiarate, firma, allowlist) | AI, RGB, streaming, remoto, browser, second screen | 4 |
| **Modernizzazione del runtime** — accettare sintassi JavaScript moderna | Sviluppo più fluido per ogni creator del Marketplace | — |
| **Documentazione con esempi end-to-end** — percorsi completi impostazioni-a-render | Onboarding più rapido per ogni creator del Marketplace | — |

Il Companion Bridge è l'elemento ad alta leva: è l'unica aggiunta che rende possibile l'intera colonna della Fase 4. Abbinarlo ai plugin mirati qui sopra mantiene i widget semplici zero-install mentre quelli potenti aderiscono al bridge.

---

## Storia di lancio e prossimo passo

Xenon potrebbe essere una bella storia da maker per il lancio del Marketplace — una dashboard reale e completa costruita sull'Edge, che strada facendo ha mappato esattamente le lacune dell'SDK che il tuo team sta ora valutando. Fornirei volentieri materiale per portfolio, articolo e intervista, e farei da early SDK tester e partner di feedback mentre i plugin qui sopra prendono forma.

**Prossimo passo immediato:** una breve call questa settimana con chi gestisce l'SDK, per mettere alla prova questa lista e sequenziarla con le priorità del tuo team — così che i tile della Fase 1 possano già iniziare la strada verso il Marketplace.
