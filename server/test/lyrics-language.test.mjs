// Lyrics: "surely already in the user's language" — a wrong true hides a
// translation the user needed, so most cases here are about answering false.
// Fixture lines are invented, never real song text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isSurelyLang, WORDS, words } = require('../lyrics-language.js');

const SONGS = {
  it: [
    'Cammino da solo sulla strada di casa', 'Non so dove vado ma sono contento',
    'La luna è alta e il vento mi parla', 'Ti ho cercato in ogni città che ho visto',
    'Ma tu non c\'eri più, non c\'eri già', 'Una finestra accesa dentro la nebbia',
    'Quando torni dimmi che cosa è successo', 'Io resto qui senza fare rumore',
    'Tutto quello che ho è una vecchia chitarra', 'Poi canto per noi, per chi non c\'è',
  ],
  en: [
    'I walk alone down the road to my house', 'I don\'t know where I\'m going but I\'m fine',
    'The moon is high and the wind is talking', 'I\'ve looked for you in every town that I saw',
    'But you were not there, you were gone', 'A window is lit in the middle of the fog',
    'When you come back tell me what happened', 'I stay here and I make no sound',
    'All that I have is an old guitar', 'And I sing for us, for those who are gone',
  ],
  es: [
    'Camino solo por la calle de mi casa', 'No sé dónde voy pero estoy tranquilo',
    'La luna está alta y el viento me habla', 'Te busqué en todas las ciudades que vi',
    'Pero tú no estabas, ya no estabas', 'Una ventana encendida en medio de la niebla',
    'Cuando vuelvas dime qué pasó', 'Yo me quedo aquí sin hacer ruido',
    'Todo lo que tengo es una guitarra vieja', 'Y canto por nosotros, por los que no están',
  ],
  pt: [
    'Eu ando sozinho pela rua da minha casa', 'Não sei onde vou mas estou contente',
    'A lua está alta e o vento fala comigo', 'Procurei você em todas as cidades que vi',
    'Mas você não estava, já não estava', 'Uma janela acesa no meio da névoa',
    'Quando você voltar me diz o que foi', 'Eu fico aqui sem fazer barulho',
    'Tudo que eu tenho é um violão velho', 'E canto pra nós, pra quem não está',
  ],
  fr: [
    'Je marche seul sur le chemin de ma maison', 'Je ne sais pas où je vais mais je suis bien',
    'La lune est haute et le vent me parle', 'Je t\'ai cherché dans toutes les villes que j\'ai vues',
    'Mais tu n\'étais pas là, tu n\'étais plus là', 'Une fenêtre allumée dans la brume',
    'Quand tu reviens dis-moi ce qui est arrivé', 'Je reste ici sans faire de bruit',
    'Tout ce que j\'ai est une vieille guitare', 'Et je chante pour nous, pour ceux qui ne sont plus là',
  ],
  de: [
    'Ich gehe allein auf der Straße nach Hause', 'Ich weiß nicht wohin ich gehe aber es geht mir gut',
    'Der Mond ist hoch und der Wind spricht mit mir', 'Ich habe dich in jeder Stadt gesucht die ich sah',
    'Aber du warst nicht da, du warst schon weg', 'Ein Fenster brennt mitten im Nebel',
    'Wenn du zurückkommst sag mir was passiert ist', 'Ich bleibe hier und mache keinen Lärm',
    'Alles was ich habe ist eine alte Gitarre', 'Und ich singe für uns, für die die nicht mehr da sind',
  ],
  nl: [
    'Ik loop alleen over de weg naar mijn huis', 'Ik weet niet waar ik heen ga maar het gaat goed',
    'De maan staat hoog en de wind praat met mij', 'Ik heb je in elke stad gezocht die ik zag',
    'Maar jij was er niet, jij was er niet meer', 'Een raam is verlicht midden in de mist',
    'Als je terugkomt zeg me wat er is gebeurd', 'Ik blijf hier en maak geen geluid',
    'Alles wat ik heb is een oude gitaar', 'En ik zing voor ons, voor wie er niet meer zijn',
  ],
  ru: [
    'Я иду один по дороге к дому', 'Я не знаю куда я иду но мне хорошо',
    'Луна высоко и ветер говорит со мной', 'Я искал тебя в каждом городе который видел',
    'Но тебя там не было, ты уже ушла', 'Окно горит посреди тумана',
    'Когда ты вернёшься скажи мне что случилось', 'Я остаюсь здесь и не делаю шума',
    'Всё что у меня есть это старая гитара', 'И я пою для нас, для тех кого нет',
  ],
};

