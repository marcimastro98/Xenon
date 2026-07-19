# Provare annunci, sondaggi e modali in locale

Tutto quello che sta qui si fa dalla **console del browser** con la dashboard aperta
(`http://127.0.0.1:3030`, tasto destro → Ispeziona → Console). Non serve la console admin,
non serve pubblicare niente sul sito, non serve internet.

Il motivo per cui funziona: ogni modale è una funzione che prende dei dati. Dalla console
le passi dati finti e vedi esattamente quello che vedrebbe un utente.

---

## 1. La card degli annunci

```js
// Un annuncio semplice, come modale
HubMessages._preview({ kicker: 'Xenon', title: 'È uscita la 4.9.0', body: 'Ecco cosa cambia.' })

// Con un bottone che apre un link
HubMessages._preview({
  title: 'Nuova guida per i creator',
  body: 'Come pubblicare il tuo primo widget.',
  action: { type: 'url', label: 'Leggi', url: 'https://xenon-app.com/create' }
})

// Come toast nell'angolo invece che come modale (il default vero degli annunci)
HubMessages._preview({ level: 'toast', title: 'Nuovo widget nello Store', body: 'Meteo avanzato' })
```

## 2. Un sondaggio

```js
HubMessages._preview({
  title: 'Cosa vorresti che arrivasse prima?',
  body: 'Una risposta sola, ci vuole un secondo.',
  poll: { options: [
    { id: 'deck',   label: 'Un Deck più grande' },
    { id: 'ai',     label: 'AI più intelligente' },
    { id: 'themes', label: 'Più temi' }
  ] }
})
```

Toccando una risposta parte davvero una chiamata a `/api/community/poll`. Il server
risponderà `unknown_poll`, perché quel sondaggio non esiste nel feed pubblicato: è normale
e non rompe niente, il toast di ringraziamento compare comunque.

## 3. Chi riceverebbe cosa (il filtro)

`_simulate` fa girare la selezione vera e ti dice cosa passerebbe e cosa no, **prima** di
pubblicare qualcosa a tutti:

```js
HubMessages._simulate({
  context: { version: '4.9.0', os: 'win32' },
  messages: [
    { id: 'a', level: 'toast', title: 'Per tutti' },
    { id: 'b', level: 'toast', title: 'Solo Linux',       match: { os: ['linux'] } },
    { id: 'c', level: 'toast', title: 'Solo dalla 5.0',   match: { minVersion: '5.0.0' } },
    { id: 'd', level: 'toast', title: 'Solo chi ha dgm-news', match: { hasEntry: ['dgm-news'] } }
  ]
})
```

Ti restituisce `matched` (quelli che verrebbero mostrati) e `skipped` (quelli scartati),
e mostra sul serio quelli che passano. Su un PC Windows con la 4.9.0 e senza `dgm-news`
passa solo il primo.

Puoi anche fingere di essere un altro utente senza cambiare niente sulla tua macchina:

```js
HubMessages._simulate(feed, { os: 'linux', version: '5.1.0', installed: new Set(['dgm-news']) })
```

## 4. Le card che compaiono da sole

Queste esistevano già e non passano dalla console admin: le costruisce l'app.

```js
// Card edizione limitata
CatalogDrop.show({ id: 'test-drop', name: 'Nome della drop', kind: 'theme',
                   limited: { total: 50, claimed: 12, left: 38 } })

// Card pacchetto supporter
CatalogDrop.show({ id: 'test-sup', name: 'Pacchetto supporter', kind: 'bundle', locked: true })

// What's New
XenonWhatsNew.load().then(XenonWhatsNew.open)

// Modale aggiornamento disponibile
XenonUpdate.check(true).then(XenonUpdate.openModal)
```

## 5. Vedere la fila fra i modali

È la cosa che vale la pena guardare, perché è quella che ho cambiato. Apri prima What's New
e poi, mentre è ancora aperto, chiedi un annuncio: l'annuncio **aspetta** invece di
sovrapporsi, e compare quando chiudi il primo.

```js
XenonWhatsNew.load().then(XenonWhatsNew.open)          // apri questo
XenonInterrupts.whenIdle(() => HubMessages._preview({ title: 'Sono in coda' }))
// ora chiudi What's New: l'annuncio compare da solo
```

Per controllare se qualcosa è considerato "sullo schermo":

```js
XenonInterrupts.busy()   // true se c'è già un modale aperto o sei in game mode/ambient
```

## 6. Azzerare i limiti mentre provi

Ogni canale si mostra al massimo una volta al giorno e non ripete quello che ha già
mostrato. Provando, questo ti blocca subito. Per ripartire da zero:

```js
[
  'xeneonedge.catalogSeen',        // annunci e drop già mostrati
  'xeneonedge.interruptBudget',    // il modale-annuncio di oggi
  'xeneonedge.hubMessageCheck',    // ultimo controllo annunci
  'xeneonedge.catalogDropCheck',   // ultimo controllo drop
  'xeneonedge.hubMessagesMuted',   // opt-out annunci (vecchio flag)
  'xeneonedge.catalogDropsMuted',  // opt-out drop (vecchio flag)
  'xenon.whatsnew.dismissed',      // What's New già chiuso
  'xenon.update.dismissed'         // aggiornamento già rimandato
].forEach((k) => localStorage.removeItem(k));
location.reload();
```

Attenzione: se hai spento gli annunci dall'interruttore in Impostazioni, cancellare le
chiavi qui sopra non basta, perché quello è salvato lato server. Riaccendilo da
Impostazioni → Aggiornamenti.

## 7. Il giro completo, come lo vedrebbe un utente

```js
HubMessages.checkDaily()
```

Questo fa la cosa vera: scarica il feed pubblicato, filtra, mostra. Serve che
`docs/community/messages.json` sul sito contenga qualcosa. Finché è vuoto non succede
niente, ed è il comportamento giusto.

---

## Cosa NON si può provare da qui

Il conteggio installazioni parte solo da un'installazione vera dallo Store, e va a buon
fine solo se l'entry esiste nel catalogo pubblicato. Per provarlo installa qualcosa dallo
Store con l'interruttore acceso in Impostazioni → Aggiornamenti, poi guarda il numero nella
console admin, sezione "Installs by creation". Il numero sulla card dello Store compare solo
da 10 installazioni in su.
