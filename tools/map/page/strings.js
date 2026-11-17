// Every word of the page in Italian and English. {0}, {1}… are filled in order.
const STRINGS = {
  it: {
    title: 'Mappa del repo Xenon',
    viewMap: 'Mappa', viewFolders: 'Cartelle',
    searchHint: 'Cerca un file, una funzione, un endpoint o una parola…',
    howTitle: 'Come si parlano i pezzi',
    shows: 'mostra', serves: 'gli dà la pagina e i dati', asks: 'chiede al sistema',
    appStarts: "L'app avvia anche il motore. Un telefono apre la stessa pagina dello schermo, sempre dal motore.",
    mapTitle: 'Dove sta ogni cosa',
    mapHint: "Ogni zona colorata è un'area del codice, ogni riquadro una funzionalità. Più file ha, più è grande. Tocca un riquadro per vedere le sue cartelle, i file e cosa fa ogni funzione.",
    files: '{0} file', back: '← Mappa',
    facts: '{0} file in {1} cartelle, {2} funzioni, {3} endpoint.',
    whereTitle: 'Dove guardare',
    routesTitle: 'Endpoint',
    routesHint: 'Le richieste HTTP che questa parte del motore riceve, con il file e la riga che le gestisce.',
    filesTitle: 'Tutti i file',
    filesHint: 'Apri un file per vedere le sue funzioni, la riga dove inizia ognuna e cosa fa.',
    filter: 'Filtra questi file',
    exports: 'Dà al resto del codice: {0}',
    line: 'riga {0}', fnCount: '{0} funzioni',
    copyPath: 'Copia percorso', copied: 'Copiato: {0}', copyFailed: 'Copia non riuscita: seleziona il testo a mano.',
    noFiles: 'Nessun file corrisponde.',
    noInside: 'Nessuna funzione letta da questo file.',
    foldersTitle: 'Cartelle',
    foldersHint: "L'albero del repo. Sotto ogni cartella c'è a quale funzionalità appartiene; tocca un file per aprirlo nella sua funzionalità.",
    several: 'Divisa tra: {0}',
    kinds: { f: 'Funzionalità', d: 'Cartelle', r: 'Endpoint', s: 'Funzioni', p: 'File', w: 'Funzioni che ne parlano' },
    more: '(altri {0})', none: 'Niente per “{0}”. Prova una parte del nome, per esempio weather o /api/.',
    gone: 'Questa funzionalità non esiste più nella mappa.',
  },
  en: {
    title: 'Xenon repo map',
    viewMap: 'Map', viewFolders: 'Folders',
    searchHint: 'Search a file, a function, an endpoint or a word…',
    howTitle: 'How the pieces talk',
    shows: 'shows', serves: 'gives it the page and the data', asks: 'asks the system',
    appStarts: 'The app also starts the engine. A phone opens the same page as the screen, from the engine too.',
    mapTitle: 'Where everything lives',
    mapHint: 'Each coloured zone is an area of the code, each block a feature. The more files it has, the bigger it is. Tap a block to see its folders, its files and what each function does.',
    files: '{0} files', back: '← Map',
    facts: '{0} files in {1} folders, {2} functions, {3} endpoints.',
    whereTitle: 'Where to look',
    routesTitle: 'Endpoints',
    routesHint: 'The HTTP requests this part of the engine answers, with the file and line that handles each.',
    filesTitle: 'All files',
    filesHint: 'Open a file to see its functions, the line each one starts on and what it does.',
    filter: 'Filter these files',
    exports: 'Gives the rest of the code: {0}',
    line: 'line {0}', fnCount: '{0} functions',
    copyPath: 'Copy path', copied: 'Copied: {0}', copyFailed: 'Copy failed: select the text by hand.',
    noFiles: 'No file matches.',
    noInside: 'No functions read from this file.',
    foldersTitle: 'Folders',
    foldersHint: 'The repo tree. Under each folder is the feature it belongs to; tap a file to open it in its feature.',
    several: 'Shared by: {0}',
    kinds: { f: 'Features', d: 'Folders', r: 'Endpoints', s: 'Functions', p: 'Files', w: 'Functions that mention it' },
    more: '({0} more)', none: 'Nothing for “{0}”. Try part of a name, for example weather or /api/.',
    gone: 'This feature is no longer on the map.',
  },
};

/** The language the page speaks now; start.js sets it. */
const reading = { lang: 'it' };

/** @param {string} key @param {...(string|number)} args */
function t(key, ...args) {
  const text = STRINGS[reading.lang][key] ?? STRINGS.en[key] ?? key;
  return typeof text === 'string' ? text.replace(/\{(\d)\}/g, (_, i) => String(args[Number(i)] ?? '')) : text;
}

/** Numbers the way the reader writes them. @param {number} n */
const num = (n) => n.toLocaleString(reading.lang === 'it' ? 'it-IT' : 'en-US');