test('each language is recognised in its own song', () => {
  for (const [lang, lines] of Object.entries(SONGS)) {
    assert.equal(isSurelyLang(lines, lang), true, lang);
  }
});

test('a song is never taken for another language of the set', () => {
  for (const [lang, lines] of Object.entries(SONGS)) {
    for (const other of Object.keys(SONGS)) {
      if (other !== lang) assert.equal(isSurelyLang(lines, other), false, `${lang} as ${other}`);
    }
  }
});

test('the word lists never share a word', () => {
  const owner = new Map();
  for (const [lang, list] of Object.entries(WORDS)) {
    for (const w of list) {
      assert.equal(owner.has(w) && owner.get(w) !== lang, false, `"${w}" is in ${owner.get(w)} and ${lang}`);
      owner.set(w, lang);
    }
  }
});

test('a song with a line in another language goes to the model', () => {
  const mixed = [...SONGS.it, 'I don\'t know what you want from me'];
  assert.equal(isSurelyLang(SONGS.it, 'it'), true);
  assert.equal(isSurelyLang(mixed, 'it'), false);
});

test('one borrowed word in an otherwise Italian line is not a foreign line', () => {
  const lines = SONGS.it.slice();
  lines[3] = 'Ti ho cercato in ogni city che ho visto';
  assert.equal(isSurelyLang(lines, 'it'), true);
});

test('too little text is never enough', () => {
  assert.equal(isSurelyLang(SONGS.it.slice(0, 7), 'it'), false);
  assert.equal(isSurelyLang(['Ma sì', 'Non so', 'Io no', 'Oh', 'Ah', 'Ehi', 'Su', 'Via', 'Ciao'], 'it'), false);
  assert.equal(isSurelyLang([], 'it'), false);
  assert.equal(isSurelyLang(null, 'it'), false);
});

test('Japanese, Korean and Chinese targets are never answered here', () => {
  for (const lang of ['ja', 'ko', 'zh', 'xx', '']) assert.equal(isSurelyLang(SONGS.it, lang), false, lang);
});

test('romanised and non-Latin text is left to the model', () => {
  const romaji = ['Kimi no koe ga kikoeru', 'Yoru no sora wo miageteru', 'Itsumo soba ni iru yo', 'Hikari no naka e', 'Aruite yuku yo', 'Mou ichido dake', 'Omoide no mukou ni', 'Kaze ga yobu yo', 'Namida wo fuite'];
  assert.equal(isSurelyLang(romaji, 'it'), false);
  assert.equal(isSurelyLang(SONGS.ru, 'it'), false);
  assert.equal(isSurelyLang(SONGS.it.map((l, i) => (i === 0 ? '東京の夜はまだ明るい' : l)), 'it'), false);
});

test('Ukrainian is not taken for Russian', () => {
  const uk = SONGS.ru.map((l) => l.replace(/Я/g, 'Я').replace('куда', 'куди')).concat(['І ми співаємо їй']);
  assert.equal(isSurelyLang(uk, 'ru'), false);
});

test('words keeps contractions whole and splits elisions', () => {
  assert.deepEqual(words("Don't stop, it's c'est l'amour"), ["don't", 't', 'stop', "it's", 's', "c'est", 'est', "l'amour", 'amour']);
  assert.deepEqual(words('Ti ho cercato'), ['ti', 'ho', 'cercato']);
  assert.deepEqual(words(''), []);
});

test('a song in a near language the dashboard does not translate to is never "surely" the close one', () => {
  const catalan = [
    'Camino sol per la nit amb els ulls tancats', 'Jo no sé què vull però avui és diferent',
    'Aquesta ciutat dorm i jo estic despert', 'Tu ets la llum que em queda quan tot és fosc',
    'Som dos estranys que es miren des de lluny', 'Això que sento no té nom ni té final',
    'Els carrers callen i el vent em parla molt', 'Vull tornar a casa abans que sigui tard',
    'Res no és com era quan érem petits', 'Aquest silenci pesa més que les paraules',
  ];
  const danish = [
    'Jeg går alene hjem gennem byen i nat', 'Jeg ved ikke hvor jeg skal hen men det er godt',
    'Månen er høj og vinden taler til mig', 'Jeg har ledt efter dig i hver eneste by',
    'Men du var ikke der og du er væk nu', 'Vinduet lyser midt i tågen og regnen',
    'Når du kommer hjem så sig hvad der skete', 'Jeg bliver her og siger ingen ting',
    'Alt hvad jeg har er en gammel guitar', 'Og jeg synger for os og for dem der er væk',
  ];
  assert.equal(isSurelyLang(catalan, 'es'), false);
  assert.equal(isSurelyLang(danish, 'de'), false);
});
