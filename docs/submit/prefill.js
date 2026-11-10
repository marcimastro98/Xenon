// "Send a corrected version": the submit form opened from a status link
// (/submit/#from=<id>.<token>, from the review email or the status page) comes
// back filled with what that submission sent, so a creator asked to change one
// thing changes that thing instead of typing everything again. Every field stays
// editable; the page applies what this returns.
//
// The token stays in the fragment, which never reaches a server log or a Referer,
// and it is taken off the address bar as soon as it is read. The hub returns the
// code and the screenshots only for a submission still waiting: a rejected one
// has its files deleted, so its form comes back with the words only.
(function () {
  'use strict';

  var FROM_RE = /^#from=(sub_[0-9a-f]{1,32})\.([A-Za-z0-9_-]{43})$/;
  var EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

  var WORDS = {
    en: {
      full: 'Filled in with the version you sent. Change what the review asked for and send it: it takes the place of the one waiting.',
      words: 'Filled in with what you wrote last time. Add the share code and the screenshots again, change what the review asked for, then send it.',
      gone: 'This link no longer opens your earlier submission: the most recent email has a new one. You can still fill in the form yourself.',
      failed: 'Your earlier submission could not be loaded right now. Reload the page to try again, or fill in the form yourself.'
    },
    it: {
      full: 'Compilato con la versione che hai inviato. Cambia quello che chiede la revisione e invialo: prende il posto di quella in attesa.',
      words: 'Compilato con quello che avevi scritto. Aggiungi di nuovo il codice di condivisione e gli screenshot, cambia quello che chiede la revisione, poi invialo.',
      gone: 'Questo link non apre più l\'invio precedente: l\'email più recente ne ha uno nuovo. Puoi comunque compilare il modulo a mano.',
      failed: 'Non è stato possibile caricare l\'invio precedente. Ricarica la pagina per riprovare, oppure compila il modulo a mano.'
    },
    es: {
      full: 'Rellenado con la versión que enviaste. Cambia lo que pide la revisión y envíalo: ocupa el lugar de la que está en espera.',
      words: 'Rellenado con lo que escribiste la última vez. Vuelve a añadir el código para compartir y las capturas, cambia lo que pide la revisión y envíalo.',
      gone: 'Este enlace ya no abre tu envío anterior: el correo más reciente trae uno nuevo. Puedes rellenar el formulario tú mismo.',
      failed: 'No se pudo cargar tu envío anterior. Recarga la página para intentarlo de nuevo, o rellena el formulario tú mismo.'
    },
    fr: {
      full: 'Rempli avec la version que vous avez envoyée. Modifiez ce que la relecture demande et envoyez-la : elle remplace celle en attente.',
      words: 'Rempli avec ce que vous aviez écrit. Ajoutez à nouveau le code de partage et les captures, modifiez ce que la relecture demande, puis envoyez.',
      gone: 'Ce lien n\'ouvre plus votre envoi précédent : l\'e-mail le plus récent en contient un nouveau. Vous pouvez toujours remplir le formulaire vous-même.',
      failed: 'Impossible de charger votre envoi précédent pour le moment. Rechargez la page pour réessayer, ou remplissez le formulaire vous-même.'
    },
    ja: {
      full: '送ったバージョンの内容が入っています。レビューで指摘された点を直して送ってください。待機中のものと置き換わります。',
      words: '前回書いた内容が入っています。共有コードとスクリーンショットをもう一度追加し、指摘された点を直してから送ってください。',
      gone: 'このリンクでは前回の投稿を開けません。最新のメールに新しいリンクがあります。フォームは自分で入力することもできます。',
      failed: '前回の投稿を読み込めませんでした。ページを再読み込みするか、フォームを自分で入力してください。'
    },
    ko: {
      full: '보낸 버전의 내용이 채워져 있습니다. 검토에서 요청한 부분을 고쳐서 보내면 대기 중인 버전을 대신합니다.',
      words: '지난번에 쓴 내용이 채워져 있습니다. 공유 코드와 스크린샷을 다시 추가하고, 요청한 부분을 고친 뒤 보내 주세요.',
      gone: '이 링크로는 이전 제출을 열 수 없습니다. 가장 최근 이메일에 새 링크가 있습니다. 양식은 직접 채워도 됩니다.',
      failed: '이전 제출을 불러오지 못했습니다. 페이지를 새로 고쳐 다시 시도하거나 양식을 직접 채워 주세요.'
    },
    zh: {
      full: '已填入你发送的版本。按审核要求修改后发送：它会取代正在等待的那一个。',
      words: '已填入你上次写的内容。请重新添加分享代码和截图，按审核要求修改后再发送。',
      gone: '这个链接已无法打开之前的投稿：最新的邮件里有新链接。你也可以自己填写表单。',
      failed: '暂时无法载入之前的投稿。刷新页面重试，或自己填写表单。'
    }
  };

  /** "#from=sub_x.TOKEN" → { id, token }, or null when it is not that shape. */
  function parseFrom(hash) {
    var m = FROM_RE.exec(String(hash || ''));
    return m ? { id: m[1], token: m[2] } : null;
  }

  function post(hub, path, body) {
    return fetch(hub + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      referrerPolicy: 'no-referrer', cache: 'no-store'
    });
  }

  // One screenshot as a File the form can send again; null when it cannot be had.
  async function shotFile(hub, ref, n) {
    try {
      var res = await post(hub, '/submission/prefill/shot', { id: ref.id, token: ref.token, n: n });
      if (!res.ok) return null;
      var blob = await res.blob();
      var ext = EXT[blob.type];
      return ext ? new File([blob], 'shot-' + n + '.' + ext, { type: blob.type }) : null;
    } catch (e) { return null; }
  }

  /**
   * Resolves to null when the page was not opened from a status link, else to
   * { ref, notice } with, when the hub answered, { status, fields, code, files }.
   * `notice` is the WORDS key the page shows.
   */
  async function load(hub) {
    var ref = parseFrom(location.hash);
    if (!ref) return null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    var res;
    try { res = await post(hub, '/submission/prefill', ref); } catch (e) { return { ref: null, notice: 'failed' }; }
    if (res.status === 404) return { ref: null, notice: 'gone' };
    var out = null;
    try { out = await res.json(); } catch (e) { out = null; }
    if (!res.ok || !out || !out.ok || !out.fields) return { ref: null, notice: 'failed' };
    var files = [];
    for (var n = 1; n <= Math.min(3, Number(out.shots) || 0); n++) {
      var f = await shotFile(hub, ref, n);
      if (f) files.push(f);
    }
    var code = typeof out.code === 'string' ? out.code : '';
    return {
      ref: ref, status: out.status, fields: out.fields, code: code, files: files,
      notice: code ? 'full' : 'words'
    };
  }

  function text(key, lang) {
    return (WORDS[lang] || WORDS.en)[key] || WORDS.en[key];
  }

  window.XenonSubmitPrefill = { load: load, text: text, parseFrom: parseFrom };
})();
