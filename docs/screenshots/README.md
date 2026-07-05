# Screenshot da inserire — Borsa, Ticker, Calcio, News

Questo file elenca gli screenshot che mancano e **dove** vanno. Le immagini della
documentazione vivono in `docs/images/` (stesso posto di `weather.png`,
`notifications.png`, …). Salva ogni file con **esattamente** il nome indicato e i
riferimenti markdown già presenti nei documenti si popoleranno da soli.

Suggerimenti di cattura: dashboard sul tema scuro, tile Borsa aggiunto dalla palette
"+", watchlist con almeno un titolo `.MI` (es. `FTSEMIB.MI`) e uno in rosso e uno in
verde per mostrare bene i colori su/giù. PNG, ritagliato stretto sul contenuto.

## Fase 1 — Borsa + Ticker (attuale)

| # | File da salvare | Cosa inquadrare | Già referenziato in |
|---|-----------------|-----------------|---------------------|
| 1 | `docs/images/stocks-widget.png` | Il widget Borsa in vista lista: righe watchlist con nome, prezzo, variazione % e sparkline | `FEATURES.md` → sezione *Stocks (Borsa)* |
| 2 | `docs/images/stocks-chart.png` | La vista dettaglio di un titolo: prezzo grande, switch range 1D/1W/1M/1Y, grafico ad area + crosshair, statistiche | `FEATURES.md` → sezione *Stocks (Borsa)* |
| 3 | `docs/images/stocks-ticker.png` | La barra ticker scorrevole in fondo allo schermo, con alcune quote (verde/rosso) | `FEATURES.md` → sezione *Stocks (Borsa)* |
| 4 | `docs/images/stocks-settings.png` | Settings → Borsa & Ticker (toggle ticker, posizione, velocità, sorgenti, provider, chiavi opzionali) | *(opzionale)* aggiungibile a `FEATURES.md`/sito |
| 5 | `docs/images/stocks-alert.png` | Un toast di avviso "in forte rialzo/ribasso" su un preferito | *(opzionale)* |

Per aggiungere un'immagine opzionale (4–5) al documento, incolla dove preferito:

```markdown
![Impostazioni Borsa & Ticker](docs/images/stocks-settings.png)
![Avviso preferito Borsa](docs/images/stocks-alert.png)
```

## Sito vetrina (`docs/index.html`)

Il sito usa tile dimostrative. Se vuoi mostrare la Borsa anche lì, aggiungi
un'immagine e referenziala nella sezione feature del sito:

| # | File da salvare | Cosa inquadrare |
|---|-----------------|-----------------|
| 6 | `docs/images/stocks-hero.png` | Uno scatto "hero" pulito del widget Borsa + ticker per la card del sito |

## Fase 2 — Calcio (attuale)

Suggerimenti di cattura: segui 2–3 squadre (es. Napoli, Inter, Roma), tema scuro,
possibilmente con una partita live per mostrare il badge "LIVE" e il punteggio rosso.

| # | File da salvare | Cosa inquadrare | Già referenziato in |
|---|-----------------|-----------------|---------------------|
| 7 | `docs/images/football-widget.png` | Il widget Calcio in vista lista: righe squadre con crest, ultimo risultato (W/D/L) e prossima partita | `FEATURES.md` → sezione *Football (Calcio)* |
| 8 | `docs/images/football-detail.png` | La vista dettaglio di una squadra: hero della partita, risultati recenti, prossime, classifica con la squadra evidenziata | `FEATURES.md` → sezione *Football (Calcio)* |
| 9 | `docs/images/football-ticker.png` | La barra ticker con i punteggi/prossime partite delle squadre seguite (partita live evidenziata) | *(opzionale)* |
| 10 | `docs/images/football-settings.png` | Settings → sezione Calcio (avvisi, risultati/classifica nel dettaglio, aggiornamento, chiave Premium opzionale) | *(opzionale)* |

## Fase 3 — News (attuale)

Suggerimenti di cattura: segui un paio di testate (ANSA, BBC) e un argomento
(Tecnologia), tema scuro; possibilmente con qualche titolo con immagine.

| # | File da salvare | Cosa inquadrare | Già referenziato in |
|---|-----------------|-----------------|---------------------|
| 11 | `docs/images/news-widget.png` | Il widget News: stream di titoli con testata, tempo relativo e miniatura | `FEATURES.md` → sezione *News* |
| 12 | `docs/images/news-manage.png` | Il pannello Gestisci: ricerca testate + chip dei feed seguiti (testate e argomenti) | *(opzionale)* |
| 13 | `docs/images/news-settings.png` | Settings → sezione News (immagini, aggiornamento, chiave NewsData.io opzionale) | *(opzionale)* |
