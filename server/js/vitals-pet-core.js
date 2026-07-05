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
        p(2, 'Ultimo avviso: sistemi {vital} entro 30 secondi o minimizzo TUTTO. Non è una minaccia. Ok sì, lo è.'),
        p(2, 'Tra 30 secondi le tue finestre spariscono. Le mie condizioni le conosci: {vital}.'),
        p(3, '30 secondi. Poi minimizzo tutto e giuro che mi diverto pure.'),
        p(3, 'Hai 30 secondi per occuparti di {vital}. Le tue finestre pregano per te.'),
      ],
      minimized: [
        p(2, 'Fatto. Tutto minimizzato. Ora che ci vediamo bene: {vital}, subito.'),
        p(3, 'Le tue finestre riposano. Tu invece muoviti: {vital} non si ricarica da solo.'),
      ],
      lockwarn: [
        p(2, '60 secondi e blocco il PC. Il tempo scorre. Tic. Tac.'),
        p(2, 'Countdown: 60 secondi per {vital}, o questa sessione va in pausa forzata.'),
        p(3, '60 secondi. Poi CTRL+ALT+CANC lo faccio io, a modo mio.'),
        p(3, 'Blocco in arrivo tra 60 secondi. Considerala una pausa sindacale obbligatoria.'),
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
        p(2, 'Final warning: fix {vital} within 30 seconds or I minimize EVERYTHING. Not a threat. Okay, yes it is.'),
        p(2, 'In 30 seconds your windows disappear. You know my terms: {vital}.'),
        p(3, '30 seconds. Then I minimize everything, and I swear I\'ll enjoy it.'),
        p(3, 'You have 30 seconds for {vital}. Your windows are praying for you.'),
      ],
      minimized: [
        p(2, 'Done. Everything minimized. Now that I have your attention: {vital}, now.'),
        p(3, 'Your windows are resting. You, however, move: {vital} won\'t refill itself.'),
      ],
      lockwarn: [
        p(2, '60 seconds and I lock the PC. Clock\'s ticking. Tick. Tock.'),
        p(2, 'Countdown: 60 seconds for {vital}, or this session takes a forced break.'),
        p(3, '60 seconds. Then I do CTRL+ALT+DEL my way.'),
        p(3, 'Lock incoming in 60 seconds. Consider it a mandatory union break.'),
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

  const BANK = { it: IT, en: EN };

  // ── selection ───────────────────────────────────────────────────────────────
  function langOf(code) {
    return String(code || '').toLowerCase().startsWith('it') ? 'it' : 'en';
  }
  function toneTier(tone) {
    const i = TONES.indexOf(tone);
    return i === -1 ? 2 : i + 1; // default 'spicy'
  }
  function bucketFor(lang, kind, vital) {
    const b = BANK[langOf(lang)];
    if (vital && b.vital[vital] && b.vital[vital][kind]) return b.vital[vital][kind];
    return b.generic[kind] || null;
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
    if (!['minwarn', 'lockwarn', 'praise'].includes(kind) && bucket[idx].t > 1 && rng() < 0.22) {
      const sBucket = BANK[langOf(lang)].generic.stinger.filter(e => e.t <= tier);
      if (sBucket.length) text += '  ' + fill(sBucket[Math.floor(rng() * sBucket.length)].s, vars);
    }
    return text;
  }

  // ── escalation ──────────────────────────────────────────────────────────────
  // Which stages are currently unlocked for a vital that has been at zero for
  // `deadMs`, honouring the user's toggles and presence. Pure — the engine layers
  // its own once-per-episode / cooldown bookkeeping on top.
  //  opts: { effects, monitors, minimize, lock, present }
  // `present` (system idle < threshold) gates ONLY the PC-invading stages:
  // annoying an empty room teaches nothing and confuses on return.
  function stagesFor(deadMs, opts) {
    const o = opts || {};
    const out = [];
    if (deadMs >= STAGE_AT.nag) out.push('nag');
    if (o.effects !== false && deadMs >= STAGE_AT.decay) out.push('decay');
    if (o.effects !== false && deadMs >= STAGE_AT.gameover) out.push('gameover');
    if (o.present === true) {
      if (o.monitors === true && deadMs >= STAGE_AT.overlay) out.push('overlay');
      if (o.minimize === true && deadMs >= STAGE_AT.minimize) out.push('minimize');
      if (o.lock === true && deadMs >= STAGE_AT.lock) out.push('lock');
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
