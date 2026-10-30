// The creator's status page for one submission (docs/submit/status/).
//
// The link carries "<id>.<token>" in the fragment, which never leaves the
// browser except in the POST below. The hub answers with the submission's
// status, the reviewer's note and the quality report
// (xenon-supporter-hub/src/quality-report.js); everything it returns is the
// creator's own text or the reviewer's, so all of it is written with
// textContent.
(function () {
  'use strict';

  var HUB = 'https://xenon-supporter-hub.xenonedge.workers.dev';
  var LANGS = ['en', 'it', 'es', 'fr', 'ko', 'ja', 'zh'];
  var FIRST_FINDINGS = 5;
  // Nobody sells creations yet, so the suggested price stays off the page. The
  // hub still computes it and the block below still renders it when this flips.
  var SHOW_PRICE = false;
  var SECTION_KEYS = ['security', 'works', 'efficiency', 'design', 'listing', 'price'];

  var STRINGS = {
    en: {
      title: 'Your submission', loading: 'Loading…',
      bad_link: 'This link does not open a submission. Check that you copied all of it.',
      offline: 'The review server did not answer. Try again in a minute.',
      retry: 'Try again', rate: 'Too many requests from this network. Try again later.',
      s_pending: 'In review. Below is the automatic check; a person reviews it next.',
      s_fix: 'Almost there. Fix the points below and send the new version from the same form.',
      s_free: 'Ready to publish for free.', s_sellable: 'Ready for the Store.',
      s_approved: 'Published.', s_rejected: 'Not published.',
      open_entry: 'Open it in the catalog', note: 'Note from the reviewer',
      good: 'What already works', todo: 'What to do', none: 'Nothing to fix.',
      show_all: 'Show all', where: 'Where', why: 'Why', how: 'How to fix', example: 'Example',
      sev_block: 'Must fix', sev_fix: 'Should fix', sev_tip: 'Tip',
      sum_block: "Must fix: {n}. Until they are fixed it cannot go in the Store.", sum_fix: "Should fix: {n}. They are worth doing before the next version.",
      eff_quick: 'a few minutes', eff_medium: 'under an hour', eff_long: 'a few hours',
      scores: 'Scores', sec_security: 'Security', sec_works: 'Works as described', sec_efficiency: 'Efficiency',
      sec_design: 'Design', sec_listing: 'Store listing', sec_price: 'Price',
      price: 'Suggested price', price_note: 'You choose the price. This is a suggestion and why.',
      similar: 'Similar entries', stars: 'stars', installs: 'installs', free: 'Free',
      asked: 'Your price', with_pass: 'with the supporter pass', drop: 'limited drop',
      basis_similar: 'Based on similar entries.', basis_category: 'Based on its category; there are no close matches yet.',
      basis_complexity: 'Estimated from what it does; there is nothing similar in the Store yet.',
      omitted: 'more minor points not listed.', submitted: 'Sent', priority: 'Supporter, reviewed first', resend: 'Open the submission form',
    },
    it: {
      title: 'La tua proposta', loading: 'Caricamento…',
      bad_link: 'Questo link non apre nessuna proposta. Controlla di averlo copiato tutto.',
      offline: 'Il server della revisione non ha risposto. Riprova tra un minuto.',
      retry: 'Riprova', rate: 'Troppe richieste da questa rete. Riprova più tardi.',
      s_pending: 'In revisione. Qui sotto c’è il controllo automatico; poi la guarda una persona.',
      s_fix: 'Ci sei quasi. Sistema i punti qui sotto e manda la nuova versione dallo stesso modulo.',
      s_free: 'Pronta da pubblicare gratis.', s_sellable: 'Pronta per lo Store.',
      s_approved: 'Pubblicata.', s_rejected: 'Non pubblicata.',
      open_entry: 'Aprila nel catalogo', note: 'Nota di chi ha fatto la revisione',
      good: 'Cosa funziona già', todo: 'Cosa fare', none: 'Niente da correggere.',
      show_all: 'Mostra tutto', where: 'Dove', why: 'Perché', how: 'Come correggere', example: 'Esempio',
      sev_block: 'Da correggere per forza', sev_fix: 'Da correggere', sev_tip: 'Consiglio',
      sum_block: "Da correggere per forza: {n}. Finché restano, non può entrare nella Store.", sum_fix: "Da correggere: {n}. Conviene farlo prima della prossima versione.",
      eff_quick: 'pochi minuti', eff_medium: 'meno di un’ora', eff_long: 'qualche ora',
      scores: 'Punteggi', sec_security: 'Sicurezza', sec_works: 'Funziona come descritto', sec_efficiency: 'Efficienza',
      sec_design: 'Design', sec_listing: 'Scheda dello Store', sec_price: 'Prezzo',
      price: 'Prezzo consigliato', price_note: 'Il prezzo lo scegli tu. Questo è un consiglio, con il motivo.',
      similar: 'Contenuti simili', stars: 'stelle', installs: 'installazioni', free: 'Gratis',
      asked: 'Il tuo prezzo', with_pass: 'con il pass sostenitore', drop: 'drop limitato',
      basis_similar: 'In base a contenuti simili.', basis_category: 'In base alla categoria; non ci sono ancora contenuti molto simili.',
      basis_complexity: 'Stimato da quello che fa; nello Store non c’è ancora niente di simile.',
      omitted: 'punti minori in più non elencati.', submitted: 'Inviata', priority: 'Sostenitore, revisione in priorità', resend: 'Apri il modulo di invio',
    },
    es: {
      title: 'Tu envío', loading: 'Cargando…',
      bad_link: 'Este enlace no abre ningún envío. Comprueba que lo copiaste completo.',
      offline: 'El servidor de revisión no respondió. Inténtalo de nuevo en un minuto.',
      retry: 'Reintentar', rate: 'Demasiadas solicitudes desde esta red. Inténtalo más tarde.',
      s_pending: 'En revisión. Abajo está la comprobación automática; después lo revisa una persona.',
      s_fix: 'Casi listo. Corrige los puntos de abajo y envía la nueva versión desde el mismo formulario.',
      s_free: 'Listo para publicar gratis.', s_sellable: 'Listo para la Store.',
      s_approved: 'Publicado.', s_rejected: 'No publicado.',
      open_entry: 'Ábrelo en el catálogo', note: 'Nota de quien revisó',
      good: 'Lo que ya funciona', todo: 'Qué hacer', none: 'Nada que corregir.',
      show_all: 'Mostrar todo', where: 'Dónde', why: 'Por qué', how: 'Cómo corregirlo', example: 'Ejemplo',
      sev_block: 'Obligatorio', sev_fix: 'A corregir', sev_tip: 'Consejo',
      sum_block: "Obligatorio: {n}. Hasta corregirlos no puede entrar en la Store.", sum_fix: "A corregir: {n}. Conviene hacerlo antes de la próxima versión.",
      eff_quick: 'unos minutos', eff_medium: 'menos de una hora', eff_long: 'unas horas',
      scores: 'Puntuaciones', sec_security: 'Seguridad', sec_works: 'Funciona como dice', sec_efficiency: 'Eficiencia',
      sec_design: 'Diseño', sec_listing: 'Ficha de la Store', sec_price: 'Precio',
      price: 'Precio sugerido', price_note: 'Tú eliges el precio. Esto es una sugerencia y su motivo.',
      similar: 'Entradas parecidas', stars: 'estrellas', installs: 'instalaciones', free: 'Gratis',
      asked: 'Tu precio', with_pass: 'con el pase de mecenas', drop: 'drop limitado',
      basis_similar: 'Según entradas parecidas.', basis_category: 'Según su categoría; aún no hay entradas muy parecidas.',
      basis_complexity: 'Estimado por lo que hace; aún no hay nada parecido en la Store.',
      omitted: 'puntos menores más sin listar.', submitted: 'Enviado', priority: 'Mecenas, revisión prioritaria', resend: 'Abrir el formulario de envío',
    },
    fr: {
      title: 'Votre proposition', loading: 'Chargement…',
      bad_link: 'Ce lien n’ouvre aucune proposition. Vérifiez que vous l’avez copié en entier.',
      offline: 'Le serveur de revue n’a pas répondu. Réessayez dans une minute.',
      retry: 'Réessayer', rate: 'Trop de requêtes depuis ce réseau. Réessayez plus tard.',
      s_pending: 'En revue. Ci-dessous, la vérification automatique ; une personne la relit ensuite.',
      s_fix: 'Presque prêt. Corrigez les points ci-dessous et envoyez la nouvelle version depuis le même formulaire.',
      s_free: 'Prêt à publier gratuitement.', s_sellable: 'Prêt pour le Store.',
      s_approved: 'Publié.', s_rejected: 'Non publié.',
      open_entry: 'L’ouvrir dans le catalogue', note: 'Note de la personne qui a fait la revue',
      good: 'Ce qui fonctionne déjà', todo: 'À faire', none: 'Rien à corriger.',
      show_all: 'Tout afficher', where: 'Où', why: 'Pourquoi', how: 'Comment corriger', example: 'Exemple',
      sev_block: 'Obligatoire', sev_fix: 'À corriger', sev_tip: 'Conseil',
      sum_block: "Obligatoire : {n}. Tant qu'ils restent, il ne peut pas entrer dans le Store.", sum_fix: "À corriger : {n}. Mieux vaut le faire avant la prochaine version.",
      eff_quick: 'quelques minutes', eff_medium: 'moins d’une heure', eff_long: 'quelques heures',
      scores: 'Notes', sec_security: 'Sécurité', sec_works: 'Fait ce qu’il annonce', sec_efficiency: 'Efficacité',
      sec_design: 'Design', sec_listing: 'Fiche du Store', sec_price: 'Prix',
      price: 'Prix suggéré', price_note: 'C’est vous qui choisissez le prix. Voici une suggestion et sa raison.',
      similar: 'Entrées similaires', stars: 'étoiles', installs: 'installations', free: 'Gratuit',
      asked: 'Votre prix', with_pass: 'avec le pass supporter', drop: 'drop limité',
      basis_similar: 'D’après des entrées similaires.', basis_category: 'D’après sa catégorie ; pas encore d’entrée très proche.',
      basis_complexity: 'Estimé d’après ce qu’il fait ; rien de similaire dans le Store pour l’instant.',
      omitted: 'points mineurs de plus non listés.', submitted: 'Envoyé', priority: 'Supporter, relu en priorité', resend: 'Ouvrir le formulaire d’envoi',
    },
    ko: {
      title: '내 제출물', loading: '불러오는 중…',
      bad_link: '이 링크로는 제출물을 열 수 없습니다. 링크 전체를 복사했는지 확인하세요.',
      offline: '검토 서버가 응답하지 않았습니다. 잠시 후 다시 시도하세요.',
      retry: '다시 시도', rate: '이 네트워크의 요청이 너무 많습니다. 나중에 다시 시도하세요.',
      s_pending: '검토 중입니다. 아래는 자동 검사 결과이며, 이후 사람이 직접 검토합니다.',
      s_fix: '거의 다 됐습니다. 아래 항목을 고친 뒤 같은 양식에서 새 버전을 보내 주세요.',
      s_free: '무료로 게시할 준비가 되었습니다.', s_sellable: '스토어에 올릴 준비가 되었습니다.',
      s_approved: '게시되었습니다.', s_rejected: '게시되지 않았습니다.',
      open_entry: '카탈로그에서 열기', note: '검토자의 메모',
      good: '이미 잘 되는 점', todo: '할 일', none: '고칠 것이 없습니다.',
      show_all: '모두 보기', where: '위치', why: '이유', how: '고치는 방법', example: '예시',
      sev_block: '반드시 수정', sev_fix: '수정 필요', sev_tip: '제안',
      sum_block: "반드시 수정: {n}개. 고치기 전에는 스토어에 들어갈 수 없습니다.", sum_fix: "수정 필요: {n}개. 다음 버전 전에 고치는 것이 좋습니다.",
      eff_quick: '몇 분', eff_medium: '1시간 이내', eff_long: '몇 시간',
      scores: '점수', sec_security: '보안', sec_works: '설명대로 작동', sec_efficiency: '효율',
      sec_design: '디자인', sec_listing: '스토어 정보', sec_price: '가격',
      price: '추천 가격', price_note: '가격은 직접 정합니다. 아래는 추천 가격과 그 이유입니다.',
      similar: '비슷한 항목', stars: '별점', installs: '설치', free: '무료',
      asked: '희망 가격', with_pass: '후원자 패스 포함', drop: '한정 드롭',
      basis_similar: '비슷한 항목을 기준으로 했습니다.', basis_category: '카테고리를 기준으로 했습니다. 아직 아주 비슷한 항목은 없습니다.',
      basis_complexity: '기능을 기준으로 추정했습니다. 스토어에 아직 비슷한 항목이 없습니다.',
      omitted: '개의 사소한 항목은 표시하지 않았습니다.', submitted: '제출일', priority: '후원자, 우선 검토', resend: '제출 양식 열기',
    },
    ja: {
      title: 'あなたの投稿', loading: '読み込み中…',
      bad_link: 'このリンクでは投稿を開けません。リンク全体をコピーしたか確認してください。',
      offline: 'レビューサーバーが応答しませんでした。少し待ってからもう一度お試しください。',
      retry: '再試行', rate: 'このネットワークからのリクエストが多すぎます。後でもう一度お試しください。',
      s_pending: 'レビュー中です。下は自動チェックの結果で、このあと人が確認します。',
      s_fix: 'あと少しです。下の項目を直して、同じフォームから新しいバージョンを送ってください。',
      s_free: '無料で公開できる状態です。', s_sellable: 'ストアに出せる状態です。',
      s_approved: '公開されました。', s_rejected: '公開されませんでした。',
      open_entry: 'カタログで開く', note: 'レビュー担当者からのメモ',
      good: 'すでに良い点', todo: 'やること', none: '直すところはありません。',
      show_all: 'すべて表示', where: '場所', why: '理由', how: '直し方', example: '例',
      sev_block: '必須の修正', sev_fix: '要修正', sev_tip: 'ヒント',
      sum_block: "必須の修正: {n} 件。直すまではストアに入れません。", sum_fix: "要修正: {n} 件。次のバージョンの前に直すのがおすすめです。",
      eff_quick: '数分', eff_medium: '1時間以内', eff_long: '数時間',
      scores: 'スコア', sec_security: 'セキュリティ', sec_works: '説明どおりに動く', sec_efficiency: '効率',
      sec_design: 'デザイン', sec_listing: 'ストアの掲載情報', sec_price: '価格',
      price: 'おすすめ価格', price_note: '価格はあなたが決めます。これはおすすめとその理由です。',
      similar: '似ている項目', stars: '星', installs: 'インストール', free: '無料',
      asked: 'あなたの価格', with_pass: 'サポーターパスに含まれる', drop: '限定ドロップ',
      basis_similar: '似ている項目をもとにしています。', basis_category: 'カテゴリをもとにしています。まだよく似た項目はありません。',
      basis_complexity: '機能から見積もりました。ストアにはまだ似たものがありません。',
      omitted: '件の軽微な項目は省略しています。', submitted: '送信日', priority: 'サポーター、優先レビュー', resend: '投稿フォームを開く',
    },
    zh: {
      title: '你的投稿', loading: '加载中…',
      bad_link: '这个链接打不开任何投稿。请确认复制了完整链接。',
      offline: '审核服务器没有响应。请一分钟后再试。',
      retry: '重试', rate: '来自此网络的请求过多。请稍后再试。',
      s_pending: '审核中。下面是自动检查的结果，之后会有人工审核。',
      s_fix: '快好了。修正下面的问题后，从同一个表单发送新版本。',
      s_free: '可以免费发布。', s_sellable: '可以上架商店。',
      s_approved: '已发布。', s_rejected: '未发布。',
      open_entry: '在目录中打开', note: '审核人的备注',
      good: '已经做得好的地方', todo: '要做的事', none: '没有需要修正的地方。',
      show_all: '全部显示', where: '位置', why: '原因', how: '修正方法', example: '示例',
      sev_block: '必须修正', sev_fix: '需要修正', sev_tip: '建议',
      sum_block: "必须修复：{n} 项。修复之前无法进入商店。", sum_fix: "需要修复：{n} 项。最好在下一个版本前完成。",
      eff_quick: '几分钟', eff_medium: '一小时以内', eff_long: '几个小时',
      scores: '评分', sec_security: '安全', sec_works: '与描述一致', sec_efficiency: '效率',
      sec_design: '设计', sec_listing: '商店信息', sec_price: '价格',
      price: '建议价格', price_note: '价格由你决定。这里是建议价格和理由。',
      similar: '类似的条目', stars: '星', installs: '次安装', free: '免费',
      asked: '你的定价', with_pass: '包含在支持者通行证中', drop: '限量发布',
      basis_similar: '参考了类似的条目。', basis_category: '参考了所属类别；目前还没有很相似的条目。',
      basis_complexity: '根据功能估算；商店里还没有类似的条目。',
      omitted: '个次要问题未列出。', submitted: '提交于', priority: '支持者，优先审核', resend: '打开投稿表单',
    },
  };

  /** "#sub_abc.TOKEN" → { id, token }, or null when it is not that shape. */
  function parseHash(hash) {
    var m = /^#?(sub_[0-9a-f]{1,32})\.([A-Za-z0-9_-]{43})$/.exec(String(hash || ''));
    return m ? { id: m[1], token: m[2] } : null;
  }

  /** The sentence that says where the submission stands. */
  function statusKey(sub) {
    if (!sub) return 'bad_link';
    if (sub.status === 'approved') return 's_approved';
    if (sub.status === 'rejected') return 's_rejected';
    var outcome = sub.report && sub.report.source === 'review' ? sub.report.outcome : '';
    if (outcome === 'fix' || outcome === 'free' || outcome === 'sellable') return 's_' + outcome;
    return 's_pending';
  }

  function money(n) {
    return Number(n) > 0 ? Number(n).toFixed(2) + ' USD' : null;
  }

  // What a similar entry costs today: a price, free, or part of something
  // that has no price of its own (the supporter pass, a limited drop).
  function compPrice(c) {
    if (c.access === 'supporters') return { key: 'with_pass' };
    if (c.access === 'item') return { key: 'drop' };
    var m = money(c.price);
    return m ? { text: m } : { key: 'free' };
  }

  // The lines above the findings: how many must and should be fixed, heaviest
  // first, each with its sentence. Tips are not counted: they never hold it back.
  function summaryLines(list, tr) {
    return ['block', 'fix'].map(function (k) {
      var n = (list || []).filter(function (f) { return f && f.severity === k; }).length;
      return { severity: k, text: tr('sum_' + k).replace('{n}', n), n: n };
    }).filter(function (l) { return l.n > 0; });
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { STRINGS: STRINGS, LANGS: LANGS, SECTION_KEYS: SECTION_KEYS, parseHash: parseHash, statusKey: statusKey, money: money, compPrice: compPrice, summaryLines: summaryLines };
    return;
  }

  // ── Page ───────────────────────────────────────────────────────────────────

  var lang = (function () {
    try {
      var s = localStorage.getItem('xenon.site.lang');
      if (LANGS.indexOf(s) >= 0) return s;
    } catch (e) { /* private mode */ }
    var n = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return LANGS.indexOf(n) >= 0 ? n : 'en';
  })();
  function T(key) { return (STRINGS[lang] || {})[key] || STRINGS.en[key] || key; }

  var root = document.getElementById('st-root');

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function finding(f) {
    var box = el('li', 'st-f st-' + f.severity);
    box.append(el('p', 'st-f-head', f.what));
    var meta = el('p', 'st-f-meta');
    meta.append(el('span', 'st-sev', T('sev_' + f.severity)), document.createTextNode(', ' + T('eff_' + f.effort)));
    box.append(meta);
    // A file:line reads as code; "Screenshot 2, top half" does not.
    if (f.where) box.append(labelled('where', f.where, /^[^\s]+\.[a-z]+(:\d+)?$/i.test(f.where) ? 'st-mono' : ''));
    if (f.why) box.append(labelled('why', f.why));
    if (f.fix) box.append(labelled('how', f.fix));
    if (f.example) {
      var pre = el('pre', 'st-ex');
      pre.append(el('code', null, f.example));
      box.append(el('p', 'st-lab', T('example')), pre);
    }
    return box;
  }

  function labelled(key, text, cls) {
    var p = el('p', 'st-line' + (cls ? ' ' + cls : ''));
    p.append(el('span', 'st-lab-in', T(key) + ': '), document.createTextNode(text));
    return p;
  }

  function findingsBlock(report) {
    var wrap = el('section', 'st-card');
    wrap.append(el('h2', null, T('todo')));
    var list = report.findings || [];
    if (!list.length) { wrap.append(el('p', 'st-muted', T('none'))); return wrap; }
    // What the list adds up to comes first, so the weight is seen before the detail.
    var sum = el('div', 'st-sum');
    summaryLines(list, T).forEach(function (l) { sum.append(el('p', 'st-' + l.severity, l.text)); });
    if (sum.childNodes.length) wrap.append(sum);
    var ul = el('ul', 'st-list');
    list.forEach(function (f, i) {
      var li = finding(f);
      if (i >= FIRST_FINDINGS) li.hidden = true;
      ul.append(li);
    });
    wrap.append(ul);
    if (list.length > FIRST_FINDINGS) {
      var more = el('button', 'st-btn', T('show_all') + ' (' + list.length + ')');
      more.type = 'button';
      more.addEventListener('click', function () {
        ul.querySelectorAll('li[hidden]').forEach(function (li) { li.hidden = false; });
        more.remove();
      });
      wrap.append(more);
    }
    if (report.omitted > 0) wrap.append(el('p', 'st-muted', report.omitted + ' ' + T('omitted')));
    return wrap;
  }

  function scoresBlock(scores) {
    var wrap = el('section', 'st-card');
    wrap.append(el('h2', null, T('scores')));
    var dl = el('dl', 'st-scores');
    // Price is advice, not a grade: it has its own block and no score.
    SECTION_KEYS.forEach(function (k) {
      if (k === 'price' || typeof scores[k] !== 'number') return;
      var cell = el('div', 'st-score');
      cell.append(el('dt', null, T('sec_' + k)), el('dd', null, String(scores[k])));
      dl.append(cell);
    });
    wrap.append(dl);
    return wrap;
  }

  function priceBlock(price) {
    var wrap = el('section', 'st-card');
    wrap.append(el('h2', null, T('price')));
    // No suggestion (the audit did not pass) is not the same as free.
    if (typeof price.suggested === 'number') {
      wrap.append(el('p', 'st-price', money(price.suggested) || T('free')));
      wrap.append(el('p', 'st-muted', T('basis_' + price.basis)));
    }
    if (typeof price.asked === 'number') wrap.append(el('p', null, T('asked') + ': ' + (money(price.asked) || T('free'))));
    if (price.reason) wrap.append(el('p', null, price.reason));
    if (price.comparables && price.comparables.length) {
      wrap.append(el('h3', null, T('similar')));
      var ul = el('ul', 'st-comp');
      price.comparables.forEach(function (c) {
        var li = el('li');
        var cp = compPrice(c);
        var parts = [cp.text || T(cp.key)];
        if (typeof c.stars === 'number') parts.push(c.stars.toFixed(1) + ' ' + T('stars'));
        if (typeof c.installs === 'number') parts.push(c.installs + ' ' + T('installs'));
        if (c.id) {
          var a = el('a', null, c.name);
          a.href = '/catalog/' + encodeURIComponent(c.id) + '/';
          li.append(a);
        } else li.append(el('span', null, c.name));
        li.append(el('span', 'st-muted', ', ' + parts.join(', ')));
        ul.append(li);
      });
      wrap.append(ul);
    }
    wrap.append(el('p', 'st-muted', T('price_note')));
    return wrap;
  }

  function render(sub) {
    root.replaceChildren();
    var h1 = el('h1', null, sub.name || T('title'));
    var when = sub.submittedAt ? new Date(sub.submittedAt * 1000).toLocaleDateString(lang) : '';
    var sub1 = el('p', 'st-muted', [sub.kind, sub.version ? 'v' + sub.version : '', when ? T('submitted') + ' ' + when : '',
      sub.priority && sub.status === 'pending' ? T('priority') : '']
      .filter(Boolean).join(', '));
    root.append(h1, sub1);

    var state = el('section', 'st-card st-state st-' + sub.status);
    state.append(el('p', 'st-state-line', T(statusKey(sub))));
    if (sub.status === 'approved' && sub.entryId) {
      var a = el('a', 'st-btn', T('open_entry'));
      a.href = '/catalog/' + encodeURIComponent(sub.entryId) + '/';
      state.append(a);
    }
    if (sub.note) state.append(el('h2', null, T('note')), el('p', 'st-note', sub.note));
    var r = sub.report;
    if (r && r.summary) state.append(el('p', null, r.summary));
    root.append(state);
    if (!r) return;

    if (r.positives && r.positives.length) {
      var good = el('section', 'st-card');
      good.append(el('h2', null, T('good')));
      var ul = el('ul', 'st-good');
      r.positives.forEach(function (p) { ul.append(el('li', null, p)); });
      good.append(ul);
      root.append(good);
    }
    if (sub.status !== 'approved') root.append(findingsBlock(r));
    if (r.scores) root.append(scoresBlock(r.scores));
    if (SHOW_PRICE && r.price) root.append(priceBlock(r.price));
    if (statusKey(sub) === 's_fix') {
      var again = el('a', 'st-btn', T('resend'));
      again.href = '/submit/';
      root.append(again);
    }
  }

  function message(key, withRetry) {
    root.replaceChildren(el('h1', null, T('title')), el('p', 'st-card st-state', T(key)));
    if (withRetry) {
      var b = el('button', 'st-btn', T('retry'));
      b.type = 'button';
      b.addEventListener('click', load);
      root.append(b);
    }
  }

  async function load() {
    var ref = parseHash(location.hash);
    if (!ref) { message('bad_link'); return; }
    message('loading');
    var res;
    try {
      res = await fetch(HUB + '/submission/status', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ref),
        referrerPolicy: 'no-referrer',
      });
    } catch (e) { message('offline', true); return; }
    if (res.status === 404) { message('bad_link'); return; }
    if (res.status === 429) { message('rate', true); return; }
    var out = null;
    try { out = await res.json(); } catch (e) { out = null; }
    if (!out || !out.ok || !out.submission) { message('offline', true); return; }
    render(out.submission);
  }

  document.documentElement.lang = lang;   // the shared header follows <html lang>
  window.addEventListener('hashchange', load);
  load();
})();
