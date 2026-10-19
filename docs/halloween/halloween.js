// Haunted House: the home page block of the Halloween skin (22 October to
// 1 November 2026). Loaded only by the date gate in each page's <head>, which
// has already added html.hh and halloween.css. On the home page (/ and /<lang>/)
// it puts the drop above the hero: the free house as the way in (Download
// Xenon), the supporters' house as the offer. Every string goes in through
// textContent; nothing here touches the download flow, consent or analytics
// beyond two explicit data-track attributes that analytics.js already reads.
(function () {
  'use strict';

  const LANGS = ['en', 'it', 'es', 'fr', 'ja', 'ko', 'zh'];
  const SUPPORT = 'https://xenon-supporter-hub.xenonedge.workers.dev/go/support?s=halloween-site';

  const T = {
    en: {
      line: 'A paper haunted house for your dashboard. Eight windows, and from 25 to 31 October a new guest moves in every evening at 8 pm your time.',
      one: 'Window 1 is open. Window 2 opens on {date} at 8 pm your time.',
      some: '{n} of 8 windows are open. Window {m} opens on {date} at 8 pm your time.',
      all: 'All 8 windows are open.',
      party: 'The party starts at midnight.',
      freeFact: 'Free: the house and window 1, a pumpkin you carve yourself.',
      freeNote: 'In the Xenon Store from 22 October. Install Xenon, then add it from the Store.',
      freeCta: 'Download Xenon',
      freeAlt: 'The free Haunted House at night: a paper house with its windows shut and a carved pumpkin by the door.',
      allName: 'Haunted House: all 8 windows',
      allFact: 'Seven guests, one each evening from 25 to 31 October, and a 30-second party at midnight on 1 November.',
      allAfter: 'Seven guests and the midnight party, all in the house. From 1 November supporters also get it as a night background: Haunted House: Night Scene.',
      allPrice: 'For supporters, from $5 a month. What you unlock stays yours if you stop.',
      allCta: 'Become a supporter',
      allAlt: 'The supporters’ Haunted House: a werewolf, a ghost, a skeleton band, a witch and a graveyard of tombstones under a full moon.',
    },
    it: {
      line: 'Una casa infestata di carta per la tua dashboard. Otto finestre, e dal 25 al 31 ottobre un ospite nuovo ogni sera alle 20, ora tua.',
      one: 'La finestra 1 è aperta. La finestra 2 si apre il {date} alle 20, ora tua.',
      some: '{n} finestre su 8 sono aperte. La finestra {m} si apre il {date} alle 20, ora tua.',
      all: 'Tutte le 8 finestre sono aperte.',
      party: 'La festa comincia a mezzanotte.',
      freeFact: 'Gratis: la casa e la finestra 1, una zucca che intagli tu.',
      freeNote: 'Nello Store di Xenon dal 22 ottobre. Installa Xenon, poi aggiungila dallo Store.',
      freeCta: 'Scarica Xenon',
      freeAlt: 'La Haunted House gratuita di notte: una casa di carta con le finestre chiuse e una zucca intagliata vicino alla porta.',
      allName: 'Haunted House: all 8 windows',
      allFact: 'Sette ospiti, uno ogni sera dal 25 al 31 ottobre, e una festa di 30 secondi a mezzanotte del 1° novembre.',
      allAfter: 'Sette ospiti e la festa di mezzanotte, tutti nella casa. Dal 1° novembre chi sostiene Xenon la riceve anche come sfondo notturno: Haunted House: Night Scene.',
      allPrice: 'Per chi sostiene Xenon, da $5 al mese. Quello che sblocchi resta tuo anche se smetti.',
      allCta: 'Sostieni Xenon',
      allAlt: 'La Haunted House dei sostenitori: un lupo mannaro, un fantasma, una band di scheletri, una strega e un cimitero di lapidi sotto la luna piena.',
    },
    es: {
      line: 'Una casa encantada de papel para tu dashboard. Ocho ventanas, y del 25 al 31 de octubre llega un invitado nuevo cada noche a las 20:00, hora local.',
      one: 'La ventana 1 está abierta. La ventana 2 se abre el {date} a las 20:00, hora local.',
      some: '{n} de 8 ventanas están abiertas. La ventana {m} se abre el {date} a las 20:00, hora local.',
      all: 'Las 8 ventanas están abiertas.',
      party: 'La fiesta empieza a medianoche.',
      freeFact: 'Gratis: la casa y la ventana 1, una calabaza que tallas tú.',
      freeNote: 'En la Store de Xenon desde el 22 de octubre. Instala Xenon y añádela desde la Store.',
      freeCta: 'Descargar Xenon',
      freeAlt: 'La Haunted House gratuita de noche: una casa de papel con las ventanas cerradas y una calabaza tallada junto a la puerta.',
      allName: 'Haunted House: all 8 windows',
      allFact: 'Siete invitados, uno cada noche del 25 al 31 de octubre, y una fiesta de 30 segundos a medianoche del 1 de noviembre.',
      allAfter: 'Siete invitados y la fiesta de medianoche, todos en la casa. Desde el 1 de noviembre, quienes apoyan Xenon también la reciben como fondo nocturno: Haunted House: Night Scene.',
      allPrice: 'Para quienes apoyan Xenon, desde $5 al mes. Lo que desbloqueas sigue siendo tuyo aunque lo dejes.',
      allCta: 'Apoyar Xenon',
      allAlt: 'La Haunted House de quienes apoyan Xenon: un hombre lobo, un fantasma, una banda de esqueletos, una bruja y un cementerio de lápidas bajo la luna llena.',
    },
    fr: {
      line: 'Une maison hantée en papier pour votre tableau de bord. Huit fenêtres, et du 25 au 31 octobre un nouvel invité arrive chaque soir à 20 h, heure locale.',
      one: 'La fenêtre 1 est ouverte. La fenêtre 2 s’ouvre le {date} à 20 h, heure locale.',
      some: '{n} fenêtres sur 8 sont ouvertes. La fenêtre {m} s’ouvre le {date} à 20 h, heure locale.',
      all: 'Les 8 fenêtres sont ouvertes.',
      party: 'La fête commence à minuit.',
      freeFact: 'Gratuit : la maison et la fenêtre 1, une citrouille que vous sculptez vous-même.',
      freeNote: 'Dans le Store de Xenon à partir du 22 octobre. Installez Xenon, puis ajoutez-la depuis le Store.',
      freeCta: 'Télécharger Xenon',
      freeAlt: 'La Haunted House gratuite la nuit : une maison en papier aux fenêtres fermées et une citrouille sculptée près de la porte.',
      allName: 'Haunted House: all 8 windows',
      allFact: 'Sept invités, un chaque soir du 25 au 31 octobre, et une fête de 30 secondes à minuit le 1er novembre.',
      allAfter: 'Sept invités et la fête de minuit, tous dans la maison. Dès le 1er novembre, les supporters la reçoivent aussi en fond de nuit : Haunted House: Night Scene.',
      allPrice: 'Pour les supporters, à partir de 5 $ par mois. Ce que vous débloquez reste à vous si vous arrêtez.',
      allCta: 'Devenir supporter',
      allAlt: 'La Haunted House des supporters : un loup-garou, un fantôme, un groupe de squelettes, une sorcière et un cimetière sous la pleine lune.',
    },
    ja: {
      line: 'ダッシュボードに住む、紙のお化け屋敷。窓は 8 つ。10月25日から31日まで、毎晩 20:00（現地時間）に新しい住人がやってきます。',
      one: '窓 1 が開いています。窓 2 は {date} 20:00（現地時間）に開きます。',
      some: '8 つのうち {n} つの窓が開いています。窓 {m} は {date} 20:00（現地時間）に開きます。',
      all: '8 つの窓がすべて開いています。',
      party: '真夜中にパーティーが始まります。',
      freeFact: '無料：家と窓 1。自分で彫るカボチャ。',
      freeNote: '10月22日から Xenon Store で公開。Xenon をインストールして、Store から追加してください。',
      freeCta: 'Xenon をダウンロード',
      freeAlt: '夜の無料版 Haunted House：窓が閉じた紙の家と、ドアのそばの彫られたカボチャ。',
      allName: 'Haunted House: all 8 windows',
      allFact: '10月25日から31日まで毎晩ひとりずつ、7 人の住人。11月1日の真夜中には 30 秒のパーティー。',
      allAfter: '7 人の住人と真夜中のパーティーが、みんな家の中に。11月1日からは、サポーターは夜の背景としても使えます：Haunted House: Night Scene。',
      allPrice: 'サポーター向け、月 $5 から。やめても、解放したものはそのまま使えます。',
      allCta: 'サポーターになる',
      allAlt: 'サポーター版 Haunted House：満月の下の狼男、幽霊、ガイコツのバンド、魔女、墓石の並ぶ墓地。',
    },
    ko: {
      line: '대시보드에 사는 종이 유령의 집. 창문 8개, 10월 25일부터 31일까지 매일 저녁 8시(현지 시간)에 새 손님이 찾아옵니다.',
      one: '창문 1이 열려 있습니다. 창문 2는 {date} 저녁 8시(현지 시간)에 열립니다.',
      some: '창문 8개 중 {n}개가 열려 있습니다. 다음 창문({m})은 {date} 저녁 8시(현지 시간)에 열립니다.',
      all: '창문 8개가 모두 열려 있습니다.',
      party: '자정에 파티가 시작됩니다.',
      freeFact: '무료: 집과 창문 1, 직접 조각하는 호박.',
      freeNote: '10월 22일부터 Xenon Store에 있습니다. Xenon을 설치한 뒤 Store에서 추가하세요.',
      freeCta: 'Xenon 다운로드',
      freeAlt: '밤의 무료 Haunted House: 창문이 닫힌 종이 집과 문 옆의 조각된 호박.',
      allName: 'Haunted House: all 8 windows',
      allFact: '10월 25일부터 31일까지 매일 저녁 한 명씩, 일곱 손님. 11월 1일 자정에는 30초 파티.',
      allAfter: '일곱 손님과 자정 파티가 모두 집 안에. 11월 1일부터 후원자는 밤 배경으로도 받습니다: Haunted House: Night Scene.',
      allPrice: '후원자용, 월 $5부터. 후원을 멈춰도 잠금 해제한 것은 계속 내 것입니다.',
      allCta: '후원하기',
      allAlt: '후원자용 Haunted House: 보름달 아래의 늑대인간, 유령, 해골 밴드, 마녀, 비석이 있는 묘지.',
    },
    zh: {
      line: '住在你仪表盘上的纸质鬼屋。8 扇窗，10月25日至31日每晚 20:00（当地时间）迎来一位新住客。',
      one: '第 1 扇窗已打开。第 2 扇窗将于{date} 20:00（当地时间）打开。',
      some: '8 扇窗中已有 {n} 扇打开。第 {m} 扇窗将于{date} 20:00（当地时间）打开。',
      all: '8 扇窗已全部打开。',
      party: '派对在午夜开始。',
      freeFact: '免费：房子和第 1 扇窗，一个由你亲手雕刻的南瓜。',
      freeNote: '10月22日起上架 Xenon Store。安装 Xenon，然后在 Store 中添加。',
      freeCta: '下载 Xenon',
      freeAlt: '夜晚的免费 Haunted House：一座窗户紧闭的纸房子，门边放着一个雕好的南瓜。',
      allName: 'Haunted House: all 8 windows',
      allFact: '7 位住客，10月25日至31日每晚一位；11月1日午夜还有 30 秒的派对。',
      allAfter: '7 位住客和午夜派对都在屋里。从11月1日起，支持者还可以把它当作夜间背景：Haunted House: Night Scene。',
      allPrice: '支持者专享，每月 $5 起。即使停止支持，已解锁的内容仍归你所有。',
      allCta: '成为支持者',
      allAlt: '支持者版 Haunted House：满月下的狼人、幽灵、骷髅乐队、女巫和立满墓碑的墓地。',
    },
  };

  // Window n (2..8) opens at 20:00 local time on 23 + n October; 1 is open from the start.
  const opensAt = (n) => new Date(2026, 9, 23 + n, 20, 0, 0);
  const PARTY = new Date(2026, 10, 1, 0, 0, 0);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function picture(name, alt) {
    const img = el('img');
    img.src = '/halloween/' + name + '-566.webp';
    img.srcset = '/halloween/' + name + '-566.webp 566w, /halloween/' + name + '-1132.webp 1132w';
    img.sizes = '(max-width: 700px) calc(100vw - 36px), (max-width: 1180px) 46vw, 31vw';
    img.width = 1132; img.height = 584;
    img.alt = alt;
    img.decoding = 'async';
    return img;
  }

  function status(t, lang, now) {
    let open = 1;
    for (let n = 2; n <= 8; n++) if (now >= opensAt(n)) open = n;
    if (open === 8) return { open, text: now < PARTY ? t.all + ' ' + t.party : t.all };
    let date = '';
    // en-GB, so it reads "25 October" like every other line of the drop.
    try { date = new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, { day: 'numeric', month: 'long' }).format(opensAt(open + 1)); }
    catch (e) { date = String(open + 24) + ' October'; }
    const tpl = open === 1 ? t.one : t.some;
    return { open, text: tpl.replace('{n}', String(open)).replace('{m}', String(open + 1)).replace('{date}', date) };
  }

  function card(kind, t, lang, now) {
    const sup = kind === 'all';
    const c = el('article', 'hh-card' + (sup ? ' sup' : ''));
    c.appendChild(picture(kind, sup ? t.allAlt : t.freeAlt));
    const b = el('div', 'hh-body');
    b.appendChild(el('h3', null, sup ? t.allName : 'Haunted House'));
    b.appendChild(el('p', null, sup ? (now >= PARTY ? t.allAfter : t.allFact) : t.freeFact));
    b.appendChild(el('p', 'hh-small', sup ? t.allPrice : t.freeNote));
    const act = el('div', 'hh-act');
    const a = el('a', 'hh-go', sup ? t.allCta : t.freeCta);
    if (sup) {
      a.href = SUPPORT; a.target = '_blank'; a.rel = 'noopener';
      a.setAttribute('data-track', 'halloween_click');
      a.setAttribute('data-track-location', 'home_supporter');
    } else {
      a.href = lang === 'en' ? '/download.html' : '/' + lang + '/download.html';
      a.setAttribute('data-track', 'halloween_click');
      a.setAttribute('data-track-location', 'home_free');
    }
    act.appendChild(a);
    b.appendChild(act);
    c.appendChild(b);
    return c;
  }

  // True once the block is in (or this page has none), so the parser watch below can stop.
  function build() {
    const p = location.pathname.replace(/index\.html$/, '');
    const m = /^\/(?:([a-z]{2})\/)?$/.exec(p);
    if (!m || document.querySelector('.hh-drop')) return true;
    const hero = document.querySelector('#main > section.hero');
    if (!hero) return false;
    const raw = (document.documentElement.lang || m[1] || 'en').slice(0, 2).toLowerCase();
    const lang = LANGS.includes(raw) ? raw : 'en';
    const t = T[lang];

    const sec = el('section', 'hh-drop');
    sec.setAttribute('aria-labelledby', 'hh-t');
    const w = el('div', 'w hh-grid');

    const intro = el('div', 'hh-intro');
    const h = el('h2', null, 'Haunted House');
    h.id = 'hh-t';
    intro.appendChild(h);
    intro.appendChild(el('p', 'hh-line', t.line));
    const now = new Date();
    const s = status(t, lang, now);
    const tonight = el('div', 'hh-tonight');
    const wins = el('ol', 'hh-wins');
    wins.setAttribute('aria-hidden', 'true');
    for (let n = 1; n <= 8; n++) wins.appendChild(el('li', n <= s.open ? 'on' : null));
    tonight.appendChild(wins);
    tonight.appendChild(el('p', 'hh-status', s.text));
    intro.appendChild(tonight);
    w.appendChild(intro);

    const cards = el('div', 'hh-cards');
    cards.appendChild(card('free', t, lang, now));
    cards.appendChild(card('all', t, lang, now));
    w.appendChild(cards);

    sec.appendChild(w);
    hero.parentNode.insertBefore(sec, hero);
    return true;
  }

  // The gate loads this from <head>, render-blocking where the browser supports it. Waiting for
  // DOMContentLoaded would paint the hero first and then push it down (a big layout shift on
  // phones), so the block goes in as soon as the parser has created the hero.
  if (document.readyState !== 'loading') { build(); return; }
  if (build()) return;
  const watch = new MutationObserver(() => { if (build()) watch.disconnect(); });
  watch.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { watch.disconnect(); build(); }, { once: true });
})();
