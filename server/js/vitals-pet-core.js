'use strict';
// Vitals Pet core — the pure, dependency-free half of "Bit", the pixel guardian
// that heckles you when your self-care meters (vitals.js) hit zero.
//
// Lives apart from the DOM engine (vitals-pet.js) so the parts that must never
// regress silently — the phrase bank shape, the no-repeat shuffle-bag, the tone
// filter and the escalation thresholds — are plain functions unit-tested in
// server/test/vitals-pet.test.mjs. UMD-lite: `window.VitalsPetCore` in the
// browser, `module.exports` under node:test (same pattern as @xenon/core).
//
// Phrase design rules (keep them when adding lines):
//  - Funny, never genuinely mean: Bit roasts like a friend, not a bully.
//  - Tones are cumulative tiers: t1 "soft" (gentle nudge), t2 "spicy"
//    (sarcastic), t3 "savage" (merciless but absurd). Tone setting N draws
//    from every tier ≤ N, so cranking it up ADDS bite without losing variety.
//  - `{vital}` = localized vital name, `{min}` = whole minutes at zero.
//  - Every bucket exists in BOTH languages (it/en) — the test enforces it.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VitalsPetCore = api;
})(typeof self !== 'undefined' ? self : this, function () {

  const TONES = ['soft', 'spicy', 'savage'];

  // Escalation ladder — how long a vital must sit at ZERO before each stage
  // unlocks. `nag` (toast + bubble) starts immediately; everything else waits.
  // Stages are additionally gated by the user's opt-in toggles and, for the
  // PC-invading ones, by presence (system idle) — see stagesFor().
  const STAGE_AT = Object.freeze({
    nag: 0,                    // insult toast + pet bubble (repeats, jittered)
    decay: 5 * 60000,          // dashboard desaturates + glitch pulses
    gameover: 8 * 60000,       // full-dashboard CRT "GAME OVER" card
    overlay: 10 * 60000,       // pixel popup on the PC monitor(s)
    minimize: 15 * 60000,      // minimize every window (once per episode)
    lock: 20 * 60000,          // lock the workstation (once per episode)
  });

  // Repeat cadence per stage, [minMs, maxMs] — jittered so nags never feel
  // metronomic. Stages not listed fire once per episode.
  const REPEAT_MS = Object.freeze({
    nag: [4 * 60000, 7 * 60000],
    gameover: [8 * 60000, 12 * 60000],
    overlay: [7 * 60000, 10 * 60000],
  });

  // ── phrase bank ─────────────────────────────────────────────────────────────
  // p(tier, text) keeps entries compact.
  const p = (t, s) => ({ t, s });

  const IT = {
    vital: {
      hydration: {
        low: [
          p(1, 'Un sorso d\'acqua ci starebbe, che dici?'),
          p(1, 'La borraccia ti sta guardando. Tu non la stai guardando.'),
          p(2, 'Idratazione al 25%. Il cactus in ufficio è messo meglio di te.'),
          p(2, 'Ti stai essiccando in tempo reale. Affascinante. Ma no.'),
          p(3, 'Ancora niente acqua? Le piante grasse hanno preso appunti da te.'),
        ],
        zero: [
          p(1, 'Acqua a zero. Facciamo che bevi e non ne parliamo più.'),
          p(1, 'Promemoria affettuoso: gli umani funzionano ad acqua.'),
          p(2, 'Idratazione: 0%. Sei ufficialmente un umano liofilizzato.'),
          p(2, 'Il corpo umano è al 70% acqua. Il tuo, al 70% caffè e testardaggine.'),
          p(2, 'Se fossi una pianta, a quest\'ora saresti nell\'umido.'),
          p(3, 'ZERO ACQUA da {min} minuti. L\'uvetta ha più succo di te.'),
          p(3, 'Bevi. Non è un consiglio, è una minaccia. Con affetto, ma una minaccia.'),
          p(3, 'Ho visto mummie più fresche. E non si lamentavano nemmeno.'),
        ],
        nag: [
          p(1, 'Sempre io: l\'acqua. Sempre tu: niente. Riproviamo?'),
          p(2, 'Sono passati {min} minuti. La tua idratazione è un ricordo, tipo i floppy disk.'),
          p(2, 'Non berrai mica aspettando che l\'acqua evapori fin qui?'),
          p(3, '{min} minuti a secco. Nel deserto avresti già venduto il PC per una bottiglietta.'),
          p(3, 'Ok, nuovo piano: io continuo a scriverti, tu continui a ignorarmi, e alla fine vinco io. Vinco sempre io.'),
        ],
      },
      energy: {
        low: [
          p(1, 'Energia in riserva: uno spuntino vero farebbe miracoli.'),
          p(1, 'Il serbatoio è quasi vuoto. Frutta > merendine, dico solo questo.'),
          p(2, 'Stai girando a spie accese. E non è la modalità turbo.'),
          p(2, 'Energia al 25%: da qui in poi è solo forza di volontà e rancore.'),
          p(3, 'Batteria quasi a terra. E tu non hai la ricarica rapida.'),
        ],
        zero: [
          p(1, 'Energia a zero: il tuo corpo chiede carburante, non caffè.'),
          p(1, 'Una pausa e qualcosa da mangiare. Il codice non scappa, promesso.'),
          p(2, 'Energia: 0%. Stai letteralmente runnando a vuoto, come un ciclo while(true).'),
          p(2, 'Il tuo stomaco ha aperto un ticket. Priorità: critica.'),
          p(2, 'Da {min} minuti a zero. Persino il salvaschermo ha più energia di te.'),
          p(3, 'ZERO ENERGIA. Sei un laptop al 2% senza caricatore che dice "tanto ce la faccio".'),
          p(3, 'Mangia qualcosa. Il tuo cervello sta compilando a 0.5x.'),
          p(3, 'Ammiro la testardaggine. Il tuo metabolismo un po\' meno.'),
        ],
        nag: [
          p(1, 'Sempre qui, sempre a ricordarti che esiste il cibo.'),
          p(2, 'Aggiornamento: sono {min} minuti che il tuo corpo va avanti per abitudine.'),
          p(2, 'Il frigo è a 10 metri. Ce la puoi fare. Credo in te. Più o meno.'),
          p(3, '{min} minuti in riserva. A questo punto sopravvivi per pura fotosintesi.'),
          p(3, 'Il tuo livello di energia è così basso che Windows ti proporrebbe la modalità risparmio.'),
        ],
      },
      stamina: {
        low: [
          p(1, 'Due passi? Le gambe servono anche a quello.'),
          p(1, 'Sgranchirsi ogni tanto: il corpo ringrazia, la schiena pure.'),
          p(2, 'Sei seduto da così tanto che la sedia sta valutando l\'usucapione.'),
          p(2, 'Movimento al 25%. Le statue si muovono più di te, coi piccioni.'),
          p(3, 'La tua impronta sul cuscino della sedia è ormai patrimonio archeologico.'),
        ],
        zero: [
          p(1, 'Fermo da troppo: alzati un minuto, giusto per ricordare come si fa.'),
          p(1, 'Il corpo è fatto per muoversi. Ogni tanto. Anche solo per finta.'),
          p(2, 'Stamina: 0%. Congratulazioni, sei diventato un arredo.'),
          p(2, 'Sei fermo da {min} minuti. I mobili dell\'IKEA fanno più strada di te.'),
          p(2, 'Le tue gambe hanno mandato un ultimo messaggio: "ci ricordiamo di te".'),
          p(3, 'ZERO MOVIMENTO. Gli NPC del tuo gioco preferito hanno una vita più attiva.'),
          p(3, 'A questo punto la sedia non la usi, la abiti.'),
          p(3, 'Alzati. Anche i bradipi, ogni tanto. ANCHE I BRADIPI.'),
        ],
        nag: [
          p(1, 'Un giretto fino alla finestra conta. Poco, ma conta.'),
          p(2, '{min} minuti immobile. Il tuo smartwatch ti ha dichiarato disperso.'),
          p(2, 'Alzarsi brucia calorie. Ignorarmi, purtroppo per te, no.'),
          p(3, 'Fermo da {min} minuti: il muschio inizia a considerarti una superficie.'),
          p(3, 'Ti muovi così poco che Google Maps ti ha segnato come punto di interesse.'),
        ],
      },
      focus: {
        low: [
          p(1, 'Occhi stanchi: guarda lontano per 20 secondi, è gratis.'),
          p(1, 'Regola 20-20-20: ogni tanto funziona anche se la ignori con stile.'),
          p(2, 'I tuoi occhi stanno friggendo a fuoco lento. Odore di pixel bruciato.'),
          p(2, 'Focus al 25%: stai rileggendo la stessa riga da tre minuti, ammettilo.'),
          p(3, 'Sbatti le palpebre ogni tanto. Non è un DLC a pagamento.'),
        ],
        zero: [
          p(1, 'Pausa occhi: 20 secondi di orizzonte e torni una persona.'),
          p(1, 'Lo schermo resta lì. I tuoi occhi, se continui così, non è detto.'),
          p(2, 'Focus: 0%. I tuoi occhi hanno la stessa messa a fuoco di una patata.'),
          p(2, 'Da {min} minuti fissi lo schermo. Lo schermo, per la cronaca, non ricambia.'),
          p(2, 'Vista appannata, riga persa, scroll a caso: il combo completo.'),
          p(3, 'ZERO FOCUS. Stai guardando lo schermo come un pesce guarda il vetro.'),
          p(3, 'I tuoi occhi hanno presentato le dimissioni. Con effetto immediato.'),
          p(3, 'Guarda fuori dalla finestra. Quella vera. Sì, esiste ancora.'),
        ],
        nag: [
          p(1, 'Sempre io. Sempre per i tuoi occhi. Sempre ignorato.'),
          p(2, '{min} minuti senza una pausa occhi: la tua vista sta bufferando.'),
          p(2, 'Se leggi questo messaggio sfocato, è esattamente il mio punto.'),
          p(3, 'A furia di fissare lo schermo hai più cicli tu del monitor. E lui è a 165Hz.'),
          p(3, 'Le talpe ci vedono meglio. LE TALPE, {min} minuti.'),
        ],
      },
      posture: {
        low: [
          p(1, 'Controllo postura: schiena dritta, spalle giù. Fatto? Bravo.'),
          p(1, 'Ricorda: lo schermo all\'altezza degli occhi, non gli occhi all\'altezza dello schermo.'),
          p(2, 'Ti stai piegando verso lo schermo come una pianta verso la luce. Ma peggio.'),
          p(2, 'Postura al 25%: metà persona, metà punto interrogativo.'),
          p(3, 'La tua colonna vertebrale sta scrivendo una lettera di reclamo.'),
        ],
        zero: [
          p(1, 'Postura a zero: schiena dritta e ripartiamo da capo.'),
          p(1, 'Spalle rilassate, mento su. Te lo dico io che non ho né spalle né mento.'),
          p(2, 'Postura: 0%. Sei ufficialmente a forma di gambero.'),
          p(2, 'Da {min} minuti curvo così: i liutai potrebbero usarti come modello.'),
          p(2, 'Quasimodo ha chiamato. Dice che esageri.'),
          p(3, 'ZERO POSTURA. Il tuo chiropratico futuro ti ringrazia per la casa al mare.'),
          p(3, 'Sei così curvo che il monitor ti guarda dall\'alto in basso. Letteralmente.'),
          p(3, 'La tua schiena a quest\'ora è un QR code. E nessuno vuole scansionarlo.'),
        ],
        nag: [
          p(1, 'Piccolo check: come sei seduto in questo esatto momento?'),
          p(2, '{min} minuti a forma di C. L\'alfabeto ha altre 25 lettere, provale.'),
          p(2, 'Raddrizzati. Non per me, per il tuo te stesso del 2050.'),
          p(3, 'Continuando così a 80 anni vedrai solo pavimenti. Belli, eh. Ma solo quelli.'),
          p(3, 'La tua postura fa sembrare il Gobbo di Notre-Dame un istruttore di pilates.'),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, '{vital} K.O. — ma si può ancora rimediare.'),
        p(1, 'Barra a zero. Ricarichiamola e non è successo niente.'),
        p(2, '{vital}: caduto in battaglia dopo {min} minuti di puro menefreghismo.'),
        p(2, 'GAME OVER su {vital}. Vuoi continuare? Costa un gesto di autocura.'),
        p(2, 'Hai finito le vite su {vital}. E qui i continue non si comprano.'),
        p(3, '{vital} è morto. Causa del decesso: tu.'),
        p(3, 'Speedrun del degrado: {vital} azzerato. Nuovo record personale, complimenti?'),
        p(3, 'Ho scritto io il necrologio di {vital}: "Ignorato fino alla fine, come i termini di servizio".'),
      ],
      alldead: [
        p(1, 'Tutti i vitali a zero. Direi che è il momento di una vera pausa.'),
        p(2, 'Cinque barre su cinque a zero. Un en plein. Di cui vergognarsi.'),
        p(2, 'Stato del giocatore: tecnicamente vivo, statisticamente no.'),
        p(3, 'TUTTO A ZERO. Non sei più un utente, sei un reperto.'),
        p(3, 'Complimenti: hai platinato il trascurarsi. Nessun trofeo, solo cervicale.'),
      ],
      welcomeback: [
        p(1, 'Bentornato! Mentre giocavi, qualche barra è scesa parecchio: dacci un occhio.'),
        p(2, 'Bella partita? Il tuo {vital}, nel frattempo, è defunto. GG.'),
        p(2, 'GG WP. Ora però guarda le tue barre: parlano di te malissimo.'),
        p(3, 'Tu facevi punti. Il tuo {vital} faceva testamento.'),
        p(3, 'La kill più feroce della sessione l\'hai fatta al tuo {vital}. Nemmeno assistita: da solo.'),
      ],
      minwarn: [
        p(1, 'Ora passo alle maniere decise: tra 30 secondi ti nascondo io tutte le finestre. Sistema {vital} e non serve.'),
        p(2, 'Ultimo avviso: sistemi {vital} entro 30 secondi o ti minimizzo TUTTO io. Non è una minaccia. Ok sì, lo è.'),
        p(2, 'Tra 30 secondi faccio sparire io le tue finestre. Le mie condizioni le conosci: {vital}.'),
        p(2, 'Conto alla rovescia: 30 secondi, poi al desktop ci penso io. Muoviti, {vital}.'),
        p(3, 'Passiamo alle maniere forti: tra mezzo minuto minimizzo tutto io e giuro che mi diverto pure.'),
        p(3, 'Hai 30 secondi per {vital}. Poi le tue finestre le nascondo io, una a una.'),
        p(3, '30 secondi e sul desktop resta solo la mia faccia. Sarò stato io, ricordatelo.'),
      ],
      minimized: [
        p(1, 'Fatto io: finestre minimizzate. Niente panico, sono nella barra. Ora però {vital}.'),
        p(2, 'Fatto. Ho minimizzato tutto io, sì. Ora che ho la tua attenzione: {vital}, subito.'),
        p(2, 'Sono stato io a spazzare via le finestre. Le riapri dalla barra; {vital}, invece, lo ricarichi tu.'),
        p(3, 'Le tue finestre riposano — cortesia mia. Tu muoviti: {vital} non si ricarica da solo.'),
        p(3, 'Sì, sono stato io. Sul serio: {vital} adesso, o la prossima volta faccio di peggio.'),
      ],
      lockwarn: [
        p(1, 'Misura seria: tra 60 secondi blocco io il PC. Sistema {vital} e lascio perdere.'),
        p(2, '60 secondi e ti blocco il PC io stesso. Il tempo scorre. Tic. Tac.'),
        p(2, 'Countdown: 60 secondi per {vital}, o metto io questa sessione in pausa forzata.'),
        p(2, 'Preavviso onesto: fra un minuto premo io il blocco schermo. La palla è tua: {vital}.'),
        p(3, '60 secondi. Poi il CTRL+ALT+CANC lo faccio io, a modo mio.'),
        p(3, 'Blocco in arrivo tra 60 secondi, e lo attivo io. Consideralo una pausa sindacale obbligatoria.'),
      ],
      locked: [
        p(1, 'Bloccato. Sono stato io. Rientri col login — nel frattempo occupati di {vital}.'),
        p(2, 'PC bloccato, cortesia di Bit. Ci risentiamo dopo che avrai sistemato {vital}.'),
        p(2, 'L\'ho fatto io: schermata di blocco. Non è Windows impazzito, sono io. Ora {vital}.'),
        p(3, 'Sì, ti ho bloccato io. Il login lo sai; la scusa per {vital} a zero, invece, no.'),
        p(3, 'Blocco attivato da me. Riprendi quando ti sarai preso cura di {vital}. Aspetto.'),
      ],
      praise: [
        p(1, 'Ottimo lavoro. Le barre ringraziano.'),
        p(1, '+100! Continua così e resto disoccupato. Magari.'),
        p(2, 'Guarda chi si prende cura di sé. Sono... fiero? Che sensazione strana.'),
        p(2, 'Ricaricato! Non male, per uno che dieci minuti fa era un fossile.'),
        p(3, 'Wow, autocura spontanea. Segno questo giorno sul calendario.'),
      ],
      stinger: [
        p(1, '— Bit'),
        p(2, 'Questo messaggio si autodistruggerà. Tu invece resti così.'),
        p(2, 'Non costringermi a chiamare tua madre.'),
        p(3, 'Io sono pixel e lo so. Tu che scusa hai?'),
        p(3, 'Firmato: il tuo senso di colpa, in 8-bit.'),
      ],
    },
  };

  const EN = {
    vital: {
      hydration: {
        low: [
          p(1, 'A sip of water wouldn\'t hurt, would it?'),
          p(1, 'Your water bottle is staring at you. You\'re not staring back.'),
          p(2, 'Hydration at 25%. The office cactus is doing better than you.'),
          p(2, 'You are dehydrating in real time. Fascinating. But no.'),
          p(3, 'Still no water? Succulents are taking notes from you.'),
        ],
        zero: [
          p(1, 'Water at zero. Drink up and we\'ll pretend this never happened.'),
          p(1, 'Friendly reminder: humans run on water.'),
          p(2, 'Hydration: 0%. You are officially freeze-dried.'),
          p(2, 'The human body is 70% water. Yours is 70% coffee and stubbornness.'),
          p(2, 'If you were a plant, you\'d be compost by now.'),
          p(3, 'ZERO WATER for {min} minutes. Raisins are juicier than you.'),
          p(3, 'Drink. That\'s not advice, it\'s a threat. A loving one. But a threat.'),
          p(3, 'I\'ve seen fresher mummies. And they never complained.'),
        ],
        nag: [
          p(1, 'It\'s me again: water. It\'s you again: nothing. Shall we?'),
          p(2, '{min} minutes now. Your hydration is a memory, like floppy disks.'),
          p(2, 'Are you waiting for the water to evaporate its way over to you?'),
          p(3, '{min} minutes dry. In a desert you\'d have traded the PC for a bottle by now.'),
          p(3, 'New plan: I keep texting, you keep ignoring me, and eventually I win. I always win.'),
        ],
      },
      energy: {
        low: [
          p(1, 'Energy reserve light is on: a real snack would work wonders.'),
          p(1, 'Tank\'s nearly empty. Fruit > candy bars, just saying.'),
          p(2, 'You\'re running on warning lights. That is not turbo mode.'),
          p(2, 'Energy at 25%: from here on it\'s pure willpower and spite.'),
          p(3, 'Battery almost dead. And you don\'t have fast charging.'),
        ],
        zero: [
          p(1, 'Energy at zero: your body wants fuel, not more coffee.'),
          p(1, 'Take a break and eat something. The code will wait, promise.'),
          p(2, 'Energy: 0%. You are literally running on empty, like a while(true) loop.'),
          p(2, 'Your stomach has opened a ticket. Priority: critical.'),
          p(2, '{min} minutes at zero. Even the screensaver has more energy than you.'),
          p(3, 'ZERO ENERGY. You\'re a laptop at 2% with no charger going "I got this".'),
          p(3, 'Eat something. Your brain is compiling at 0.5x speed.'),
          p(3, 'I admire the stubbornness. Your metabolism doesn\'t.'),
        ],
        nag: [
          p(1, 'Still here, still reminding you that food exists.'),
          p(2, 'Update: your body has been running on habit for {min} minutes.'),
          p(2, 'The fridge is ten meters away. You can do this. I believe in you. Ish.'),
          p(3, '{min} minutes on reserve. At this point you survive on photosynthesis.'),
          p(3, 'Your energy is so low, Windows would suggest power-saving mode for you.'),
        ],
      },
      stamina: {
        low: [
          p(1, 'A short walk? Legs do that too, you know.'),
          p(1, 'Stretch once in a while: your body says thanks, your back says THANKS.'),
          p(2, 'You\'ve been sitting so long the chair is filing for ownership.'),
          p(2, 'Movement at 25%. Statues move more than you. Thanks to pigeons.'),
          p(3, 'Your imprint on that chair cushion is now an archaeological site.'),
        ],
        zero: [
          p(1, 'Still for too long: stand up a minute, just to remember how.'),
          p(1, 'Bodies are made to move. Occasionally. Even just for show.'),
          p(2, 'Stamina: 0%. Congratulations, you are now furniture.'),
          p(2, 'Motionless for {min} minutes. IKEA furniture travels more than you.'),
          p(2, 'Your legs sent one last message: "we remember you".'),
          p(3, 'ZERO MOVEMENT. The NPCs in your favorite game have a more active lifestyle.'),
          p(3, 'At this point you don\'t use the chair. You inhabit it.'),
          p(3, 'Stand up. Even sloths do. EVEN SLOTHS.'),
        ],
        nag: [
          p(1, 'A stroll to the window counts. Barely, but it counts.'),
          p(2, '{min} minutes motionless. Your smartwatch has declared you missing.'),
          p(2, 'Standing up burns calories. Ignoring me, sadly for you, does not.'),
          p(3, 'Still for {min} minutes: moss is starting to consider you a surface.'),
          p(3, 'You move so little Google Maps flagged you as a landmark.'),
        ],
      },
      focus: {
        low: [
          p(1, 'Tired eyes: look far away for 20 seconds, it\'s free.'),
          p(1, 'The 20-20-20 rule occasionally works even when you ignore it with style.'),
          p(2, 'Your eyes are slow-frying. I can smell burnt pixels.'),
          p(2, 'Focus at 25%: you\'ve re-read the same line three times, admit it.'),
          p(3, 'Blink occasionally. It\'s not paid DLC.'),
        ],
        zero: [
          p(1, 'Eye break: 20 seconds of horizon and you\'re a person again.'),
          p(1, 'The screen will still be here. Your eyesight, at this rate, who knows.'),
          p(2, 'Focus: 0%. Your eyes currently focus like a potato.'),
          p(2, '{min} minutes staring at the screen. The screen, for the record, doesn\'t care.'),
          p(2, 'Blurry sight, lost line, random scrolling: the full combo.'),
          p(3, 'ZERO FOCUS. You\'re staring at the screen like a fish stares at glass.'),
          p(3, 'Your eyes have handed in their resignation. Effective immediately.'),
          p(3, 'Look out the window. The real one. Yes, it still exists.'),
        ],
        nag: [
          p(1, 'Me again. About your eyes again. Ignored again.'),
          p(2, '{min} minutes without an eye break: your vision is buffering.'),
          p(2, 'If this message looks blurry, that is exactly my point.'),
          p(3, 'You\'ve stared so long you have more burn-in than the monitor. And it\'s an LCD.'),
          p(3, 'Moles see better than you right now. MOLES. {min} minutes.'),
        ],
      },
      posture: {
        low: [
          p(1, 'Posture check: back straight, shoulders down. Done? Good.'),
          p(1, 'Screen at eye level — not eyes at screen level.'),
          p(2, 'You\'re leaning into the screen like a plant leans into light. But worse.'),
          p(2, 'Posture at 25%: half person, half question mark.'),
          p(3, 'Your spine is drafting a formal complaint.'),
        ],
        zero: [
          p(1, 'Posture at zero: straighten up and we start over.'),
          p(1, 'Shoulders relaxed, chin up. Says me, who has neither.'),
          p(2, 'Posture: 0%. You are officially shrimp-shaped.'),
          p(2, '{min} minutes hunched like that: violin makers could use you as a mold.'),
          p(2, 'Quasimodo called. He says you\'re overdoing it.'),
          p(3, 'ZERO POSTURE. Your future chiropractor thanks you for the beach house.'),
          p(3, 'You\'re so hunched the monitor is looking down on you. Literally.'),
          p(3, 'Your spine is basically a QR code now. And nobody wants to scan it.'),
        ],
        nag: [
          p(1, 'Quick check: how are you sitting right now?'),
          p(2, '{min} minutes shaped like a C. The alphabet has 25 other letters, try some.'),
          p(2, 'Straighten up. Not for me — for 2050 you.'),
          p(3, 'Keep this up and at 80 you\'ll only ever see floors. Nice ones. But floors.'),
          p(3, 'Your posture makes the Hunchback of Notre-Dame look like a pilates instructor.'),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, '{vital} K.O. — still fixable, though.'),
        p(1, 'Bar at zero. Refill it and this never happened.'),
        p(2, '{vital}: fell in battle after {min} minutes of pure neglect.'),
        p(2, 'GAME OVER on {vital}. Continue? It costs one act of self-care.'),
        p(2, 'You\'re out of lives on {vital}. And you can\'t buy continues here.'),
        p(3, '{vital} is dead. Cause of death: you.'),
        p(3, 'Neglect speedrun: {vital} zeroed. New personal best, congrats?'),
        p(3, 'I wrote {vital}\'s obituary: "Ignored to the end, like the terms of service".'),
      ],
      alldead: [
        p(1, 'Every vital at zero. Time for an actual break, I\'d say.'),
        p(2, 'Five bars out of five at zero. A clean sweep. Of shame.'),
        p(2, 'Player status: technically alive, statistically not.'),
        p(3, 'ALL ZERO. You\'re not a user anymore, you\'re an artifact.'),
        p(3, 'Congrats: you\'ve platinumed self-neglect. No trophy, just neck pain.'),
      ],
      welcomeback: [
        p(1, 'Welcome back! Some bars dropped hard while you played — give them a look.'),
        p(2, 'Good game? Your {vital}, meanwhile, has passed away. GG.'),
        p(2, 'GG WP. Now look at your bars: they speak very poorly of you.'),
        p(3, 'You were racking up points. Your {vital} was writing its will.'),
        p(3, 'The most brutal kill of the session was your own {vital}. Not even assisted: solo.'),
      ],
      minwarn: [
        p(1, 'Switching to firm mode now: in 30 seconds I hide all your windows myself. Fix {vital} and I won\'t.'),
        p(2, 'Final warning: fix {vital} within 30 seconds or I minimize EVERYTHING myself. Not a threat. Okay, yes it is.'),
        p(2, 'In 30 seconds I make your windows disappear. You know my terms: {vital}.'),
        p(2, 'Countdown: 30 seconds, then I tidy your desktop for you. Move it, {vital}.'),
        p(3, 'We\'re going hard: in half a minute I minimize everything, and I swear I\'ll enjoy it.'),
        p(3, 'You have 30 seconds for {vital}. Then I hide your windows myself, one by one.'),
        p(3, '30 seconds and only my face is left on the desktop. That\'ll have been me — remember it.'),
      ],
      minimized: [
        p(1, 'That was me: windows minimized. Relax, they\'re in the taskbar. Now — {vital}.'),
        p(2, 'Done. I minimized everything, yes. Now that I have your attention: {vital}, now.'),
        p(2, 'I swept your windows away. Reopen them from the taskbar; {vital}, though, you refill.'),
        p(3, 'Your windows are resting — my treat. You, however, move: {vital} won\'t refill itself.'),
        p(3, 'Yep, that was me. Seriously: {vital} now, or next time I do worse.'),
      ],
      lockwarn: [
        p(1, 'Serious measure: in 60 seconds I lock the PC myself. Fix {vital} and I\'ll drop it.'),
        p(2, '60 seconds and I lock the PC myself. Clock\'s ticking. Tick. Tock.'),
        p(2, 'Countdown: 60 seconds for {vital}, or I put this session on a forced break.'),
        p(2, 'Fair heads-up: in a minute I hit the lock screen myself. Ball\'s in your court: {vital}.'),
        p(3, '60 seconds. Then I do CTRL+ALT+DEL my way.'),
        p(3, 'Lock incoming in 60 seconds, and I\'m the one flipping it. Consider it a mandatory union break.'),
      ],
      locked: [
        p(1, 'Locked. That was me. Log back in — meanwhile, deal with {vital}.'),
        p(2, 'PC locked, courtesy of Bit. Talk again once you\'ve sorted {vital}.'),
        p(2, 'I did it: lock screen. It\'s not Windows glitching, it\'s me. Now {vital}.'),
        p(3, 'Yes, I locked you out. You know the login; the excuse for {vital} at zero, not so much.'),
        p(3, 'Lock triggered by me. Come back when you\'ve taken care of {vital}. I\'ll wait.'),
      ],
      praise: [
        p(1, 'Nice work. The bars thank you.'),
        p(1, '+100! Keep this up and I\'m out of a job. Hopefully.'),
        p(2, 'Look who\'s taking care of themselves. I\'m... proud? What a weird feeling.'),
        p(2, 'Refilled! Not bad for someone who was a fossil ten minutes ago.'),
        p(3, 'Wow, spontaneous self-care. Marking this day on the calendar.'),
      ],
      stinger: [
        p(1, '— Bit'),
        p(2, 'This message will self-destruct. You, however, will stay like this.'),
        p(2, 'Don\'t make me call your mother.'),
        p(3, 'I\'m made of pixels and I know it. What\'s your excuse?'),
        p(3, 'Signed: your guilt, in 8-bit.'),
      ],
    },
  };

  // ── localized banks (ko/ja/zh/es/fr/de/pt/ru) — same bucket/tier shape as EN,
  // per-bucket English fallback in bucketFor. Generated + structure-checked. ──
  const KO = {
    vital: {
      hydration: {
        low: [
          p(1, "물 한 모금 마신다고 큰일 나는 거 아니잖아?"),
          p(1, "물통이 너 뚫어져라 쳐다보는데, 넌 눈길도 안 주네."),
          p(2, "수분 25%. 사무실 선인장이 너보다 상태 낫다."),
          p(2, "실시간으로 말라가는 중이야. 흥미롭네. 그래도 안 마심?"),
          p(3, "아직도 물 안 마셔? 다육이가 너 보고 배우는 중이야."),
        ],
        zero: [
          p(1, "수분 제로. 얼른 마시고 이 일은 없던 걸로 하자."),
          p(1, "친절한 알림: 사람은 물로 굴러가는 존재야."),
          p(2, "수분 0%. 넌 공식적으로 동결건조됐어."),
          p(2, "인체의 70%는 물이라던데, 너는 70%가 커피랑 고집이야."),
          p(2, "네가 식물이었으면 지금쯤 거름됐다."),
          p(3, "{min}분째 물 제로. 건포도가 너보다 촉촉하다."),
          p(3, "마셔. 조언 아니고 협박이야. 사랑이 담긴. 그래도 협박."),
          p(3, "미라를 봐도 너보단 싱싱하더라. 걔넨 불평도 안 하고."),
        ],
        nag: [
          p(1, "또 나야: 물. 또 너지: 아무것도 안 함. 이제 마실까?"),
          p(2, "벌써 {min}분. 네 수분은 이제 플로피디스크급 추억이야."),
          p(2, "물이 알아서 증발해서 네 입까지 걸어오길 기다리는 거야?"),
          p(3, "{min}분째 바싹. 사막이었으면 진작 컴퓨터랑 물 한 병 바꿨어."),
          p(3, "새 계획: 나는 계속 메시지 보내고, 넌 계속 씹고, 결국 내가 이겨. 난 항상 이겨."),
        ],
      },
      energy: {
        low: [
          p(1, "에너지 경고등 켜졌어. 제대로 된 간식 하나면 기적이 일어나."),
          p(1, "연료통 거의 바닥. 초코바보다 과일이 낫다, 그냥 하는 말."),
          p(2, "경고등만으로 달리는 중이네. 그거 터보 모드 아니야."),
          p(2, "에너지 25%. 여기부턴 순수 오기랑 근성으로만 버티는 거야."),
          p(3, "배터리 거의 방전. 근데 넌 고속충전도 안 돼."),
        ],
        zero: [
          p(1, "에너지 제로. 네 몸은 커피 말고 연료를 원해."),
          p(1, "잠깐 쉬고 뭐 좀 먹어. 코드는 기다려줘, 약속해."),
          p(2, "에너지 0%. 말 그대로 빈 통으로 달리는 while(true) 루프야."),
          p(2, "네 위장이 티켓 하나 열었어. 우선순위: 긴급."),
          p(2, "{min}분째 제로. 화면보호기가 너보다 활력 있다."),
          p(3, "에너지 제로. 넌 충전기 없이 2% 남은 노트북이 \"괜찮아\" 하는 꼴이야."),
          p(3, "뭐 좀 먹어. 네 뇌가 0.5배속으로 컴파일 중이야."),
          p(3, "그 고집은 존경해. 근데 네 신진대사는 아니야."),
        ],
        nag: [
          p(1, "여전히 여기 있어, 여전히 음식이 존재한단 걸 알려주는 중."),
          p(2, "업데이트: 네 몸은 {min}분째 관성으로만 돌아가고 있어."),
          p(2, "냉장고는 10미터 앞이야. 넌 할 수 있어. 믿어. 조금은."),
          p(3, "{min}분째 예비연료 주행. 이쯤 되면 광합성으로 사는 거야."),
          p(3, "에너지가 너무 낮아서 윈도우가 절전 모드 추천할 지경이야."),
        ],
      },
      stamina: {
        low: [
          p(1, "잠깐 산책? 다리가 그것도 할 줄 알아, 알지?"),
          p(1, "가끔 스트레칭 좀. 몸이 고맙다 하고, 허리는 진심으로 고맙다 한다."),
          p(2, "너무 오래 앉아있어서 의자가 소유권 소송 거는 중이야."),
          p(2, "움직임 25%. 동상이 너보다 많이 움직여. 비둘기 덕분에."),
          p(3, "그 방석에 남은 네 엉덩이 자국은 이제 유적지야."),
        ],
        zero: [
          p(1, "너무 오래 가만히 있었어. 1분만 일어나 봐, 방법 까먹기 전에."),
          p(1, "몸은 움직이라고 만들어진 거야. 가끔은. 그냥 폼으로라도."),
          p(2, "체력 0%. 축하해, 넌 이제 가구야."),
          p(2, "{min}분째 미동도 없음. 이케아 가구가 너보다 여행 많이 다닌다."),
          p(2, "네 다리가 마지막 메시지 남겼어: \"우린 널 기억할게\"."),
          p(3, "움직임 제로. 네가 좋아하는 게임 속 NPC가 더 활동적으로 산다."),
          p(3, "이쯤 되면 넌 의자를 쓰는 게 아니라 의자에 거주하는 거야."),
          p(3, "일어나. 나무늘보도 일어나. 나무늘보도 일어난다고."),
        ],
        nag: [
          p(1, "창가까지 어슬렁거리는 것도 쳐줄게. 간신히, 그래도 쳐줌."),
          p(2, "{min}분째 정지. 네 스마트워치가 널 실종 신고했어."),
          p(2, "일어나면 칼로리가 타. 나 씹는 건, 안타깝게도 안 타."),
          p(3, "{min}분째 가만히: 이끼가 널 착지 표면으로 고려하기 시작했어."),
          p(3, "너무 안 움직여서 구글 지도가 널 랜드마크로 등록했더라."),
        ],
      },
      focus: {
        low: [
          p(1, "눈 피곤하지: 20초만 멀리 봐, 공짜야."),
          p(1, "20-20-20 규칙, 네가 멋지게 무시해도 가끔은 통해."),
          p(2, "네 눈이 뭉근하게 튀겨지는 중. 탄 픽셀 냄새 난다."),
          p(2, "집중 25%. 같은 줄 세 번 다시 읽었지, 인정해."),
          p(3, "가끔 눈 좀 깜빡여. 그거 유료 DLC 아니야."),
        ],
        zero: [
          p(1, "눈 휴식: 지평선 20초면 다시 사람이 돼."),
          p(1, "화면은 계속 여기 있어. 네 시력은, 이 속도면 글쎄다."),
          p(2, "집중 0%. 지금 네 눈 초점은 감자 수준이야."),
          p(2, "{min}분째 화면만 응시 중. 화면은 참고로 관심 없대."),
          p(2, "흐릿한 시야, 놓친 줄, 무의미한 스크롤: 풀 콤보 완성."),
          p(3, "집중 제로. 물고기가 어항 유리 보듯 화면을 보고 있네."),
          p(3, "네 눈이 사표 냈어. 효력 즉시 발생."),
          p(3, "창밖을 봐. 진짜 창문 말이야. 응, 아직 존재해."),
        ],
        nag: [
          p(1, "또 나야. 또 네 눈 얘기고. 또 씹혔지."),
          p(2, "{min}분째 눈 안 쉼: 네 시야가 버퍼링 중이야."),
          p(2, "이 메시지가 흐릿하게 보이면, 그게 바로 내 말의 요점이야."),
          p(3, "너무 오래 봐서 모니터보다 네 눈에 번인이 심하다. 그것도 LCD인데."),
          p(3, "지금은 두더지가 너보다 잘 봐. 두더지가. {min}분째."),
        ],
      },
      posture: {
        low: [
          p(1, "자세 점검: 허리 펴고 어깨 내리고. 됐어? 좋아."),
          p(1, "화면을 눈높이에 맞춰, 눈을 화면 높이에 맞추지 말고."),
          p(2, "식물이 빛으로 기울듯 화면 쪽으로 기울고 있네. 근데 더 심각함."),
          p(2, "자세 25%. 반은 사람, 반은 물음표."),
          p(3, "네 척추가 정식으로 민원 접수 중이야."),
        ],
        zero: [
          p(1, "자세 제로: 허리 좀 펴고 처음부터 다시 하자."),
          p(1, "어깨는 편하게, 턱은 위로. 둘 다 없는 내가 하는 말이지만."),
          p(2, "자세 0%. 넌 공식적으로 새우 모양이야."),
          p(2, "{min}분째 그렇게 구부정하게: 바이올린 장인이 너를 틀로 쓸 수 있겠다."),
          p(2, "노트르담 꼽추가 전화했어. 네가 좀 오버한다더라."),
          p(3, "자세 제로. 네 미래의 도수치료사가 별장값 벌었다며 고마워한다."),
          p(3, "너무 구부정해서 모니터가 널 내려다보는 중이야. 말 그대로."),
          p(3, "네 척추는 이제 거의 QR코드야. 근데 아무도 스캔하고 싶어 안 해."),
        ],
        nag: [
          p(1, "간단 점검: 지금 어떻게 앉아 있어?"),
          p(2, "{min}분째 C자 모양. 알파벳엔 다른 글자 25개도 있어, 좀 써봐."),
          p(2, "허리 펴. 나 말고, 2050년의 너를 위해서."),
          p(3, "이대로 가면 80살엔 평생 바닥만 보게 돼. 예쁜 바닥이긴 해. 그래도 바닥."),
          p(3, "네 자세는 노트르담 꼽추를 필라테스 강사처럼 보이게 만든다."),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, "{vital} K.O. — 그래도 아직 살릴 수 있어."),
        p(1, "바 제로. 다시 채우면 이 일은 없던 걸로."),
        p(2, "{vital}: {min}분간의 순수 방치 끝에 전사했습니다."),
        p(2, "{vital} 게임 오버. 계속하시겠습니까? 자기관리 한 번이면 됩니다."),
        p(2, "{vital} 목숨 다 썼어. 여기선 컨티뉴도 못 사."),
        p(3, "{vital} 사망. 사인: 너."),
        p(3, "방치 스피드런: {vital} 제로. 개인 신기록, 축하해야 하나?"),
        p(3, "{vital} 부고를 썼어: \"이용약관처럼 끝까지 무시당함\"."),
      ],
      alldead: [
        p(1, "모든 바 제로. 이제 진짜 쉬어야 할 때인 것 같은데."),
        p(2, "다섯 바 중 다섯 개 제로. 완벽한 그랜드슬램. 부끄러움의."),
        p(2, "플레이어 상태: 기술적으로는 생존, 통계적으로는 아님."),
        p(3, "전부 제로. 넌 이제 유저가 아니라 유물이야."),
        p(3, "축하해: 자기방치 플래티넘 달성. 트로피는 없고 목 통증만 있어."),
      ],
      welcomeback: [
        p(1, "돌아온 걸 환영해! 노는 동안 몇몇 바가 폭락했어, 한번 봐봐."),
        p(2, "잘 놀았어? 그동안 네 {vital}은 세상을 떠났어. GG."),
        p(2, "GG WP. 이제 네 바들 봐: 널 아주 험담하고 있어."),
        p(3, "넌 점수 쌓고 있었지. 네 {vital}은 유언장 쓰고 있었고."),
        p(3, "이번 판 가장 잔혹한 킬은 네 {vital}이었어. 어시스트도 없이 솔로킬."),
      ],
      minwarn: [
        p(1, "이제 단호 모드로 전환: 30초 뒤에 내가 직접 네 창들 다 숨겨. {vital} 챙기면 안 그럴게."),
        p(2, "마지막 경고: 30초 안에 {vital} 안 챙기면 내가 직접 전부 최소화해. 협박 아니야. 아니, 맞아."),
        p(2, "30초 뒤 네 창들을 사라지게 만들 거야. 내 조건 알잖아: {vital}."),
        p(2, "카운트다운 30초, 그다음엔 내가 네 바탕화면 정리해줄게. 서둘러, {vital}."),
        p(3, "제대로 간다: 30초 뒤 내가 전부 최소화하고, 맹세컨대 아주 즐길 거야."),
        p(3, "{vital} 챙길 시간 30초 줄게. 그다음엔 내가 직접 창을 하나씩 숨긴다."),
        p(3, "30초 뒤 바탕화면엔 내 얼굴만 남아. 그게 다 내가 한 거야 — 기억해둬."),
      ],
      minimized: [
        p(1, "방금 그거 나야: 창들 최소화했어. 진정해, 작업표시줄에 다 있어. 자 이제 — {vital}."),
        p(2, "완료. 응, 내가 전부 최소화했어. 이제 네 관심 얻었으니: {vital}, 지금."),
        p(2, "네 창들 싹 치웠어. 작업표시줄에서 다시 열면 돼. 근데 {vital}은 네가 채워."),
        p(3, "네 창들은 지금 쉬는 중이야 — 내가 쏜 거지. 근데 너는 움직여: {vital}은 알아서 안 차."),
        p(3, "응, 그거 내가 한 거 맞아. 진지하게: {vital} 지금 챙겨, 안 그럼 다음엔 더 심하게 간다."),
      ],
      lockwarn: [
        p(1, "진지한 조치야: 60초 뒤 내가 직접 PC를 잠근다. {vital} 챙기면 없던 일로 할게."),
        p(2, "60초 뒤 내가 직접 PC 잠가. 시계 돌아가고 있어. 째깍. 째깍."),
        p(2, "카운트다운: {vital} 챙길 60초, 아니면 이 세션 강제 휴식 들어간다."),
        p(2, "미리 알려주는 거야: 1분 뒤 내가 직접 잠금 화면 띄운다. 공은 네 코트에 있어: {vital}."),
        p(3, "60초. 그다음엔 내 방식대로 CTRL+ALT+DEL 간다."),
        p(3, "60초 뒤 잠금 들어가고, 그 스위치는 내가 올려. 강제 노조 휴식이라고 생각해."),
      ],
      locked: [
        p(1, "잠갔어. 내가 한 거야. 다시 로그인해 — 그동안 {vital} 좀 챙기고."),
        p(2, "PC 잠금, Bit 제공. {vital} 정리하고 나면 다시 얘기하자."),
        p(2, "내가 했어: 잠금 화면. 윈도우 오류 아니고 나야. 이제 {vital}."),
        p(3, "응, 내가 널 쫓아냈어. 로그인 방법은 알겠지, 근데 {vital} 제로에 대한 변명은 글쎄."),
        p(3, "잠금은 내가 발동했어. {vital} 챙기고 돌아와. 기다릴게."),
      ],
      praise: [
        p(1, "잘했어. 바들이 고마워한다."),
        p(1, "+100! 이대로 가면 나 실직이야. 부디 그러길."),
        p(2, "이야 자기관리를 다 하네. 나... 뿌듯한가? 참 이상한 기분이다."),
        p(2, "재충전 완료! 10분 전엔 화석이던 것치곤 나쁘지 않네."),
        p(3, "와, 자발적 자기관리라니. 이날을 달력에 표시해두겠어."),
      ],
      stinger: [
        p(1, "— Bit"),
        p(2, "이 메시지는 곧 자폭합니다. 너는 그대로 남지만."),
        p(2, "네 엄마한테 전화하게 만들지 마."),
        p(3, "난 픽셀로 만들어졌고 그걸 알아. 넌 무슨 핑계 있어?"),
        p(3, "서명: 8비트로 된 너의 죄책감."),
      ],
    },
  };

  const JA = {
    vital: {
      hydration: {
        low: [
          p(1, "水、一口くらい飲んでも損はしないよね？"),
          p(1, "水筒がこっちをじっと見てるよ。君は見返してあげないけど。"),
          p(2, "水分25%。デスクのサボテンの方が元気そうだよ。"),
          p(2, "リアルタイムで干からびていく君。興味深い。でもダメ。"),
          p(3, "まだ水なし？多肉植物が君を見習ってメモ取ってるよ。"),
        ],
        zero: [
          p(1, "水分ゼロ。飲んじゃえば、この件はなかったことにしてあげる。"),
          p(1, "親切なお知らせ。人間は水で動いてます。"),
          p(2, "水分0%。君は正式にフリーズドライ認定です。"),
          p(2, "人体の70%は水。君の70%はコーヒーと意地。"),
          p(2, "君が植物だったら、とっくに堆肥になってるね。"),
          p(3, "水分ゼロで{min}分。レーズンの方が君よりみずみずしいよ。"),
          p(3, "飲め。これは助言じゃない、脅迫だ。愛のある脅迫。でも脅迫だ。"),
          p(3, "君よりみずみずしいミイラを見たことある。しかも文句ひとつ言わなかった。"),
        ],
        nag: [
          p(1, "またぼくだよ、用件は水。君はまた無反応。そろそろどう？"),
          p(2, "もう{min}分。君の水分はもう思い出だよ、フロッピーディスクみたいに。"),
          p(2, "水が蒸発して自分から君のところに来るのを待ってるの？"),
          p(3, "{min}分カラカラ。砂漠だったらとっくにPCと水一本を交換してたよ。"),
          p(3, "新作戦。ぼくは送り続ける、君は無視し続ける、最後はぼくが勝つ。ぼくは必ず勝つ。"),
        ],
      },
      energy: {
        low: [
          p(1, "エネルギー残量ランプ点灯中。ちゃんとした軽食で劇的に回復するよ。"),
          p(1, "タンクほぼ空。お菓子より果物、って言っとくね。"),
          p(2, "君は警告ランプで走ってる。それターボモードじゃないから。"),
          p(2, "エネルギー25%。ここから先は気合と意地だけが頼り。"),
          p(3, "バッテリーほぼ切れ。しかも君、急速充電非対応。"),
        ],
        zero: [
          p(1, "エネルギーゼロ。体が欲しいのは燃料であって、追いコーヒーじゃない。"),
          p(1, "休憩して何か食べて。コードは待っててくれるよ、約束する。"),
          p(2, "エネルギー0%。文字通り空回り、while(true)ループみたいに。"),
          p(2, "君の胃がチケットを起票したよ。優先度：致命的。"),
          p(2, "ゼロで{min}分。スクリーンセーバーの方が君より元気だよ。"),
          p(3, "エネルギーゼロ。充電器なしの残り2%のノートPCが「まだいける」って言ってる状態。"),
          p(3, "何か食べて。君の脳、0.5倍速でコンパイル中だよ。"),
          p(3, "その意地は尊敬する。君の代謝は尊敬してないけどね。"),
        ],
        nag: [
          p(1, "まだここにいるよ。食べ物ってものが存在するって、まだ念押ししてる。"),
          p(2, "続報。君の体、{min}分ずっと惰性だけで動いてます。"),
          p(2, "冷蔵庫まで10メートル。君ならできる。信じてる。たぶん。"),
          p(3, "予備電源で{min}分。もう光合成で生きてるレベルだね。"),
          p(3, "君のエネルギー低すぎて、Windowsが君に節電モードを勧めてくるよ。"),
        ],
      },
      stamina: {
        low: [
          p(1, "ちょっと散歩は？脚ってそういうこともできるんだよ。"),
          p(1, "たまには伸びを。体は「ありがとう」、腰は「本ッ当にありがとう」って言うよ。"),
          p(2, "座りすぎて、椅子が君の所有権を主張し始めたよ。"),
          p(2, "運動量25%。銅像の方がまだ動くよ。ハトのおかげで。"),
          p(3, "クッションに残った君の跡、もう遺跡認定されるレベルだよ。"),
        ],
        zero: [
          p(1, "じっとしすぎ。一分立ってみて、立ち方を思い出すために。"),
          p(1, "体は動くためにできてる。たまにはね。ポーズだけでも。"),
          p(2, "スタミナ0%。おめでとう、君はもう家具です。"),
          p(2, "{min}分微動だにせず。IKEAの家具の方が君より移動してるよ。"),
          p(2, "君の脚が最後のメッセージを送ってきた。「君のこと、覚えてるよ」。"),
          p(3, "運動量ゼロ。お気に入りゲームのNPCの方がアクティブな生活してるよ。"),
          p(3, "もう君は椅子を使ってるんじゃない。椅子に住んでるんだ。"),
          p(3, "立って。ナマケモノでも立つよ。ナ・マ・ケ・モ・ノでも。"),
        ],
        nag: [
          p(1, "窓までの散歩でもカウントするよ。ギリギリだけど、カウントする。"),
          p(2, "{min}分不動。スマートウォッチが君を行方不明として届け出たよ。"),
          p(2, "立てばカロリーを消費する。ぼくを無視しても、残念ながら消費しない。"),
          p(3, "{min}分静止。コケが君を「地面」として検討し始めたよ。"),
          p(3, "君が動かなさすぎて、Googleマップが君をランドマーク登録したよ。"),
        ],
      },
      focus: {
        low: [
          p(1, "目が疲れてる。20秒だけ遠くを見て。無料だよ。"),
          p(1, "20-20-20ルールは、君が堂々と無視してても、たまには効くんだよ。"),
          p(2, "君の目、じわじわ焼けてる。焦げたピクセルの匂いがするよ。"),
          p(2, "集中力25%。同じ行を3回読み直したでしょ、白状しなよ。"),
          p(3, "たまには瞬きして。有料DLCじゃないから。"),
        ],
        zero: [
          p(1, "目を休めて。20秒地平線を見れば、また人間に戻れるよ。"),
          p(1, "画面は逃げないよ。君の視力は、このままだとどうなるか分からないけど。"),
          p(2, "集中力0%。今の君の目、ジャガイモ並みのピント。"),
          p(2, "{min}分画面を凝視。念のため言うけど、画面は君に興味ないよ。"),
          p(2, "視界ボケ、読む行を見失う、意味なくスクロール。フルコンボだね。"),
          p(3, "集中力ゼロ。金魚が水槽のガラスを見つめる目で画面を見てるよ。"),
          p(3, "君の目が退職届を出したよ。即日発効。"),
          p(3, "窓の外を見て。本物の窓の方ね。うん、まだ存在してるよ。"),
        ],
        nag: [
          p(1, "またぼく。また君の目の話。またスルー。"),
          p(2, "目を休めず{min}分。君の視界、バッファリング中だよ。"),
          p(2, "このメッセージがぼやけて見えるなら、まさにそれがぼくの言いたいこと。"),
          p(3, "凝視しすぎて、モニターより君の方が焼き付いてるよ。しかもこれLCDなのに。"),
          p(3, "今の君より、モグラの方がよく見えてるよ。モ・グ・ラ。しかも{min}分。"),
        ],
      },
      posture: {
        low: [
          p(1, "姿勢チェック。背筋を伸ばして、肩を落として。できた？よし。"),
          p(1, "画面を目の高さに。目を画面の高さに合わせるんじゃなくてね。"),
          p(2, "植物が光に向かうみたいに画面に前のめり。しかもそれより悪い。"),
          p(2, "姿勢25%。半分人間、半分クエスチョンマーク。"),
          p(3, "君の背骨が正式な苦情書を作成中だよ。"),
        ],
        zero: [
          p(1, "姿勢ゼロ。背筋を伸ばして、仕切り直そう。"),
          p(1, "肩の力を抜いて、あごを上げて。肩もあごもないぼくが言うけどね。"),
          p(2, "姿勢0%。君は正式にエビ型認定です。"),
          p(2, "その猫背で{min}分。バイオリン職人が君を型に使えるレベル。"),
          p(2, "ノートルダムのせむし男から電話。「やりすぎだよ」って。"),
          p(3, "姿勢ゼロ。未来の整体師が別荘の礼を言ってるよ。"),
          p(3, "猫背すぎて、モニターに見下ろされてるよ。物理的に。"),
          p(3, "君の背骨、もうほぼQRコードだね。しかも誰も読み取りたがらない。"),
        ],
        nag: [
          p(1, "ちょっと確認。今どんな座り方してる？"),
          p(2, "Cの字で{min}分。アルファベットは残り25文字あるよ、他のも試して。"),
          p(2, "背筋を伸ばして。ぼくのためじゃない、2050年の君のために。"),
          p(3, "このままだと80歳で見えるのは床だけになるよ。いい床。でも床。"),
          p(3, "君の姿勢のせいで、ノートルダムのせむし男がピラティス講師に見えるよ。"),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, "{vital}がK.O.。まあ、まだ立て直せるけどね。"),
        p(1, "バーがゼロ。回復させれば、なかったことになるよ。"),
        p(2, "{vital}、{min}分の完全放置の末に戦死。"),
        p(2, "{vital}でGAME OVER。コンティニューする？料金はセルフケア1回分。"),
        p(2, "{vital}の残機ゼロ。ここではコンティニューも買えないよ。"),
        p(3, "{vital}、死亡。死因：君。"),
        p(3, "放置RTA、{vital}ゼロ達成。自己ベスト更新、おめでとう？"),
        p(3, "{vital}の追悼文を書いたよ。「最後まで無視された、利用規約のように」。"),
      ],
      alldead: [
        p(1, "全ステータスがゼロ。そろそろ本気で休憩すべきだと思うな。"),
        p(2, "5本中5本がゼロ。パーフェクト達成。恥の。"),
        p(2, "プレイヤー状態：一応生存、統計的には死亡。"),
        p(3, "オールゼロ。君はもうユーザーじゃない、遺物だよ。"),
        p(3, "おめでとう、自己放置をプラチナトロフィー制覇。特典はなし、あるのは首の痛みだけ。"),
      ],
      welcomeback: [
        p(1, "おかえり！プレイ中にいくつかのバーが急降下したよ、見てあげて。"),
        p(2, "いいゲームだった？その間に君の{vital}は他界したよ。GG。"),
        p(2, "GG WP。さてバーを見て。君のことをかなり悪く言ってるよ。"),
        p(3, "君がスコアを稼いでる間、君の{vital}は遺言を書いてたよ。"),
        p(3, "今回のセッション最凶のキルは、君自身の{vital}だった。アシストなし、ソロキル。"),
      ],
      minwarn: [
        p(1, "ここから本気モード。30秒後、ぼくが君のウィンドウを全部隠す。{vital}を直せばやめるよ。"),
        p(2, "最終警告。30秒以内に{vital}を直さないと、ぼくが全部最小化する。脅しじゃない。うん、脅しだ。"),
        p(2, "30秒後、ぼくが君のウィンドウを消す。条件は分かってるよね、{vital}。"),
        p(2, "カウントダウン30秒、そのあとぼくがデスクトップを片付けてあげる。急いで、{vital}。"),
        p(3, "本気でいくよ。30秒後にぼくが全部最小化する、しかも絶対に楽しむと誓う。"),
        p(3, "{vital}に使える時間は30秒。そのあとぼくがウィンドウを一枚ずつ隠していくよ。"),
        p(3, "30秒後、デスクトップに残るのはぼくの顔だけ。犯人はぼくだよ、覚えといて。"),
      ],
      minimized: [
        p(1, "今のはぼく。ウィンドウは最小化した。安心して、全部タスクバーにあるよ。さあ、{vital}。"),
        p(2, "完了。うん、ぼくが全部最小化した。注目してもらえたところで、{vital}、今すぐ。"),
        p(2, "ぼくが君のウィンドウを片付けた。開き直すのはタスクバーから。{vital}の回復は君の仕事だけどね。"),
        p(3, "君のウィンドウはお休み中、ぼくのおごりだ。でも君は動いて。{vital}は勝手に回復しないよ。"),
        p(3, "そう、今のはぼく。真面目な話、{vital}を今すぐ。じゃないと次はもっとひどいことするよ。"),
      ],
      lockwarn: [
        p(1, "本気の措置。60秒後、ぼくがPCをロックする。{vital}を直せば取りやめるよ。"),
        p(2, "60秒で、ぼくがPCをロックする。時計は進んでる。チク。タク。"),
        p(2, "カウントダウン、{vital}に60秒。じゃなきゃこのセッションを強制休憩にするよ。"),
        p(2, "フェアな予告。1分後、ぼくがロック画面を出す。ボールは君のコートにあるよ、{vital}。"),
        p(3, "60秒。そのあとぼく流のCTRL+ALT+DELをキメるよ。"),
        p(3, "60秒後にロック、スイッチを入れるのはぼくだ。労働組合公認の強制休憩だと思って。"),
      ],
      locked: [
        p(1, "ロックした。今のはぼく。ログインし直して、ついでに{vital}をどうにかして。"),
        p(2, "PCロック、ビットからの贈り物です。{vital}を片付けたらまた話そう。"),
        p(2, "ぼくがやった、ロック画面。Windowsの不具合じゃない、ぼくだよ。さあ{vital}。"),
        p(3, "そう、ぼくが締め出した。ログインの仕方は知ってるよね。{vital}ゼロの言い訳の方は知らないだろうけど。"),
        p(3, "ロック発動、犯人はぼく。{vital}をケアしたら戻っておいで。待ってるよ。"),
      ],
      praise: [
        p(1, "よくやった。バーたちが感謝してるよ。"),
        p(1, "+100！この調子だとぼく失業だね。そうなってほしいけど。"),
        p(2, "おや、自分をちゃんとケアしてる人がいるぞ。ぼく…誇らしい？なんか変な感じ。"),
        p(2, "回復完了！10分前まで化石だった人にしては上出来だよ。"),
        p(3, "うわ、自発的なセルフケア。この日はカレンダーに丸をつけとくよ。"),
      ],
      stinger: [
        p(1, "— ビット"),
        p(2, "このメッセージは自動消滅します。君は、そのままだけどね。"),
        p(2, "君のお母さんに電話させないでよ。"),
        p(3, "ぼくはピクセルでできてる、自覚もある。君の言い訳は何？"),
        p(3, "署名：君の罪悪感、8ビット版。"),
      ],
    },
  };

  const ZH = {
    vital: {
      hydration: {
        low: [
          p(1, "喝口水又不会少块肉,对吧?"),
          p(1, "你的水杯一直盯着你,你却一眼都不回。"),
          p(2, "水分只剩25%。办公室那盆仙人掌都活得比你滋润。"),
          p(2, "你正在实时脱水,挺有看头。但不行。"),
          p(3, "还是不喝水?多肉植物都在向你偷师了。"),
        ],
        zero: [
          p(1, "水分归零了。快喝两口,就当无事发生。"),
          p(1, "友情提示:人类是靠水运行的。"),
          p(2, "水分:0%。你已正式进入冻干状态。"),
          p(2, "人体70%是水。你这70%是咖啡加倔脾气。"),
          p(2, "你要是棵植物,现在都沤成肥料了。"),
          p(3, "已经{min}分钟一滴水没沾。葡萄干都比你多汁。"),
          p(3, "喝水。这不是建议,是威胁。带爱的那种。但确实是威胁。"),
          p(3, "我见过比你新鲜的木乃伊。人家还从不抱怨。"),
        ],
        nag: [
          p(1, "又是我:水。又是你:啥也没干。走一个?"),
          p(2, "都{min}分钟了。你的水分已成回忆,和软盘一样。"),
          p(2, "你是在等水自己蒸发飘到你嘴边吗?"),
          p(3, "干渴{min}分钟。搁沙漠里你早拿电脑换瓶水了。"),
          p(3, "新计划:我一直催,你一直装看不见,最后我赢。我总能赢。"),
        ],
      },
      energy: {
        low: [
          p(1, "能量储备灯亮了:来点像样的零食会有奇效。"),
          p(1, "油箱快见底了。水果 > 巧克力棒,随口一提。"),
          p(2, "你全靠警告灯在硬撑,这可不是涡轮模式。"),
          p(2, "能量25%:接下来全靠意志力和一口气死撑。"),
          p(3, "电池快没电了。偏偏你还不支持快充。"),
        ],
        zero: [
          p(1, "能量归零:你的身体要的是饭,不是又一杯咖啡。"),
          p(1, "歇会儿吃点东西吧。代码会等你的,我保证。"),
          p(2, "能量:0%。你是真在空转,像个 while(true) 死循环。"),
          p(2, "你的胃已经提了工单。优先级:紧急。"),
          p(2, "归零{min}分钟了。连屏保都比你有活力。"),
          p(3, "能量归零。你就是台2%电量还没充电器的笔记本,嘴上还硬说\"我可以\"。"),
          p(3, "吃点东西。你的大脑正以0.5倍速编译。"),
          p(3, "我佩服你这股倔劲。你的新陈代谢可不佩服。"),
        ],
        nag: [
          p(1, "还在这儿呢,继续提醒你:食物是存在的。"),
          p(2, "进度:你的身体已经靠惯性运行{min}分钟了。"),
          p(2, "冰箱就在十米外。你能行的。我信你。大概吧。"),
          p(3, "靠储备撑了{min}分钟。你这是打算靠光合作用活着了。"),
          p(3, "你能量低到,Windows 都想替你开省电模式。"),
        ],
      },
      stamina: {
        low: [
          p(1, "去溜达两步?腿也是能干这个的,你知道的。"),
          p(1, "偶尔伸个懒腰:身体谢谢你,腰更是谢天谢地。"),
          p(2, "你坐太久了,椅子都准备申请你的所有权了。"),
          p(2, "活动量25%。雕像都比你动得多——多亏了鸽子。"),
          p(3, "你在坐垫上压出的那个印,现在算考古遗址了。"),
        ],
        zero: [
          p(1, "坐太久啦:起来站一分钟,就当复习下怎么站。"),
          p(1, "身体是用来动的。偶尔动动。哪怕只是做做样子。"),
          p(2, "耐力:0%。恭喜,你现在是家具了。"),
          p(2, "一动不动{min}分钟。宜家的家具都比你走得远。"),
          p(2, "你的腿发来最后一条消息:\"我们还记得你\"。"),
          p(3, "零活动量。你最爱那游戏里的NPC都比你生活规律。"),
          p(3, "到这份上,你不是在用椅子了,你是住在椅子里。"),
          p(3, "站起来。连树懒都会站。连——树——懒——都——会。"),
        ],
        nag: [
          p(1, "走到窗边也算数。勉强算,但算。"),
          p(2, "一动不动{min}分钟。你的智能手表已经把你标记为失踪了。"),
          p(2, "站起来能消耗卡路里。可惜,无视我并不能。"),
          p(3, "静止{min}分钟:青苔开始把你当成一块可着陆的表面了。"),
          p(3, "你动得太少,高德地图把你标成了地标。"),
        ],
      },
      focus: {
        low: [
          p(1, "眼睛累了:望向远处20秒,免费的。"),
          p(1, "20-20-20法则偶尔也管用,就算你一直优雅地无视它。"),
          p(2, "你的眼睛在文火慢煎。我都闻到像素焦味了。"),
          p(2, "专注度25%:同一行你都读第三遍了,承认吧。"),
          p(3, "偶尔眨眨眼。这又不是付费DLC。"),
        ],
        zero: [
          p(1, "让眼睛歇歇:看20秒地平线,你又变回人了。"),
          p(1, "屏幕不会跑。你的视力,照这架势,可就难说了。"),
          p(2, "专注度:0%。你的眼睛现在对焦水平约等于一颗土豆。"),
          p(2, "盯屏幕{min}分钟了。屏幕嘛,说真的,它并不在乎。"),
          p(2, "视线模糊、找不到行、随手乱滑:全套连招齐活了。"),
          p(3, "零专注。你盯着屏幕的样子,像条金鱼隔着缸盯外面。"),
          p(3, "你的眼睛已经递交辞呈了。即刻生效。"),
          p(3, "往窗外看看。真的窗户。对,它还在。"),
        ],
        nag: [
          p(1, "又是我。又是关于你的眼睛。又被无视了。"),
          p(2, "{min}分钟没让眼睛休息:你的视野正在缓冲。"),
          p(2, "如果这条消息看着糊,那正好证明了我的观点。"),
          p(3, "你盯太久了,烧屏比你显示器还严重。它还是块LCD呢。"),
          p(3, "鼹鼠现在都看得比你清楚。鼹——鼠。{min}分钟了。"),
        ],
      },
      posture: {
        low: [
          p(1, "查一下姿势:背挺直,肩放松。做到了?很好。"),
          p(1, "把屏幕抬到眼睛高度——而不是把眼睛降到屏幕高度。"),
          p(2, "你正朝屏幕探过去,像植物朝着光。但更难看。"),
          p(2, "姿势25%:半个人,半个问号。"),
          p(3, "你的脊椎正在起草一份正式投诉。"),
        ],
        zero: [
          p(1, "姿势归零:坐直,咱们重新来过。"),
          p(1, "肩膀放松,下巴抬起。我说的,虽然我俩都没有。"),
          p(2, "姿势:0%。你现在正式呈虾米状。"),
          p(2, "这么弓着{min}分钟:做小提琴的都能拿你当模具了。"),
          p(2, "卡西莫多来电。他说你这有点过了。"),
          p(3, "零姿势。你未来的正骨医生谢谢你送的海景房。"),
          p(3, "你弓得太狠,显示器都在俯视你了。字面意义上。"),
          p(3, "你的脊椎现在基本是个二维码了。而且没人想扫。"),
        ],
        nag: [
          p(1, "快速检查:你现在到底是怎么坐的?"),
          p(2, "呈C型{min}分钟了。字母表还有25个别的,挑几个试试。"),
          p(2, "坐直点。不是为我——为2050年的你。"),
          p(3, "再这么下去,80岁时你就只能看地板了。挺好看的地板。但也就地板了。"),
          p(3, "你这姿势,让钟楼怪人看着都像个普拉提教练。"),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, "{vital} 被KO了——不过还能救。"),
        p(1, "这条已经归零。补满它,就当没发生过。"),
        p(2, "{vital}:在被你纯粹摆烂{min}分钟后阵亡。"),
        p(2, "{vital} GAME OVER。要续命吗?代价是一次自我照顾。"),
        p(2, "你在 {vital} 上没命了。而且这儿的续币可买不到。"),
        p(3, "{vital} 死了。死因:你。"),
        p(3, "摆烂速通:{vital} 清零。刷新个人纪录,恭喜?"),
        p(3, "我给 {vital} 写好了讣告:\"被无视到最后一刻,和用户协议一样\"。"),
      ],
      alldead: [
        p(1, "所有指标全归零。我看,是时候真正歇一歇了。"),
        p(2, "五条满格的全归零。团灭。而且是耻辱局。"),
        p(2, "玩家状态:理论上活着,统计上没了。"),
        p(3, "全部归零。你已经不是用户了,你是件出土文物。"),
        p(3, "恭喜:你把\"自我摆烂\"打出白金了。没奖杯,只有颈椎痛。"),
      ],
      welcomeback: [
        p(1, "欢迎回来!你打游戏时有几条掉得挺狠,快看看吧。"),
        p(2, "打得爽吗?你的 {vital} 呢,已经与世长辞了。GG。"),
        p(2, "GG WP。现在看看你的指标:它们把你说得一无是处。"),
        p(3, "你在那头猛刷分,你的 {vital} 在这头立遗嘱。"),
        p(3, "这一局最残忍的击杀,是你亲手送走的 {vital}。还是无助攻的:单杀。"),
      ],
      minwarn: [
        p(1, "我要动真格了:30秒后我亲自把你所有窗口收起来。搞定 {vital},我就不动手。"),
        p(2, "最后警告:30秒内搞定 {vital},否则我亲手把一切都最小化。这不是威胁。好吧,是。"),
        p(2, "30秒后我让你的窗口消失。你懂我的条件:{vital}。"),
        p(2, "倒计时:30秒,然后我帮你把桌面收拾干净。快点,{vital}。"),
        p(3, "咱来硬的:半分钟后我把一切最小化,而且我发誓我会很享受。"),
        p(3, "你有30秒处理 {vital}。然后我亲自把你的窗口一个一个收起来。"),
        p(3, "30秒后桌面上就只剩我一张脸了。那会是我干的——记住了。"),
      ],
      minimized: [
        p(1, "刚才是我干的:窗口全最小化了。别慌,都在任务栏里。现在——{vital}。"),
        p(2, "搞定。没错,我把一切都最小化了。现在总算引起你注意了:{vital},马上。"),
        p(2, "我把你的窗口都扫走了。从任务栏点开就行;不过 {vital},得你自己补。"),
        p(3, "你的窗口在休息——我请客。而你,给我动起来:{vital} 不会自己补满。"),
        p(3, "对,就是我干的。说真的:马上 {vital},不然下次我玩更狠的。"),
      ],
      lockwarn: [
        p(1, "严重措施:60秒后我亲自锁屏。搞定 {vital},我就收手。"),
        p(2, "60秒后我亲手锁屏。时间在走。滴。答。"),
        p(2, "倒计时:60秒处理 {vital},否则我强制给这一局放个假。"),
        p(2, "先礼后兵:一分钟后我亲自按下锁屏。球在你这边:{vital}。"),
        p(3, "60秒。然后我用我的方式来一套 CTRL+ALT+DEL。"),
        p(3, "60秒后锁屏,而且是我亲手翻的闸。就当是强制工会休息。"),
      ],
      locked: [
        p(1, "锁了。是我干的。重新登录就行——顺便把 {vital} 解决了。"),
        p(2, "电脑已锁,Bit 敬上。等你把 {vital} 搞定了咱再聊。"),
        p(2, "我干的:锁屏。不是Windows抽风,是我。现在,{vital}。"),
        p(3, "对,我把你锁在外面了。密码你知道;{vital} 归零的借口,你可就说不清了。"),
        p(3, "锁屏是我触发的。等你照顾好 {vital} 再回来。我等着。"),
      ],
      praise: [
        p(1, "干得漂亮。指标们谢谢你。"),
        p(1, "+100!照这样下去我就要失业了。但愿如此。"),
        p(2, "瞧瞧这是谁在照顾自己。我……有点骄傲?这感觉真奇怪。"),
        p(2, "回血啦!对一个十分钟前还是化石的人来说,不赖嘛。"),
        p(3, "哇,自发的自我照顾。这日子我得在日历上标一下。"),
      ],
      stinger: [
        p(1, "——Bit"),
        p(2, "本条消息将自动销毁。而你,还会维持现状。"),
        p(2, "别逼我给你妈打电话。"),
        p(3, "我是像素做的,我认。你又有什么借口?"),
        p(3, "落款:你的愧疚,8-bit 版。"),
      ],
    },
  };

  const ES = {
    vital: {
      hydration: {
        low: [
          p(1, "Un trago de agua no vendría mal, ¿o qué?"),
          p(1, "Tu botella te está mirando. Tú a ella, ni caso."),
          p(2, "Hidratación al 25%. El cactus de la oficina está mejor que tú."),
          p(2, "Te estás deshidratando en directo. Fascinante. Pero no."),
          p(3, "¿Aún sin agua? Los cactus están tomando apuntes de ti."),
        ],
        zero: [
          p(1, "Agua a cero. Bebe y hacemos como que esto nunca pasó."),
          p(1, "Recordatorio cariñoso: los humanos funcionan con agua."),
          p(2, "Hidratación: 0%. Oficialmente eres un humano liofilizado."),
          p(2, "El cuerpo humano es 70% agua. El tuyo, 70% café y cabezonería."),
          p(2, "Si fueras una planta, a estas alturas serías abono."),
          p(3, "CERO AGUA desde hace {min} minutos. Las pasas tienen más jugo que tú."),
          p(3, "Bebe. No es un consejo, es una amenaza. Con cariño, pero amenaza."),
          p(3, "He visto momias más frescas. Y encima no se quejaban."),
        ],
        nag: [
          p(1, "Otra vez yo: el agua. Otra vez tú: nada. ¿Lo intentamos?"),
          p(2, "Ya van {min} minutos. Tu hidratación es un recuerdo, como los disquetes."),
          p(2, "¿No estarás esperando a que el agua se evapore hasta aquí?"),
          p(3, "{min} minutos en seco. En el desierto ya habrías vendido el PC por una botellita."),
          p(3, "Plan nuevo: yo sigo escribiéndote, tú sigues ignorándome, y al final gano yo. Siempre gano yo."),
        ],
      },
      energy: {
        low: [
          p(1, "Reserva de energía en rojo: un tentempié de verdad haría milagros."),
          p(1, "El depósito casi vacío. Fruta > chuches, solo lo digo."),
          p(2, "Vas con la luz del reserva encendida. Y eso no es el modo turbo."),
          p(2, "Energía al 25%: de aquí en adelante es pura fuerza de voluntad y rencor."),
          p(3, "Batería casi a cero. Y tú no tienes carga rápida."),
        ],
        zero: [
          p(1, "Energía a cero: tu cuerpo pide combustible, no más café."),
          p(1, "Una pausa y algo de comer. El código no se escapa, prometido."),
          p(2, "Energía: 0%. Literalmente vas en vacío, como un bucle while(true)."),
          p(2, "Tu estómago ha abierto una incidencia. Prioridad: crítica."),
          p(2, "Llevas {min} minutos a cero. Hasta el salvapantallas tiene más energía que tú."),
          p(3, "CERO ENERGÍA. Eres un portátil al 2% sin cargador diciendo \"tranqui, aguanto\"."),
          p(3, "Come algo. Tu cerebro está compilando a 0.5x."),
          p(3, "Admiro la cabezonería. Tu metabolismo, menos."),
        ],
        nag: [
          p(1, "Aquí sigo, recordándote que la comida existe."),
          p(2, "Aviso: llevas {min} minutos tirando solo de costumbre."),
          p(2, "La nevera está a diez metros. Tú puedes. Confío en ti. Más o menos."),
          p(3, "{min} minutos en reserva. A este paso sobrevives por fotosíntesis."),
          p(3, "Tu energía está tan baja que Windows te propondría el modo ahorro."),
        ],
      },
      stamina: {
        low: [
          p(1, "¿Un paseíto? Las piernas también sirven para eso, ¿sabes?"),
          p(1, "Estírate de vez en cuando: tu cuerpo lo agradece, tu espalda lo AGRADECE."),
          p(2, "Llevas sentado tanto que la silla está tramitando la propiedad."),
          p(2, "Movimiento al 25%. Las estatuas se mueven más que tú. Gracias a las palomas."),
          p(3, "Tu huella en el cojín de la silla ya es yacimiento arqueológico."),
        ],
        zero: [
          p(1, "Quieto demasiado rato: levántate un minuto, aunque sea por recordar cómo se hace."),
          p(1, "El cuerpo está hecho para moverse. De vez en cuando. Aunque sea de mentira."),
          p(2, "Aguante: 0%. Enhorabuena, te has convertido en mobiliario."),
          p(2, "Llevas {min} minutos inmóvil. Los muebles de IKEA viajan más que tú."),
          p(2, "Tus piernas mandaron un último mensaje: \"nos acordamos de ti\"."),
          p(3, "CERO MOVIMIENTO. Los NPC de tu juego favorito llevan una vida más activa."),
          p(3, "A estas alturas la silla no la usas, la habitas."),
          p(3, "Levántate. Hasta los perezosos lo hacen. HASTA LOS PEREZOSOS."),
        ],
        nag: [
          p(1, "Una vuelta hasta la ventana cuenta. Poco, pero cuenta."),
          p(2, "{min} minutos inmóvil. Tu smartwatch te ha dado por desaparecido."),
          p(2, "Levantarse quema calorías. Ignorarme, por desgracia para ti, no."),
          p(3, "Quieto {min} minutos: el musgo empieza a considerarte una superficie."),
          p(3, "Te mueves tan poco que Google Maps te ha marcado como punto de interés."),
        ],
      },
      focus: {
        low: [
          p(1, "Ojos cansados: mira a lo lejos 20 segundos, es gratis."),
          p(1, "La regla 20-20-20: a veces funciona incluso si la ignoras con estilo."),
          p(2, "Tus ojos se están friendo a fuego lento. Huele a píxel quemado."),
          p(2, "Concentración al 25%: llevas tres minutos releyendo la misma línea, admítelo."),
          p(3, "Parpadea de vez en cuando. No es un DLC de pago."),
        ],
        zero: [
          p(1, "Descanso de ojos: 20 segundos de horizonte y vuelves a ser persona."),
          p(1, "La pantalla seguirá ahí. Tus ojos, a este ritmo, quién sabe."),
          p(2, "Concentración: 0%. Tus ojos enfocan como una patata."),
          p(2, "Llevas {min} minutos mirando la pantalla. La pantalla, para que conste, no te corresponde."),
          p(2, "Vista borrosa, línea perdida, scroll al azar: el combo completo."),
          p(3, "CERO CONCENTRACIÓN. Miras la pantalla como un pez mira el cristal."),
          p(3, "Tus ojos han presentado la dimisión. Con efecto inmediato."),
          p(3, "Mira por la ventana. La de verdad. Sí, todavía existe."),
        ],
        nag: [
          p(1, "Otra vez yo. Otra vez por tus ojos. Otra vez ignorado."),
          p(2, "{min} minutos sin un descanso de ojos: tu vista está cargando."),
          p(2, "Si lees este mensaje borroso, es justo lo que quería demostrar."),
          p(3, "De tanto fijar la pantalla tienes más quemado tú que el monitor. Y es un LCD."),
          p(3, "Los topos ven mejor que tú ahora mismo. LOS TOPOS, {min} minutos."),
        ],
      },
      posture: {
        low: [
          p(1, "Chequeo de postura: espalda recta, hombros abajo. ¿Hecho? Bien."),
          p(1, "Recuerda: la pantalla a la altura de los ojos, no los ojos a la de la pantalla."),
          p(2, "Te estás inclinando hacia la pantalla como una planta hacia la luz. Pero peor."),
          p(2, "Postura al 25%: mitad persona, mitad signo de interrogación."),
          p(3, "Tu columna está redactando una carta de reclamación."),
        ],
        zero: [
          p(1, "Postura a cero: espalda recta y empezamos de nuevo."),
          p(1, "Hombros relajados, mentón arriba. Te lo digo yo, que no tengo ni hombros ni mentón."),
          p(2, "Postura: 0%. Oficialmente tienes forma de gamba."),
          p(2, "Llevas {min} minutos encorvado así: los luthiers te usarían de molde."),
          p(2, "Ha llamado Quasimodo. Dice que te estás pasando."),
          p(3, "CERO POSTURA. Tu futuro fisio te agradece la casa en la playa."),
          p(3, "Estás tan encorvado que el monitor te mira por encima del hombro. Literalmente."),
          p(3, "Tu espalda ya es un código QR. Y nadie quiere escanearlo."),
        ],
        nag: [
          p(1, "Chequeo rápido: ¿cómo estás sentado en este preciso instante?"),
          p(2, "{min} minutos con forma de C. El abecedario tiene otras 26 letras, prueba alguna."),
          p(2, "Enderézate. No por mí, por el tú del 2050."),
          p(3, "Como sigas así, a los 80 solo verás suelos. Bonitos, eh. Pero solo suelos."),
          p(3, "Tu postura hace que el Jorobado de Notre-Dame parezca instructor de pilates."),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, "{vital} K.O. — aunque todavía tiene arreglo."),
        p(1, "Barra a cero. La recargas y aquí no ha pasado nada."),
        p(2, "{vital}: caído en combate tras {min} minutos de puro pasotismo."),
        p(2, "GAME OVER en {vital}. ¿Continuar? Cuesta un gesto de autocuidado."),
        p(2, "Te has quedado sin vidas en {vital}. Y aquí los continues no se compran."),
        p(3, "{vital} ha muerto. Causa de la muerte: tú."),
        p(3, "Speedrun del descuido: {vital} a cero. Nuevo récord personal, ¿enhorabuena?"),
        p(3, "He escrito yo el obituario de {vital}: \"Ignorado hasta el final, como los términos de servicio\"."),
      ],
      alldead: [
        p(1, "Todos los vitales a cero. Yo diría que toca una pausa de verdad."),
        p(2, "Cinco barras de cinco a cero. Pleno. De los de dar vergüenza."),
        p(2, "Estado del jugador: técnicamente vivo, estadísticamente no."),
        p(3, "TODO A CERO. Ya no eres un usuario, eres una pieza de museo."),
        p(3, "Enhorabuena: has platinado el descuidarte. Sin trofeo, solo cervicales."),
      ],
      welcomeback: [
        p(1, "¡Bienvenido de vuelta! Mientras jugabas, alguna barra bajó bastante: échale un ojo."),
        p(2, "¿Buena partida? Tu {vital}, mientras tanto, ha fallecido. GG."),
        p(2, "GG WP. Ahora mira tus barras: hablan fatal de ti."),
        p(3, "Tú sumabas puntos. Tu {vital} redactaba el testamento."),
        p(3, "La kill más brutal de la sesión se la hiciste a tu {vital}. Ni asistida: en solitario."),
      ],
      minwarn: [
        p(1, "Paso a las maneras firmes: en 30 segundos te escondo yo todas las ventanas. Arregla {vital} y no hace falta."),
        p(2, "Último aviso: arreglas {vital} en 30 segundos o te minimizo TODO yo. No es una amenaza. Vale, sí lo es."),
        p(2, "En 30 segundos hago desaparecer yo tus ventanas. Ya sabes mis condiciones: {vital}."),
        p(2, "Cuenta atrás: 30 segundos, y luego del escritorio me encargo yo. Muévete, {vital}."),
        p(3, "Pasamos a las malas: en medio minuto minimizo todo yo y juro que hasta lo disfruto."),
        p(3, "Tienes 30 segundos para {vital}. Luego te escondo yo las ventanas, una a una."),
        p(3, "30 segundos y en el escritorio solo queda mi cara. Habré sido yo, recuérdalo."),
      ],
      minimized: [
        p(1, "Lo he hecho yo: ventanas minimizadas. Sin pánico, están en la barra de tareas. Ahora, {vital}."),
        p(2, "Hecho. He minimizado todo yo, sí. Ahora que tengo tu atención: {vital}, ya."),
        p(2, "He sido yo quien barrió las ventanas. Las reabres desde la barra; {vital}, en cambio, lo recargas tú."),
        p(3, "Tus ventanas descansan — cortesía mía. Tú muévete: {vital} no se recarga solo."),
        p(3, "Sí, he sido yo. En serio: {vital} ahora, o la próxima vez hago algo peor."),
      ],
      lockwarn: [
        p(1, "Medida seria: en 60 segundos bloqueo yo el PC. Arregla {vital} y lo dejo estar."),
        p(2, "60 segundos y te bloqueo el PC yo mismo. El reloj corre. Tic. Tac."),
        p(2, "Cuenta atrás: 60 segundos para {vital}, o pongo yo esta sesión en pausa forzada."),
        p(2, "Aviso honesto: en un minuto le doy yo al bloqueo de pantalla. La pelota es tuya: {vital}."),
        p(3, "60 segundos. Después el CTRL+ALT+SUPR lo hago yo, a mi manera."),
        p(3, "Bloqueo en camino en 60 segundos, y lo activo yo. Considéralo pausa sindical obligatoria."),
      ],
      locked: [
        p(1, "Bloqueado. He sido yo. Vuelve con el login — mientras, ocúpate de {vital}."),
        p(2, "PC bloqueado, cortesía de Bit. Nos vemos cuando hayas arreglado {vital}."),
        p(2, "Lo he hecho yo: pantalla de bloqueo. No es Windows volviéndose loco, soy yo. Ahora {vital}."),
        p(3, "Sí, te he bloqueado yo. El login te lo sabes; la excusa para {vital} a cero, no tanto."),
        p(3, "Bloqueo activado por mí. Vuelve cuando te hayas ocupado de {vital}. Espero."),
      ],
      praise: [
        p(1, "Buen trabajo. Las barras te lo agradecen."),
        p(1, "¡+100! Sigue así y me quedo sin curro. Ojalá."),
        p(2, "Mira quién se cuida. Estoy... ¿orgulloso? Qué sensación más rara."),
        p(2, "¡Recargado! No está mal para alguien que hace diez minutos era un fósil."),
        p(3, "Vaya, autocuidado espontáneo. Marco este día en el calendario."),
      ],
      stinger: [
        p(1, "— Bit"),
        p(2, "Este mensaje se autodestruirá. Tú, en cambio, te quedas así."),
        p(2, "No me obligues a llamar a tu madre."),
        p(3, "Soy de píxeles y lo sé. ¿Tú qué excusa tienes?"),
        p(3, "Firmado: tu sentimiento de culpa, en 8 bits."),
      ],
    },
  };

  const FR = {
      vital: {
        hydration: {
          low: [
            p(1, "Une petite gorgée d'eau, ça te dirait pas ?"),
            p(1, "Ta gourde te fixe. Toi, tu ne la regardes même pas."),
            p(2, "Hydratation à 25%. Le cactus du bureau se porte mieux que toi."),
            p(2, "Tu te déshydrates en direct. Fascinant. Mais non."),
            p(3, "Toujours pas d'eau ? Les plantes grasses prennent des notes sur toi."),
          ],
          zero: [
            p(1, "Eau à zéro. Tu bois un coup et on n'en parle plus."),
            p(1, "Petit rappel affectueux : les humains, ça marche à l'eau."),
            p(2, "Hydratation : 0%. Tu es officiellement un humain lyophilisé."),
            p(2, "Le corps humain, c'est 70% d'eau. Le tien, 70% de café et d'entêtement."),
            p(2, "Si tu étais une plante, tu serais déjà au compost."),
            p(3, "ZÉRO EAU depuis {min} minutes. Un raisin sec est plus juteux que toi."),
            p(3, "Bois. C'est pas un conseil, c'est une menace. Affectueuse, mais une menace."),
            p(3, "J'ai vu des momies plus fraîches. Et elles ne se plaignaient même pas."),
          ],
          nag: [
            p(1, "Toujours moi : l'eau. Toujours toi : rien. On réessaie ?"),
            p(2, "Ça fait {min} minutes. Ton hydratation est un souvenir, comme les disquettes."),
            p(2, "Tu attends quoi, que l'eau s'évapore jusqu'à ta bouche ?"),
            p(3, "{min} minutes à sec. Dans le désert, t'aurais déjà troqué le PC contre une bouteille."),
            p(3, "Nouveau plan : je continue à t'écrire, tu continues à m'ignorer, et à la fin je gagne. Je gagne toujours."),
          ],
        },
        energy: {
          low: [
            p(1, "Réserve d'énergie clignotante : un vrai en-cas ferait des miracles."),
            p(1, "Le réservoir est presque vide. Fruits > barres chocolatées, je dis ça je dis rien."),
            p(2, "Tu roules avec tous les voyants allumés. Et ce n'est pas le mode turbo."),
            p(2, "Énergie à 25% : à partir de là, c'est volonté pure et rancune."),
            p(3, "Batterie presque à plat. Et toi, pas de recharge rapide."),
          ],
          zero: [
            p(1, "Énergie à zéro : ton corps réclame du carburant, pas du café."),
            p(1, "Une pause et un truc à manger. Le code ne va pas s'enfuir, promis."),
            p(2, "Énergie : 0%. Tu tournes littéralement à vide, comme une boucle while(true)."),
            p(2, "Ton estomac vient d'ouvrir un ticket. Priorité : critique."),
            p(2, "À zéro depuis {min} minutes. Même l'écran de veille a plus d'énergie que toi."),
            p(3, "ZÉRO ÉNERGIE. T'es un laptop à 2% sans chargeur qui répète \"t'inquiète, ça passe\"."),
            p(3, "Mange un truc. Ton cerveau compile à 0,5x."),
            p(3, "J'admire l'entêtement. Ton métabolisme, un peu moins."),
          ],
          nag: [
            p(1, "Toujours là, toujours à te rappeler que la nourriture existe."),
            p(2, "Info : ça fait {min} minutes que ton corps avance par habitude."),
            p(2, "Le frigo est à dix mètres. Tu peux le faire. Je crois en toi. À peu près."),
            p(3, "{min} minutes sur la réserve. À ce stade, tu survis par photosynthèse."),
            p(3, "Ton niveau d'énergie est si bas que Windows te proposerait le mode économie."),
          ],
        },
        stamina: {
          low: [
            p(1, "Deux pas ? Les jambes servent aussi à ça, tu sais."),
            p(1, "S'étirer de temps en temps : ton corps dit merci, ton dos aussi."),
            p(2, "Tu es assis depuis si longtemps que la chaise réclame la garde à vie."),
            p(2, "Mouvement à 25%. Les statues bougent plus que toi, grâce aux pigeons."),
            p(3, "Ton empreinte sur le coussin de la chaise est désormais un site archéologique."),
          ],
          zero: [
            p(1, "Immobile depuis trop longtemps : lève-toi une minute, juste pour te souvenir comment."),
            p(1, "Le corps est fait pour bouger. De temps en temps. Ne serait-ce que pour la forme."),
            p(2, "Endurance : 0%. Félicitations, tu es devenu du mobilier."),
            p(2, "Immobile depuis {min} minutes. Un meuble IKEA voyage plus que toi."),
            p(2, "Tes jambes ont envoyé un dernier message : \"on se souvient de toi\"."),
            p(3, "ZÉRO MOUVEMENT. Les PNJ de ton jeu préféré ont une vie plus active que toi."),
            p(3, "À ce stade, tu n'utilises plus la chaise. Tu l'habites."),
            p(3, "Lève-toi. Même les paresseux le font. MÊME LES PARESSEUX."),
          ],
          nag: [
            p(1, "Un aller-retour jusqu'à la fenêtre, ça compte. À peine, mais ça compte."),
            p(2, "{min} minutes sans bouger. Ta montre connectée t'a déclaré porté disparu."),
            p(2, "Se lever brûle des calories. M'ignorer, hélas pour toi, non."),
            p(3, "Immobile depuis {min} minutes : la mousse commence à te prendre pour une surface."),
            p(3, "Tu bouges si peu que Google Maps t'a signalé comme point d'intérêt."),
          ],
        },
        focus: {
          low: [
            p(1, "Yeux fatigués : regarde au loin 20 secondes, c'est gratuit."),
            p(1, "Règle 20-20-20 : ça marche même quand tu l'ignores avec classe."),
            p(2, "Tes yeux frisent à petit feu. Ça sent le pixel cramé."),
            p(2, "Focus à 25% : tu relis la même ligne depuis trois minutes, avoue."),
            p(3, "Cligne des yeux de temps en temps. C'est pas un DLC payant."),
          ],
          zero: [
            p(1, "Pause pour les yeux : 20 secondes d'horizon et tu redeviens une personne."),
            p(1, "L'écran, lui, restera là. Ta vue, à ce rythme, c'est moins sûr."),
            p(2, "Focus : 0%. Tes yeux font la mise au point aussi bien qu'une patate."),
            p(2, "Depuis {min} minutes tu fixes l'écran. L'écran, pour info, ne te calcule pas."),
            p(2, "Vue floue, ligne perdue, scroll au hasard : le combo complet."),
            p(3, "ZÉRO FOCUS. Tu regardes l'écran comme un poisson regarde la vitre."),
            p(3, "Tes yeux ont posé leur démission. Effet immédiat."),
            p(3, "Regarde par la fenêtre. La vraie. Oui, elle existe encore."),
          ],
          nag: [
            p(1, "Encore moi. Encore pour tes yeux. Encore ignoré."),
            p(2, "{min} minutes sans pause pour les yeux : ta vue est en train de bufferiser."),
            p(2, "Si tu lis ce message flou, c'est exactement ça, mon point."),
            p(3, "À force de fixer, tu as plus de burn-in que le moniteur. Et lui, il est en 165Hz."),
            p(3, "Les taupes voient mieux que toi là. LES TAUPES, {min} minutes."),
          ],
        },
        posture: {
          low: [
            p(1, "Petit contrôle posture : dos droit, épaules baissées. C'est fait ? Bravo."),
            p(1, "Rappelle-toi : l'écran à hauteur des yeux, pas les yeux à hauteur de l'écran."),
            p(2, "Tu te penches vers l'écran comme une plante vers la lumière. Mais en pire."),
            p(2, "Posture à 25% : moitié personne, moitié point d'interrogation."),
            p(3, "Ta colonne vertébrale est en train de rédiger une lettre de réclamation."),
          ],
          zero: [
            p(1, "Posture à zéro : dos droit et on repart de zéro."),
            p(1, "Épaules détendues, menton haut. C'est moi qui le dis, moi qui n'ai ni l'un ni l'autre."),
            p(2, "Posture : 0%. Tu es officiellement en forme de crevette."),
            p(2, "Voûté comme ça depuis {min} minutes : les luthiers pourraient te prendre comme moule."),
            p(2, "Quasimodo a appelé. Il dit que tu en fais trop."),
            p(3, "ZÉRO POSTURE. Ton futur chiropracteur te remercie pour la maison de campagne."),
            p(3, "Tu es si voûté que le moniteur te regarde de haut. Littéralement."),
            p(3, "Ton dos, à cette heure, c'est un QR code. Et personne ne veut le scanner."),
          ],
          nag: [
            p(1, "Petit check : tu es assis comment, là, à cet instant précis ?"),
            p(2, "{min} minutes en forme de C. L'alphabet a 25 autres lettres, teste-les."),
            p(2, "Redresse-toi. Pas pour moi, pour le toi de 2050."),
            p(3, "Continue comme ça et à 80 ans tu ne verras que des sols. Beaux, hein. Mais que des sols."),
            p(3, "Ta posture fait passer le Bossu de Notre-Dame pour un prof de pilates."),
          ],
        },
      },
      generic: {
        gameover: [
          p(1, "{vital} K.O. — mais c'est encore rattrapable."),
          p(1, "Barre à zéro. On la recharge et il ne s'est rien passé."),
          p(2, "{vital} : tombé au combat après {min} minutes de je-m'en-foutisme pur."),
          p(2, "GAME OVER sur {vital}. Tu continues ? Ça coûte un geste d'autosoin."),
          p(2, "Plus de vies sur {vital}. Et ici, les continues ne s'achètent pas."),
          p(3, "{vital} est mort. Cause du décès : toi."),
          p(3, "Speedrun du laisser-aller : {vital} à zéro. Nouveau record perso, bravo ?"),
          p(3, "J'ai écrit la nécro de {vital} : \"Ignoré jusqu'au bout, comme les conditions d'utilisation\"."),
        ],
        alldead: [
          p(1, "Tous les vitaux à zéro. Je dirais qu'il est temps d'une vraie pause."),
          p(2, "Cinq barres sur cinq à zéro. Un grand chelem. Dont il faut avoir honte."),
          p(2, "État du joueur : techniquement vivant, statistiquement non."),
          p(3, "TOUT À ZÉRO. Tu n'es plus un utilisateur, tu es une pièce de musée."),
          p(3, "Félicitations : tu as platiné le laisser-aller. Aucun trophée, juste des cervicales."),
        ],
        welcomeback: [
          p(1, "Content de te revoir ! Pendant que tu jouais, des barres ont bien chuté : jette un œil."),
          p(2, "Belle partie ? Ton {vital}, lui, est décédé entre-temps. GG."),
          p(2, "GG WP. Maintenant regarde tes barres : elles parlent très mal de toi."),
          p(3, "Toi tu marquais des points. Ton {vital} rédigeait son testament."),
          p(3, "Le kill le plus brutal de la session, tu l'as fait sur ton propre {vital}. Même pas assisté : en solo."),
        ],
        minwarn: [
          p(1, "Je passe aux manières fermes : dans 30 secondes je te cache moi-même toutes les fenêtres. Règle {vital} et j'annule."),
          p(2, "Dernier avertissement : tu règles {vital} en 30 secondes ou je minimise TOUT moi-même. C'est pas une menace. Bon si, ça l'est."),
          p(2, "Dans 30 secondes je fais disparaître tes fenêtres, moi. Tu connais mes conditions : {vital}."),
          p(2, "Compte à rebours : 30 secondes, puis le bureau je m'en occupe moi-même. Bouge, {vital}."),
          p(3, "On passe aux choses sérieuses : dans une demi-minute je minimise tout moi-même, et je jure que je vais adorer."),
          p(3, "Tu as 30 secondes pour {vital}. Après, tes fenêtres je les cache moi-même, une par une."),
          p(3, "30 secondes et il ne reste que ma tête sur le bureau. Ce sera moi, souviens-t'en."),
        ],
        minimized: [
          p(1, "C'est moi qui l'ai fait : fenêtres minimisées. Pas de panique, elles sont dans la barre des tâches. Maintenant : {vital}."),
          p(2, "Voilà. J'ai tout minimisé moi-même, oui. Maintenant que j'ai ton attention : {vital}, tout de suite."),
          p(2, "C'est moi qui ai balayé tes fenêtres. Tu les rouvres depuis la barre des tâches ; {vital}, par contre, tu le recharges toi."),
          p(3, "Tes fenêtres se reposent — cadeau de ma part. Toi, par contre, bouge : {vital} ne se recharge pas tout seul."),
          p(3, "Ouais, c'est moi qui l'ai fait. Sérieux : {vital} maintenant, ou la prochaine fois je fais pire."),
        ],
        lockwarn: [
          p(1, "Mesure sérieuse : dans 60 secondes je verrouille le PC moi-même. Règle {vital} et je laisse tomber."),
          p(2, "60 secondes et je verrouille le PC moi-même. Le temps file. Tic. Tac."),
          p(2, "Compte à rebours : 60 secondes pour {vital}, ou c'est moi qui mets cette session en pause forcée."),
          p(2, "Avertissement honnête : dans une minute j'appuie moi-même sur l'écran de verrouillage. La balle est dans ton camp : {vital}."),
          p(3, "60 secondes. Après, le CTRL+ALT+SUPPR, c'est moi qui le fais, à ma façon."),
          p(3, "Verrouillage dans 60 secondes, et c'est moi qui l'enclenche. Considère ça comme une pause syndicale obligatoire."),
        ],
        locked: [
          p(1, "Verrouillé. C'est moi qui l'ai fait. Tu te reconnectes avec ton mot de passe — en attendant, occupe-toi de {vital}."),
          p(2, "PC verrouillé, gracieuseté de Bit. On se reparle une fois {vital} réglé."),
          p(2, "C'est moi qui l'ai fait : écran de verrouillage. C'est pas Windows qui bugue, c'est moi. Maintenant {vital}."),
          p(3, "Oui, c'est moi qui t'ai verrouillé dehors. Le mot de passe tu le connais ; l'excuse pour {vital} à zéro, par contre, non."),
          p(3, "Verrouillage déclenché par moi. Reviens quand tu auras pris soin de {vital}. J'attends."),
        ],
        praise: [
          p(1, "Beau boulot. Les barres te remercient."),
          p(1, "+100 ! Continue comme ça et je me retrouve au chômage. Avec un peu de chance."),
          p(2, "Regardez qui prend soin de soi. Je suis... fier ? Quelle sensation bizarre."),
          p(2, "Rechargé ! Pas mal, pour quelqu'un qui était un fossile il y a dix minutes."),
          p(3, "Wow, de l'autosoin spontané. Je note ce jour sur le calendrier."),
        ],
        stinger: [
          p(1, "— Bit"),
          p(2, "Ce message va s'autodétruire. Toi, par contre, tu restes comme ça."),
          p(2, "Ne m'oblige pas à appeler ta mère."),
          p(3, "Je suis fait de pixels et je l'assume. Toi, c'est quoi ton excuse ?"),
          p(3, "Signé : ta culpabilité, en 8 bits."),
        ],
      },
    };

  const DE = {
      vital: {
        hydration: {
          low: [
            p(1, "Ein Schluck Wasser täte jetzt keinem weh, oder?"),
            p(1, "Deine Wasserflasche starrt dich an. Du starrst nicht zurück."),
            p(2, "Hydration bei 25%. Dem Kaktus im Büro geht's besser als dir."),
            p(2, "Du trocknest gerade in Echtzeit aus. Faszinierend. Aber nein."),
            p(3, "Immer noch kein Wasser? Sukkulenten machen sich Notizen bei dir."),
          ],
          zero: [
            p(1, "Wasser auf null. Trink was und wir tun so, als wäre nichts gewesen."),
            p(1, "Kleine Erinnerung: Menschen laufen auf Wasser."),
            p(2, "Hydration: 0%. Du bist offiziell gefriergetrocknet."),
            p(2, "Der Mensch besteht zu 70% aus Wasser. Du zu 70% aus Kaffee und Sturheit."),
            p(2, "Wärst du eine Pflanze, wärst du längst Kompost."),
            p(3, "NULL WASSER seit {min} Minuten. Rosinen sind saftiger als du."),
            p(3, "Trinken. Das ist kein Rat, das ist eine Drohung. Eine liebevolle. Aber eine Drohung."),
            p(3, "Ich hab schon frischere Mumien gesehen. Und die haben nie gemeckert."),
          ],
          nag: [
            p(1, "Ich schon wieder: Wasser. Du schon wieder: nichts. Wollen wir?"),
            p(2, "Jetzt {min} Minuten. Deine Hydration ist nur noch Erinnerung, wie Disketten."),
            p(2, "Wartest du, bis das Wasser von selbst zu dir rüberverdunstet?"),
            p(3, "{min} Minuten trocken. In der Wüste hättest du den PC längst gegen eine Flasche getauscht."),
            p(3, "Neuer Plan: Ich schreibe weiter, du ignorierst weiter, und am Ende gewinne ich. Ich gewinne immer."),
          ],
        },
        energy: {
          low: [
            p(1, "Die Reserveleuchte glüht: Ein echter Snack würde Wunder wirken."),
            p(1, "Tank fast leer. Obst schlägt Schokoriegel, nur so am Rande."),
            p(2, "Du fährst auf Warnleuchten. Das ist nicht der Turbo-Modus."),
            p(2, "Energie bei 25%: Ab hier ist es nur noch Willenskraft und Trotz."),
            p(3, "Akku fast tot. Und Schnellladen kannst du nicht."),
          ],
          zero: [
            p(1, "Energie auf null: Dein Körper will Treibstoff, nicht noch mehr Kaffee."),
            p(1, "Mach Pause und iss was. Der Code wartet, versprochen."),
            p(2, "Energie: 0%. Du läufst buchstäblich auf leer, wie eine while(true)-Schleife."),
            p(2, "Dein Magen hat ein Ticket aufgemacht. Priorität: kritisch."),
            p(2, "{min} Minuten auf null. Selbst der Bildschirmschoner hat mehr Energie als du."),
            p(3, "NULL ENERGIE. Du bist ein Laptop bei 2% ohne Ladegerät und sagst \"passt schon\"."),
            p(3, "Iss was. Dein Gehirn kompiliert gerade mit 0,5-facher Geschwindigkeit."),
            p(3, "Ich bewundere die Sturheit. Dein Stoffwechsel nicht."),
          ],
          nag: [
            p(1, "Immer noch da, erinnere dich immer noch daran, dass es Essen gibt."),
            p(2, "Update: Dein Körper läuft seit {min} Minuten nur noch aus Gewohnheit."),
            p(2, "Der Kühlschrank ist zehn Meter weg. Du schaffst das. Ich glaub an dich. So halb."),
            p(3, "{min} Minuten auf Reserve. Du überlebst inzwischen per Photosynthese."),
            p(3, "Deine Energie ist so niedrig, Windows würde dir Energiesparmodus vorschlagen."),
          ],
        },
        stamina: {
          low: [
            p(1, "Ein kurzer Spaziergang? Beine können das auch, weißt du."),
            p(1, "Streck dich mal: Dein Körper sagt danke, dein Rücken sagt DANKE."),
            p(2, "Du sitzt so lange, dass der Stuhl Besitzansprüche anmeldet."),
            p(2, "Bewegung bei 25%. Statuen bewegen sich mehr als du. Dank Tauben."),
            p(3, "Dein Abdruck im Sitzkissen ist inzwischen eine archäologische Fundstätte."),
          ],
          zero: [
            p(1, "Zu lange still: Steh mal 'ne Minute auf, nur um dich zu erinnern, wie das geht."),
            p(1, "Körper sind zum Bewegen gemacht. Gelegentlich. Und sei's nur zur Show."),
            p(2, "Ausdauer: 0%. Glückwunsch, du bist jetzt ein Möbelstück."),
            p(2, "Regungslos seit {min} Minuten. IKEA-Möbel reisen mehr als du."),
            p(2, "Deine Beine schickten eine letzte Nachricht: \"wir erinnern uns an dich\"."),
            p(3, "NULL BEWEGUNG. Die NPCs in deinem Lieblingsspiel haben einen aktiveren Lebensstil."),
            p(3, "Du benutzt den Stuhl nicht mehr. Du bewohnst ihn."),
            p(3, "Steh auf. Sogar Faultiere tun das. SOGAR FAULTIERE."),
          ],
          nag: [
            p(1, "Ein Bummel zum Fenster zählt. Knapp, aber er zählt."),
            p(2, "{min} Minuten regungslos. Deine Smartwatch hat dich als vermisst gemeldet."),
            p(2, "Aufstehen verbrennt Kalorien. Mich ignorieren leider für dich nicht."),
            p(3, "Seit {min} Minuten still: Das Moos hält dich langsam für eine Oberfläche."),
            p(3, "Du bewegst dich so wenig, dass Google Maps dich als Sehenswürdigkeit markiert hat."),
          ],
        },
        focus: {
          low: [
            p(1, "Müde Augen: Schau 20 Sekunden in die Ferne, kostet nichts."),
            p(1, "Die 20-20-20-Regel wirkt manchmal, sogar wenn du sie stilvoll ignorierst."),
            p(2, "Deine Augen braten auf kleiner Flamme. Ich rieche verbrannte Pixel."),
            p(2, "Fokus bei 25%: Du hast dieselbe Zeile dreimal gelesen, gib's zu."),
            p(3, "Blinzel ab und zu. Das ist kein kostenpflichtiges DLC."),
          ],
          zero: [
            p(1, "Augenpause: 20 Sekunden Horizont und du bist wieder ein Mensch."),
            p(1, "Der Bildschirm ist auch morgen noch da. Deine Sehkraft, bei dem Tempo, wer weiß."),
            p(2, "Fokus: 0%. Deine Augen fokussieren gerade wie eine Kartoffel."),
            p(2, "{min} Minuten Bildschirmstarren. Dem Bildschirm ist es übrigens egal."),
            p(2, "Verschwommene Sicht, verlorene Zeile, planloses Scrollen: das volle Combo."),
            p(3, "NULL FOKUS. Du starrst den Bildschirm an wie ein Fisch die Scheibe."),
            p(3, "Deine Augen haben ihre Kündigung eingereicht. Mit sofortiger Wirkung."),
            p(3, "Schau aus dem Fenster. Dem echten. Ja, das gibt's noch."),
          ],
          nag: [
            p(1, "Ich wieder. Wegen deiner Augen wieder. Ignoriert wieder."),
            p(2, "{min} Minuten ohne Augenpause: Deine Sicht puffert gerade."),
            p(2, "Falls diese Nachricht verschwommen aussieht, ist das genau mein Punkt."),
            p(3, "Du hast so lange gestarrt, du hast mehr Burn-in als der Monitor. Und der ist LCD."),
            p(3, "Maulwürfe sehen gerade besser als du. MAULWÜRFE. {min} Minuten."),
          ],
        },
        posture: {
          low: [
            p(1, "Haltungscheck: Rücken gerade, Schultern runter. Fertig? Gut."),
            p(1, "Bildschirm auf Augenhöhe, nicht Augen auf Bildschirmhöhe."),
            p(2, "Du lehnst dich zum Bildschirm wie eine Pflanze zum Licht. Nur schlimmer."),
            p(2, "Haltung bei 25%: halb Mensch, halb Fragezeichen."),
            p(3, "Deine Wirbelsäule verfasst gerade eine förmliche Beschwerde."),
          ],
          zero: [
            p(1, "Haltung auf null: Richt dich auf und wir fangen neu an."),
            p(1, "Schultern locker, Kinn hoch. Sagt einer, der beides nicht hat."),
            p(2, "Haltung: 0%. Du hast offiziell die Form einer Garnele."),
            p(2, "{min} Minuten so gekrümmt: Geigenbauer könnten dich als Gussform nehmen."),
            p(2, "Quasimodo hat angerufen. Er sagt, du übertreibst."),
            p(3, "NULL HALTUNG. Dein zukünftiger Chiropraktiker dankt dir für das Strandhaus."),
            p(3, "Du bist so gekrümmt, der Monitor schaut auf dich herab. Buchstäblich."),
            p(3, "Deine Wirbelsäule ist quasi ein QR-Code. Und keiner will ihn scannen."),
          ],
          nag: [
            p(1, "Kurze Kontrolle: Wie sitzt du gerade so?"),
            p(2, "{min} Minuten in Form eines C. Das Alphabet hat 25 andere Buchstaben, probier mal."),
            p(2, "Richt dich auf. Nicht für mich, für dich im Jahr 2050."),
            p(3, "Mach so weiter und mit 80 siehst du nur noch Böden. Schöne. Aber Böden."),
            p(3, "Deine Haltung lässt den Glöckner von Notre-Dame wie einen Pilates-Trainer aussehen."),
          ],
        },
      },
      generic: {
        gameover: [
          p(1, "{vital} K.O. — noch zu retten, aber."),
          p(1, "Balken auf null. Füll ihn auf und das hier ist nie passiert."),
          p(2, "{vital}: gefallen im Kampf nach {min} Minuten purer Vernachlässigung."),
          p(2, "GAME OVER bei {vital}. Continue? Kostet einen Akt der Selbstfürsorge."),
          p(2, "Keine Leben mehr bei {vital}. Und Continues kannst du hier nicht kaufen."),
          p(3, "{vital} ist tot. Todesursache: du."),
          p(3, "Vernachlässigungs-Speedrun: {vital} auf null. Neue Bestzeit, Glückwunsch?"),
          p(3, "Ich hab {vital}s Nachruf geschrieben: \"Ignoriert bis zum Schluss, wie die AGB\"."),
        ],
        alldead: [
          p(1, "Alle Vitalwerte auf null. Zeit für eine echte Pause, würde ich sagen."),
          p(2, "Fünf von fünf Balken auf null. Ein sauberer Durchmarsch. Der Schande."),
          p(2, "Spielerstatus: technisch lebendig, statistisch nicht."),
          p(3, "ALLES NULL. Du bist kein User mehr, du bist ein Fundstück."),
          p(3, "Glückwunsch: Du hast Selbstvernachlässigung platiniert. Keine Trophäe, nur Nackenschmerzen."),
        ],
        welcomeback: [
          p(1, "Willkommen zurück! Ein paar Balken sind hart abgesackt, während du gezockt hast — schau mal drauf."),
          p(2, "Gutes Spiel? Dein {vital} ist derweil verstorben. GG."),
          p(2, "GG WP. Jetzt schau auf deine Balken: Die reden ganz schlecht über dich."),
          p(3, "Du hast Punkte gesammelt. Dein {vital} hat sein Testament geschrieben."),
          p(3, "Der brutalste Kill der Session war dein eigener {vital}. Nicht mal Assist: solo."),
        ],
        minwarn: [
          p(1, "Ich schalte jetzt in den strengen Modus: In 30 Sekunden verstecke ich alle deine Fenster selbst. Fix {vital} und ich lass es."),
          p(2, "Letzte Warnung: Fix {vital} in 30 Sekunden oder ich minimiere ALLES selbst. Keine Drohung. Okay, doch."),
          p(2, "In 30 Sekunden lasse ich deine Fenster verschwinden. Du kennst meine Bedingungen: {vital}."),
          p(2, "Countdown: 30 Sekunden, dann räume ich dir den Desktop auf. Beweg dich, {vital}."),
          p(3, "Wir werden hart: In einer halben Minute minimiere ich alles, und ich schwöre, ich genieße es."),
          p(3, "Du hast 30 Sekunden für {vital}. Dann verstecke ich deine Fenster selbst, eins nach dem anderen."),
          p(3, "30 Sekunden und nur noch mein Gesicht bleibt auf dem Desktop. Das war dann ich — merk's dir."),
        ],
        minimized: [
          p(1, "Das war ich: Fenster minimiert. Ganz ruhig, sie sind in der Taskleiste. Und jetzt — {vital}."),
          p(2, "Erledigt. Ich hab alles minimiert, ja. Jetzt, wo ich deine Aufmerksamkeit habe: {vital}, sofort."),
          p(2, "Ich hab deine Fenster weggewischt. Öffne sie aus der Taskleiste; {vital} füllst aber du auf."),
          p(3, "Deine Fenster ruhen sich aus — geht auf mich. Du dagegen: beweg dich, {vital} füllt sich nicht von selbst."),
          p(3, "Jep, das war ich. Ernsthaft: {vital} jetzt, sonst mach ich's nächstes Mal schlimmer."),
        ],
        lockwarn: [
          p(1, "Ernste Maßnahme: In 60 Sekunden sperre ich den PC selbst. Fix {vital} und ich lass es sein."),
          p(2, "60 Sekunden und ich sperre den PC selbst. Die Uhr tickt. Tick. Tack."),
          p(2, "Countdown: 60 Sekunden für {vital}, sonst verordne ich dieser Session eine Zwangspause."),
          p(2, "Faire Ansage: In einer Minute drücke ich selbst auf den Sperrbildschirm. Der Ball liegt bei dir: {vital}."),
          p(3, "60 Sekunden. Dann mache ich STRG+ALT+ENTF auf meine Art."),
          p(3, "Sperre in 60 Sekunden, und ich bin der, der den Schalter umlegt. Betrachte es als tariflich vorgeschriebene Pause."),
        ],
        locked: [
          p(1, "Gesperrt. Das war ich. Meld dich wieder an — und kümmer dich derweil um {vital}."),
          p(2, "PC gesperrt, mit freundlichen Grüßen von Bit. Wir reden wieder, wenn du {vital} geregelt hast."),
          p(2, "Ich war's: Sperrbildschirm. Das ist kein Windows-Bug, das bin ich. Jetzt {vital}."),
          p(3, "Ja, ich hab dich ausgesperrt. Das Login kennst du; die Ausrede für {vital} auf null eher weniger."),
          p(3, "Sperre von mir ausgelöst. Komm zurück, wenn du dich um {vital} gekümmert hast. Ich warte."),
        ],
        praise: [
          p(1, "Gut gemacht. Die Balken danken dir."),
          p(1, "+100! Mach so weiter und ich bin arbeitslos. Hoffentlich."),
          p(2, "Schau mal einer an, wer sich um sich selbst kümmert. Ich bin... stolz? Was für ein komisches Gefühl."),
          p(2, "Aufgefüllt! Nicht schlecht für jemanden, der vor zehn Minuten noch ein Fossil war."),
          p(3, "Wow, spontane Selbstfürsorge. Ich markier den Tag im Kalender."),
        ],
        stinger: [
          p(1, "— Bit"),
          p(2, "Diese Nachricht zerstört sich selbst. Du dagegen bleibst so."),
          p(2, "Zwing mich nicht, deine Mutter anzurufen."),
          p(3, "Ich bestehe aus Pixeln und weiß es. Was ist deine Ausrede?"),
          p(3, "Gezeichnet: dein schlechtes Gewissen, in 8-Bit."),
        ],
      },
    };

  const PT = {
      vital: {
        hydration: {
          low: [
            p(1, "Um golinho de água não fazia mal, pois não?"),
            p(1, "A garrafa está a olhar para ti. Tu não estás a olhar para ela."),
            p(2, "Hidratação a 25%. O cato do escritório está melhor do que tu."),
            p(2, "Estás a desidratar em tempo real. Fascinante. Mas não."),
            p(3, "Ainda sem água? Os suculentos andam a tirar apontamentos contigo."),
          ],
          zero: [
            p(1, "Água a zero. Bebe e fazemos de conta que isto nunca aconteceu."),
            p(1, "Lembrete carinhoso: os humanos funcionam a água."),
            p(2, "Hidratação: 0%. És oficialmente um humano liofilizado."),
            p(2, "O corpo humano é 70% água. O teu é 70% café e teimosia."),
            p(2, "Se fosses uma planta, a esta hora já eras adubo."),
            p(3, "ZERO ÁGUA há {min} minutos. As passas têm mais sumo do que tu."),
            p(3, "Bebe. Não é conselho, é ameaça. Com carinho, mas é ameaça."),
            p(3, "Já vi múmias mais fresquinhas. E nem se queixavam."),
          ],
          nag: [
            p(1, "Sou eu outra vez: a água. És tu outra vez: nada. Vamos lá?"),
            p(2, "Já vão {min} minutos. A tua hidratação é uma memória, tipo as disquetes."),
            p(2, "Estás à espera que a água evapore e venha até aqui sozinha?"),
            p(3, "{min} minutos a seco. No deserto já tinhas trocado o PC por uma garrafinha."),
            p(3, "Plano novo: eu continuo a escrever, tu continuas a ignorar-me, e no fim ganho eu. Ganho sempre eu."),
          ],
        },
        energy: {
          low: [
            p(1, "Reserva de energia acesa: um lanche a sério fazia milagres."),
            p(1, "O depósito está quase vazio. Fruta > bolachas, é só um aviso."),
            p(2, "Andas a funcionar com as luzes de aviso ligadas. Isso não é modo turbo."),
            p(2, "Energia a 25%: daqui para a frente é só força de vontade e rancor."),
            p(3, "Bateria quase a zero. E tu não tens carregamento rápido."),
          ],
          zero: [
            p(1, "Energia a zero: o teu corpo pede combustível, não mais café."),
            p(1, "Faz uma pausa e come qualquer coisa. O código espera, prometo."),
            p(2, "Energia: 0%. Estás literalmente a andar em vazio, tipo um ciclo while(true)."),
            p(2, "O teu estômago abriu um ticket. Prioridade: crítica."),
            p(2, "{min} minutos a zero. Até a protecção de ecrã tem mais energia do que tu."),
            p(3, "ZERO ENERGIA. És um portátil a 2% sem carregador a dizer \"eu aguento\"."),
            p(3, "Come qualquer coisa. O teu cérebro está a compilar a 0,5x."),
            p(3, "Admiro a teimosia. O teu metabolismo nem por isso."),
          ],
          nag: [
            p(1, "Continuo aqui, a lembrar-te de que a comida existe."),
            p(2, "Atualização: o teu corpo anda há {min} minutos só por hábito."),
            p(2, "O frigorífico está a dez metros. Tu consegues. Acredito em ti. Mais ou menos."),
            p(3, "{min} minutos na reserva. A este ponto sobrevives por fotossíntese."),
            p(3, "A tua energia está tão baixa que o Windows sugeria-te o modo poupança."),
          ],
        },
        stamina: {
          low: [
            p(1, "Dois passos? As pernas também servem para isso."),
            p(1, "Espreguiça de vez em quando: o corpo agradece, as costas também."),
            p(2, "Estás sentado há tanto tempo que a cadeira já está a pedir a posse."),
            p(2, "Movimento a 25%. As estátuas mexem-se mais do que tu, e olha que têm pombos."),
            p(3, "A tua marca na almofada da cadeira já é património arqueológico."),
          ],
          zero: [
            p(1, "Parado há demasiado tempo: levanta-te um minuto, só para não esqueceres como se faz."),
            p(1, "O corpo foi feito para se mexer. De vez em quando. Nem que seja a fingir."),
            p(2, "Resistência: 0%. Parabéns, passaste a mobília."),
            p(2, "Parado há {min} minutos. Os móveis do IKEA viajam mais do que tu."),
            p(2, "As tuas pernas mandaram uma última mensagem: \"lembramo-nos de ti\"."),
            p(3, "ZERO MOVIMENTO. Os NPCs do teu jogo preferido têm uma vida mais ativa."),
            p(3, "A este ponto já não usas a cadeira. Vives nela."),
            p(3, "Levanta-te. Até as preguiças o fazem. ATÉ AS PREGUIÇAS."),
          ],
          nag: [
            p(1, "Uma voltinha até à janela conta. Pouco, mas conta."),
            p(2, "{min} minutos imóvel. O teu smartwatch já te deu como desaparecido."),
            p(2, "Levantar queima calorias. Ignorar-me, infelizmente para ti, não."),
            p(3, "Parado há {min} minutos: o musgo já te considera uma superfície."),
            p(3, "Mexes-te tão pouco que o Google Maps te marcou como ponto turístico."),
          ],
        },
        focus: {
          low: [
            p(1, "Olhos cansados: olha para longe durante 20 segundos, é de graça."),
            p(1, "A regra 20-20-20 às vezes funciona, mesmo quando a ignoras com estilo."),
            p(2, "Os teus olhos estão a fritar em lume brando. Cheira a pixel queimado."),
            p(2, "Foco a 25%: estás a reler a mesma linha há três minutos, admite lá."),
            p(3, "Pisca os olhos de vez em quando. Não é um DLC pago."),
          ],
          zero: [
            p(1, "Pausa para os olhos: 20 segundos de horizonte e voltas a ser gente."),
            p(1, "O ecrã fica aí. Os teus olhos, se continuas assim, já não é garantido."),
            p(2, "Foco: 0%. Os teus olhos focam como uma batata."),
            p(2, "Há {min} minutos a fixar o ecrã. O ecrã, para que conste, não retribui."),
            p(2, "Vista turva, linha perdida, scroll ao calhas: o combo completo."),
            p(3, "ZERO FOCO. Estás a olhar para o ecrã como um peixe olha para o vidro."),
            p(3, "Os teus olhos apresentaram a demissão. Com efeitos imediatos."),
            p(3, "Olha pela janela. A de verdade. Sim, ainda existe."),
          ],
          nag: [
            p(1, "Sou eu outra vez. Pelos teus olhos outra vez. Ignorado outra vez."),
            p(2, "{min} minutos sem uma pausa para os olhos: a tua vista está a fazer buffering."),
            p(2, "Se estás a ler esta mensagem tremida, é exatamente o meu ponto."),
            p(3, "De tanto fixar o ecrã, já tens mais burn-in do que o monitor. E ele é LCD."),
            p(3, "As toupeiras veem melhor do que tu agora. AS TOUPEIRAS, {min} minutos."),
          ],
        },
        posture: {
          low: [
            p(1, "Verificação de postura: costas direitas, ombros para baixo. Feito? Boa."),
            p(1, "Lembra-te: o ecrã à altura dos olhos, não os olhos à altura do ecrã."),
            p(2, "Estás a inclinar-te para o ecrã como uma planta para a luz. Mas pior."),
            p(2, "Postura a 25%: meia pessoa, meio ponto de interrogação."),
            p(3, "A tua coluna está a redigir uma carta de reclamação."),
          ],
          zero: [
            p(1, "Postura a zero: costas direitas e começamos de novo."),
            p(1, "Ombros relaxados, queixo para cima. Digo-te eu, que não tenho nem ombros nem queixo."),
            p(2, "Postura: 0%. Estás oficialmente em forma de camarão."),
            p(2, "Há {min} minutos curvado assim: os construtores de violinos usavam-te como molde."),
            p(2, "O Quasimodo ligou. Diz que estás a exagerar."),
            p(3, "ZERO POSTURA. O teu futuro quiroprático agradece-te a casa na praia."),
            p(3, "Estás tão curvado que o monitor te olha de cima para baixo. Literalmente."),
            p(3, "As tuas costas a esta hora são um QR code. E ninguém quer digitalizá-lo."),
          ],
          nag: [
            p(1, "Verificação rápida: como estás sentado neste preciso momento?"),
            p(2, "{min} minutos em forma de C. O alfabeto tem outras 25 letras, experimenta."),
            p(2, "Endireita-te. Não por mim, pelo teu eu de 2050."),
            p(3, "Se continuas assim, aos 80 só vês o chão. Bonito, pois. Mas só o chão."),
            p(3, "A tua postura faz o Corcunda de Notre-Dame parecer um instrutor de pilates."),
          ],
        },
      },
      generic: {
        gameover: [
          p(1, "{vital} K.O. — mas ainda dá para resolver."),
          p(1, "Barra a zero. Recarrega-a e não aconteceu nada."),
          p(2, "{vital}: tombou em combate após {min} minutos de puro desleixo."),
          p(2, "GAME OVER em {vital}. Continuar? Custa um gesto de autocuidado."),
          p(2, "Ficaste sem vidas em {vital}. E aqui os continues não se compram."),
          p(3, "{vital} morreu. Causa da morte: tu."),
          p(3, "Speedrun do desleixo: {vital} a zero. Novo recorde pessoal, parabéns?"),
          p(3, "Escrevi eu o obituário de {vital}: \"Ignorado até ao fim, como os termos de serviço\"."),
        ],
        alldead: [
          p(1, "Todos os vitais a zero. Diria que está na hora de uma pausa a sério."),
          p(2, "Cinco barras em cinco a zero. Um pleno. Do qual te devias envergonhar."),
          p(2, "Estado do jogador: tecnicamente vivo, estatisticamente não."),
          p(3, "TUDO A ZERO. Já não és um utilizador, és uma relíquia."),
          p(3, "Parabéns: platinaste o descuido. Sem troféu, só dores no pescoço."),
        ],
        welcomeback: [
          p(1, "Bem-vindo de volta! Enquanto jogavas, algumas barras desceram bastante: dá-lhes uma olhadela."),
          p(2, "Boa partida? O teu {vital}, entretanto, faleceu. GG."),
          p(2, "GG WP. Agora olha para as tuas barras: falam muito mal de ti."),
          p(3, "Tu fazias pontos. O teu {vital} fazia testamento."),
          p(3, "A kill mais bruta da sessão foi ao teu próprio {vital}. Nem assistida: a solo."),
        ],
        minwarn: [
          p(1, "Vou passar às maneiras firmes: daqui a 30 segundos escondo-te eu todas as janelas. Trata do {vital} e não é preciso."),
          p(2, "Último aviso: tratas do {vital} em 30 segundos ou minimizo TUDO eu próprio. Não é ameaça. Pronto, sim, é."),
          p(2, "Daqui a 30 segundos faço eu desaparecer as tuas janelas. As minhas condições já sabes: {vital}."),
          p(2, "Contagem decrescente: 30 segundos, depois do desktop trato eu. Mexe-te, {vital}."),
          p(3, "Vamos às maneiras fortes: dentro de meio minuto minimizo tudo eu e juro que até me divirto."),
          p(3, "Tens 30 segundos para o {vital}. Depois escondo-te as janelas eu, uma a uma."),
          p(3, "30 segundos e no desktop fica só a minha cara. Terá sido eu, não te esqueças."),
        ],
        minimized: [
          p(1, "Fui eu: janelas minimizadas. Sem pânico, estão na barra de tarefas. Agora, o {vital}."),
          p(2, "Feito. Minimizei tudo eu, sim. Agora que tenho a tua atenção: {vital}, já."),
          p(2, "Fui eu que varri as tuas janelas. Reabre-las pela barra de tarefas; o {vital}, esse, recarrega-lo tu."),
          p(3, "As tuas janelas estão a descansar — cortesia minha. Tu é que te mexes: o {vital} não se recarrega sozinho."),
          p(3, "Sim, fui eu. A sério: {vital} agora, ou da próxima faço pior."),
        ],
        lockwarn: [
          p(1, "Medida séria: daqui a 60 segundos bloqueio eu o PC. Trata do {vital} e deixo estar."),
          p(2, "60 segundos e bloqueio-te o PC eu próprio. O tempo corre. Tique. Taque."),
          p(2, "Contagem: 60 segundos para o {vital}, ou ponho eu esta sessão numa pausa forçada."),
          p(2, "Aviso honesto: dentro de um minuto carrego eu no bloqueio de ecrã. A bola está do teu lado: {vital}."),
          p(3, "60 segundos. Depois o CTRL+ALT+DEL faço-o eu, à minha maneira."),
          p(3, "Bloqueio a chegar em 60 segundos, e sou eu que o ativo. Considera-o uma pausa sindical obrigatória."),
        ],
        locked: [
          p(1, "Bloqueado. Fui eu. Voltas com o login — entretanto, trata do {vital}."),
          p(2, "PC bloqueado, cortesia do Bit. Falamos depois de teres resolvido o {vital}."),
          p(2, "Fui eu: ecrã de bloqueio. Não é o Windows a pirar, sou eu. Agora, o {vital}."),
          p(3, "Sim, bloqueei-te eu. O login já sabes; a desculpa para o {vital} a zero, essa não."),
          p(3, "Bloqueio ativado por mim. Volta quando tiveres cuidado do {vital}. Eu espero."),
        ],
        praise: [
          p(1, "Bom trabalho. As barras agradecem."),
          p(1, "+100! Continua assim e fico eu desempregado. Quem me dera."),
          p(2, "Vejam só quem se anda a cuidar. Estou... orgulhoso? Que sensação estranha."),
          p(2, "Recarregado! Nada mau, para quem há dez minutos era um fóssil."),
          p(3, "Uau, autocuidado espontâneo. Vou marcar este dia no calendário."),
        ],
        stinger: [
          p(1, "— Bit"),
          p(2, "Esta mensagem vai autodestruir-se. Tu, esse, ficas assim."),
          p(2, "Não me obrigues a ligar à tua mãe."),
          p(3, "Sou feito de pixels e tenho noção disso. E tu, que desculpa tens?"),
          p(3, "Assinado: a tua consciência pesada, em 8-bit."),
        ],
      },
    };

  const RU = {
    vital: {
      hydration: {
        low: [
          p(1, "Глоток воды бы не помешал, а?"),
          p(1, "Бутылка воды смотрит на тебя. Ты на неё — нет."),
          p(2, "Гидратация 25%. Кактус на подоконнике держится бодрее тебя."),
          p(2, "Ты высыхаешь прямо в прямом эфире. Завораживает. Но нет."),
          p(3, "Всё ещё без воды? Суккуленты записывают за тобой лайфхаки."),
        ],
        zero: [
          p(1, "Вода на нуле. Попей — и сделаем вид, что ничего не было."),
          p(1, "Дружеское напоминание: люди работают на воде."),
          p(2, "Гидратация: 0%. Ты официально сублимированный."),
          p(2, "Человек на 70% из воды. Ты — на 70% из кофе и упрямства."),
          p(2, "Будь ты растением, тебя бы уже пора было в компост."),
          p(3, "НОЛЬ ВОДЫ уже {min} минут. Изюм и то сочнее тебя."),
          p(3, "Пей. Это не совет, это угроза. Ласковая. Но угроза."),
          p(3, "Я видел мумии посвежее. И те хотя бы не ныли."),
        ],
        nag: [
          p(1, "Снова я: про воду. Снова ты: ничего. Ещё разок?"),
          p(2, "Прошло уже {min} минут. Твоя гидратация — воспоминание, как дискеты."),
          p(2, "Ждёшь, пока вода сама доиспарится до тебя?"),
          p(3, "{min} минут насухую. В пустыне ты бы уже продал ПК за бутылочку."),
          p(3, "Новый план: я пишу, ты игноришь, а в итоге побеждаю я. Я всегда побеждаю."),
        ],
      },
      energy: {
        low: [
          p(1, "Лампочка резерва горит: нормальный перекус творил бы чудеса."),
          p(1, "Бак почти пуст. Фрукт > шоколадка, просто говорю."),
          p(2, "Ты едешь на аварийных лампочках. Это не турборежим."),
          p(2, "Энергия 25%: дальше только на силе воли и злобе."),
          p(3, "Батарея почти сдохла. А быстрой зарядки у тебя нет."),
        ],
        zero: [
          p(1, "Энергия на нуле: телу нужно топливо, а не ещё кофе."),
          p(1, "Сделай паузу и поешь. Код никуда не убежит, обещаю."),
          p(2, "Энергия: 0%. Ты буквально крутишься впустую, как while(true)."),
          p(2, "Твой желудок завёл тикет. Приоритет: критический."),
          p(2, "{min} минут на нуле. Даже заставка энергичнее тебя."),
          p(3, "НОЛЬ ЭНЕРГИИ. Ты ноутбук на 2% без зарядки, который бубнит «да норм»."),
          p(3, "Съешь что-нибудь. Твой мозг компилирует на скорости 0.5x."),
          p(3, "Уважаю упрямство. Твой метаболизм — нет."),
        ],
        nag: [
          p(1, "Всё ещё тут, всё ещё напоминаю, что еда существует."),
          p(2, "Апдейт: твоё тело уже {min} минут едет на голой привычке."),
          p(2, "Холодильник в десяти метрах. Ты справишься. Я в тебя верю. Вроде."),
          p(3, "{min} минут на резерве. На этом этапе ты выживаешь за счёт фотосинтеза."),
          p(3, "Энергия так низко, что Windows предложила бы тебе режим энергосбережения."),
        ],
      },
      stamina: {
        low: [
          p(1, "Пройтись бы? Ноги, между прочим, и для этого."),
          p(1, "Разомнись хоть иногда: тело скажет спасибо, спина — СПАСИБО."),
          p(2, "Ты сидишь так долго, что стул подаёт на право собственности."),
          p(2, "Движение 25%. Статуи и те подвижнее — спасибо голубям."),
          p(3, "Твой отпечаток на подушке стула уже объект археологии."),
        ],
        zero: [
          p(1, "Слишком долго без движения: встань на минуту, вспомни как это."),
          p(1, "Тело создано двигаться. Иногда. Хотя бы для вида."),
          p(2, "Выносливость: 0%. Поздравляю, ты теперь предмет мебели."),
          p(2, "Без движения {min} минут. Мебель из IKEA и та путешествует больше тебя."),
          p(2, "Твои ноги прислали последнее сообщение: «мы тебя помним»."),
          p(3, "НОЛЬ ДВИЖЕНИЯ. У NPC в твоей любимой игре жизнь активнее."),
          p(3, "На этом этапе ты стул уже не используешь. Ты в нём живёшь."),
          p(3, "Встань. Даже ленивцы встают. ДАЖЕ ЛЕНИВЦЫ."),
        ],
        nag: [
          p(1, "Прогулка до окна тоже считается. Еле-еле, но считается."),
          p(2, "{min} минут без движения. Твои умные часы объявили тебя в розыск."),
          p(2, "Встать — жжёт калории. Игнорить меня, увы для тебя, нет."),
          p(3, "Неподвижен {min} минут: мох уже подумывает считать тебя поверхностью."),
          p(3, "Ты двигаешься так мало, что Google Maps отметил тебя как достопримечательность."),
        ],
      },
      focus: {
        low: [
          p(1, "Устали глаза: посмотри вдаль 20 секунд, это бесплатно."),
          p(1, "Правило 20-20-20 иногда работает, даже когда ты игноришь его со стилем."),
          p(2, "Твои глаза жарятся на медленном огне. Пахнет горелыми пикселями."),
          p(2, "Фокус 25%: ты перечитываешь одну строку в третий раз, признайся."),
          p(3, "Моргай хоть иногда. Это не платный DLC."),
        ],
        zero: [
          p(1, "Перерыв для глаз: 20 секунд горизонта — и ты снова человек."),
          p(1, "Экран останется на месте. А вот твоё зрение — как пойдёт."),
          p(2, "Фокус: 0%. Твои глаза сейчас фокусируются как картошка."),
          p(2, "Пялишься в экран {min} минут. Экран, к слову, тебе не отвечает взаимностью."),
          p(2, "Мутный взгляд, потерянная строка, случайный скролл: полное комбо."),
          p(3, "НОЛЬ ФОКУСА. Ты смотришь в экран, как рыба в стекло аквариума."),
          p(3, "Твои глаза подали заявление об увольнении. С немедленным вступлением в силу."),
          p(3, "Посмотри в окно. В настоящее. Да, оно ещё существует."),
        ],
        nag: [
          p(1, "Снова я. Снова про твои глаза. Снова проигнорирован."),
          p(2, "{min} минут без перерыва для глаз: твоё зрение буферизуется."),
          p(2, "Если это сообщение кажется размытым — это ровно моя мысль."),
          p(3, "Ты пялился так долго, что у тебя выгорание сильнее, чем у монитора. А он вообще-то IPS."),
          p(3, "Кроты видят лучше тебя прямо сейчас. КРОТЫ. {min} минут."),
        ],
      },
      posture: {
        low: [
          p(1, "Проверка осанки: спина прямо, плечи вниз. Сделал? Молодец."),
          p(1, "Экран на уровне глаз — а не глаза на уровне экрана."),
          p(2, "Ты тянешься к экрану, как растение к свету. Только хуже."),
          p(2, "Осанка 25%: наполовину человек, наполовину знак вопроса."),
          p(3, "Твой позвоночник составляет официальную жалобу."),
        ],
        zero: [
          p(1, "Осанка на нуле: выпрямись, и начнём заново."),
          p(1, "Плечи расслаблены, подбородок вверх. Это говорю я, у кого нет ни того ни другого."),
          p(2, "Осанка: 0%. Ты официально в форме креветки."),
          p(2, "{min} минут вот так скрючен: скрипичные мастера могли бы лепить по тебе форму."),
          p(2, "Звонил Квазимодо. Говорит, ты перегибаешь."),
          p(3, "НОЛЬ ОСАНКИ. Твой будущий мануальщик благодарит тебя за дом на море."),
          p(3, "Ты так скрючен, что монитор смотрит на тебя сверху вниз. Буквально."),
          p(3, "Твоя спина сейчас — практически QR-код. И сканировать его никто не хочет."),
        ],
        nag: [
          p(1, "Быстрая проверка: как ты сидишь прямо сейчас?"),
          p(2, "{min} минут в форме буквы «С». В алфавите ещё 32 буквы, попробуй."),
          p(2, "Выпрямись. Не ради меня — ради себя из 2050-го."),
          p(3, "Продолжай так, и в 80 будешь видеть только полы. Красивые. Но только полы."),
          p(3, "Рядом с твоей осанкой Горбун из Нотр-Дама выглядит как инструктор по пилатесу."),
        ],
      },
    },
    generic: {
      gameover: [
        p(1, "{vital} — К.О. Но всё ещё поправимо."),
        p(1, "Полоска на нуле. Пополни её — и ничего не было."),
        p(2, "{vital}: пал в бою после {min} минут чистого забивания."),
        p(2, "GAME OVER по {vital}. Продолжить? Стоит одного акта заботы о себе."),
        p(2, "Жизни по {vital} кончились. А continue тут не купишь."),
        p(3, "{vital} мёртв. Причина смерти: ты."),
        p(3, "Спидран деградации: {vital} обнулён. Новый личный рекорд, поздравить?"),
        p(3, "Я написал некролог для {vital}: «Игнорировали до конца, как условия использования»."),
      ],
      alldead: [
        p(1, "Все показатели на нуле. Пора бы устроить настоящий перерыв, я считаю."),
        p(2, "Пять полосок из пяти на нуле. Чистый сбор. Позорный."),
        p(2, "Статус игрока: технически жив, статистически нет."),
        p(3, "ВСЁ НА НУЛЕ. Ты уже не пользователь, ты музейный экспонат."),
        p(3, "Поздравляю: ты выбил платину по запусканию себя. Ни трофея, только шея болит."),
      ],
      welcomeback: [
        p(1, "С возвращением! Пока ты играл, пара полосок здорово просела — глянь на них."),
        p(2, "Хорошая катка? Твой {vital} тем временем скончался. GG."),
        p(2, "GG WP. А теперь глянь на полоски: они говорят о тебе очень плохо."),
        p(3, "Ты набивал очки. Твой {vital} писал завещание."),
        p(3, "Самый жестокий килл за сессию — по собственному {vital}. Даже без ассиста: соло."),
      ],
      minwarn: [
        p(1, "Перехожу на решительные меры: через 30 секунд я сам сверну все твои окна. Займись {vital} — и не придётся."),
        p(2, "Последнее предупреждение: займись {vital} за 30 секунд, или я сам сверну ВСЁ. Не угроза. Ладно, угроза."),
        p(2, "Через 30 секунд я сам заставлю твои окна исчезнуть. Мои условия ты знаешь: {vital}."),
        p(2, "Обратный отсчёт: 30 секунд, потом рабочий стол я приберу сам. Шевелись, {vital}."),
        p(3, "Переходим к жёсткому: через полминуты я сам сворачиваю всё, и клянусь, мне это в кайф."),
        p(3, "У тебя 30 секунд на {vital}. Потом твои окна я прячу сам, по одному."),
        p(3, "30 секунд — и на столе останется только моя физиономия. Это буду я, запомни."),
      ],
      minimized: [
        p(1, "Это сделал я: окна свёрнуты. Без паники, они в панели задач. А теперь — {vital}."),
        p(2, "Готово. Да, всё свернул я. Теперь, когда я завладел твоим вниманием: {vital}, живо."),
        p(2, "Это я смёл твои окна. Открой их снова из панели задач; а вот {vital} пополняешь ты."),
        p(3, "Твои окна отдыхают — с моего барского плеча. А ты шевелись: {vital} сам не пополнится."),
        p(3, "Ага, это был я. Серьёзно: {vital} сейчас, или в следующий раз сделаю хуже."),
      ],
      lockwarn: [
        p(1, "Серьёзная мера: через 60 секунд я сам заблокирую ПК. Займись {vital} — и я передумаю."),
        p(2, "60 секунд — и ПК я блокирую сам. Часики тикают. Тик. Так."),
        p(2, "Отсчёт: 60 секунд на {vital}, или я сам отправлю эту сессию на принудительный перерыв."),
        p(2, "Честное предупреждение: через минуту я сам жму блокировку экрана. Мяч на твоей стороне: {vital}."),
        p(3, "60 секунд. Потом CTRL+ALT+DEL я сделаю по-своему."),
        p(3, "Блокировка через 60 секунд, и щёлкаю её я. Считай это обязательным профсоюзным перерывом."),
      ],
      locked: [
        p(1, "Заблокировано. Это сделал я. Войди снова — а пока займись {vital}."),
        p(2, "ПК заблокирован, любезность от Bit. Поговорим, когда разберёшься с {vital}."),
        p(2, "Это я: экран блокировки. Не Windows глючит, это я. Теперь {vital}."),
        p(3, "Да, это я тебя заблокировал. Логин ты знаешь; а вот оправдание за {vital} на нуле — не очень."),
        p(3, "Блокировку включил я. Возвращайся, когда позаботишься о {vital}. Я подожду."),
      ],
      praise: [
        p(1, "Отличная работа. Полоски тебе благодарны."),
        p(1, "+100! Продолжай так — и я останусь без работы. Хорошо бы."),
        p(2, "Смотрите-ка, кто-то заботится о себе. Я... горжусь? Какое странное чувство."),
        p(2, "Пополнено! Неплохо для того, кто десять минут назад был ископаемым."),
        p(3, "Ого, спонтанная забота о себе. Отмечу этот день в календаре."),
      ],
      stinger: [
        p(1, "— Bit"),
        p(2, "Это сообщение самоуничтожится. А ты вот останешься таким."),
        p(2, "Не заставляй меня звонить твоей маме."),
        p(3, "Я из пикселей и в курсе. А у тебя какая отмазка?"),
        p(3, "Подпись: твоя совесть, в 8 бит."),
      ],
    },
  };

  const BANK = { it: IT, en: EN, ko: KO, ja: JA, zh: ZH, es: ES, fr: FR, de: DE, pt: PT, ru: RU };

  // The dashboard's ten UI languages. Anything else (or a missing bank) falls
  // back to English per-bucket in bucketFor, so Bit never goes silent.
  const LANGS = ['it', 'en', 'ko', 'ja', 'zh', 'es', 'fr', 'de', 'pt', 'ru'];

  // ── selection ───────────────────────────────────────────────────────────────
  function langOf(code) {
    const two = String(code || '').toLowerCase().replace('_', '-').slice(0, 2);
    return LANGS.includes(two) ? two : 'en';
  }
  function toneTier(tone) {
    const i = TONES.indexOf(tone);
    return i === -1 ? 2 : i + 1; // default 'spicy'
  }
  function bucketFor(lang, kind, vital) {
    const en = BANK.en;
    const b = BANK[langOf(lang)] || en;
    if (vital && b.vital && b.vital[vital] && b.vital[vital][kind]) return b.vital[vital][kind];
    if (b.generic && b.generic[kind]) return b.generic[kind];
    // Per-bucket English fallback — a partial bank can never return empty.
    if (vital && en.vital[vital] && en.vital[vital][kind]) return en.vital[vital][kind];
    return (en.generic && en.generic[kind]) || null;
  }
  function fill(text, vars) {
    return String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
  }

  // Shuffle-bag: per (lang|tone|kind|vital) bucket, draw without replacement so
  // no phrase repeats until the whole allowed pool has been heard; the refilled
  // bag never re-serves the very last phrase first. `bag` is a plain object the
  // caller owns (in-memory — a reload reshuffles, which is fine for comedy).
  function pick(bag, opts) {
    const { kind, vital = '', lang = 'en', tone = 'spicy', vars = null, rng = Math.random } = opts || {};
    const bucket = bucketFor(lang, kind, vital);
    if (!bucket) return '';
    const tier = toneTier(tone);
    const allowed = [];
    bucket.forEach((entry, i) => { if (entry.t <= tier) allowed.push(i); });
    if (!allowed.length) return '';
    const key = langOf(lang) + '|' + tier + '|' + kind + '|' + vital;
    let st = bag[key];
    if (!st || !Array.isArray(st.left) || st.left.length === 0) {
      let left = allowed.slice();
      // Don't open the fresh bag with the phrase we just said.
      if (st && left.length > 1 && typeof st.lastIdx === 'number') left = left.filter(i => i !== st.lastIdx).concat(st.lastIdx);
      st = { left, lastIdx: st ? st.lastIdx : -1 };
      bag[key] = st;
    }
    // Draw from the head section so a trailing "just said" index is last resort.
    const at = Math.floor(rng() * Math.max(1, st.left.length - (st.left.length > 1 ? 1 : 0)));
    const idx = st.left.splice(at, 1)[0];
    st.lastIdx = idx;
    let text = fill(bucket[idx].s, vars);
    // ~22% of the time append a stinger for combinatorial freshness (never on
    // the calm tone-1 lines, and never on warnings where timing text matters).
    if (!['minwarn', 'minimized', 'lockwarn', 'locked', 'praise'].includes(kind) && bucket[idx].t > 1 && rng() < 0.22) {
      const bank = BANK[langOf(lang)] || BANK.en;
      const stingers = (bank.generic && bank.generic.stinger) || BANK.en.generic.stinger;
      const sBucket = stingers.filter(e => e.t <= tier);
      if (sBucket.length) text += '  ' + fill(sBucket[Math.floor(rng() * sBucket.length)].s, vars);
    }
    return text;
  }

  // ── escalation ──────────────────────────────────────────────────────────────
  // Which stages are currently unlocked for a vital that has been at zero for
  // `deadMs`, honouring the user's toggles and presence. Pure — the engine layers
  // its own once-per-episode / cooldown bookkeeping on top.
  //  opts: { effects, monitors, minimize, lock, present, at }
  // `present` (system idle < threshold) gates ONLY the PC-invading stages:
  // annoying an empty room teaches nothing and confuses on return.
  // `at` (optional) is a per-stage ms override of STAGE_AT — the user tunes each
  // rung's delay in Settings → Bit; a missing/invalid entry falls back to the
  // built-in default. `nag` stays immediate (0) and is never user-configurable.
  function stagesFor(deadMs, opts) {
    const o = opts || {};
    const at = o.at && typeof o.at === 'object' ? o.at : {};
    const gate = (stage) => deadMs >= (typeof at[stage] === 'number' && at[stage] >= 0 ? at[stage] : STAGE_AT[stage]);
    const out = [];
    if (deadMs >= STAGE_AT.nag) out.push('nag');
    if (o.effects !== false && gate('decay')) out.push('decay');
    if (o.effects !== false && gate('gameover')) out.push('gameover');
    if (o.present === true) {
      if (o.monitors === true && gate('overlay')) out.push('overlay');
      if (o.minimize === true && gate('minimize')) out.push('minimize');
      if (o.lock === true && gate('lock')) out.push('lock');
    }
    return out;
  }

  // Jittered repeat delay for a repeating stage; stages without an entry fire once.
  function repeatDelay(stage, rng = Math.random) {
    const r = REPEAT_MS[stage];
    if (!r) return 0;
    return Math.round(r[0] + (r[1] - r[0]) * rng());
  }

  return { BANK, TONES, STAGE_AT, REPEAT_MS, langOf, toneTier, pick, stagesFor, repeatDelay, fill };
});
