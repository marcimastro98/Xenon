// The submit form's Discord sign-in. A creator signs in with Discord in a new tab;
// the hub checks they are in the Xenon server and reads the email Discord has
// confirmed, so the reviewer always has a real way to reach them.
//
// This page makes a random secret and sends only its SHA-256 to the hub, which
// carries it through Discord's sign-in. After a yes the sign-in tab lands on
// /submit/signed-in/ with a token the hub signed for that hash, and leaves it in
// localStorage for this tab. The hub hands out the name and email, and takes the
// submission, only with the secret AND that token: a start link someone else built
// would put the token in the victim's browser, never in theirs. The secret stays in
// this tab's sessionStorage, so a reload keeps the sign-in, and the form never
// leaves the page (the Maker hands the code over through localStorage).
(function () {
  'use strict';

  var KEY = 'xenon.submit.identity';
  var TOKEN_KEY = 'xenon.submit.identity.token';
  var DONE_KEY = 'xenon.submit.identity.done'; // written by /submit/signed-in/
  var HEX64 = /^[0-9a-f]{64}$/;
  var POLL_MS = 2500;
  var POLL_FOR_MS = 16 * 60 * 1000; // the hub's sign-in link lasts 15 minutes
  var INVITE = 'https://discord.gg/MBVrw9kZyg';

  var WORDS = {
    en: {
      label: 'Discord account *',
      hint: 'Sign in with Discord to send. You must be in the Xenon server. Only the reviewer sees your Discord name and email, to reach you if something needs fixing.',
      signin: 'Sign in with Discord', again: 'Open Discord again',
      waiting: 'Finish in the Discord tab, then come back here.',
      as: 'Signed in as', change: 'Change', retry: 'Try again', join: 'Join the server',
      not_member: 'This Discord account is not in the Xenon server. Join it, then sign in again.',
      no_email: 'Discord has no confirmed email for this account. Confirm it in Discord (User Settings, My Account), then sign in again.',
      cancelled: 'Sign-in cancelled.',
      failed: 'Discord did not answer. Try again in a moment.',
      expired: 'The sign-in took too long. Try again.',
      required: 'Sign in with Discord first: it is how the reviewer reaches you.',
      old: 'Your Discord sign-in has expired. Sign in again, then send.',
      offline: 'Could not check the sign-in. Check your connection and try again.'
    },
    it: {
      label: 'Account Discord *',
      hint: 'Per inviare accedi con Discord. Devi essere nel server di Xenon. Il tuo nome Discord e la tua email li vede solo chi revisiona, per scriverti se qualcosa non va.',
      signin: 'Accedi con Discord', again: 'Riapri Discord',
      waiting: 'Finisci nella scheda di Discord, poi torna qui.',
      as: 'Accesso come', change: 'Cambia', retry: 'Riprova', join: 'Entra nel server',
      not_member: 'Questo account Discord non è nel server di Xenon. Entra nel server, poi accedi di nuovo.',
      no_email: 'Discord non ha un\'email confermata per questo account. Confermala su Discord (Impostazioni utente, Il mio account), poi accedi di nuovo.',
      cancelled: 'Accesso annullato.',
      failed: 'Discord non ha risposto. Riprova tra poco.',
      expired: 'L\'accesso ha richiesto troppo tempo. Riprova.',
      required: 'Prima accedi con Discord: è così che chi revisiona ti può scrivere.',
      old: 'L\'accesso a Discord è scaduto. Accedi di nuovo, poi invia.',
      offline: 'Non riesco a controllare l\'accesso. Controlla la connessione e riprova.'
    },
    es: {
      label: 'Cuenta de Discord *',
      hint: 'Para enviar, inicia sesión con Discord. Tienes que estar en el servidor de Xenon. Tu nombre de Discord y tu email solo los ve quien revisa, para escribirte si hay que corregir algo.',
      signin: 'Iniciar sesión con Discord', again: 'Abrir Discord de nuevo',
      waiting: 'Termina en la pestaña de Discord y vuelve aquí.',
      as: 'Sesión iniciada como', change: 'Cambiar', retry: 'Reintentar', join: 'Unirse al servidor',
      not_member: 'Esta cuenta de Discord no está en el servidor de Xenon. Únete y vuelve a iniciar sesión.',
      no_email: 'Discord no tiene un email confirmado para esta cuenta. Confírmalo en Discord (Ajustes de usuario, Mi cuenta) y vuelve a iniciar sesión.',
      cancelled: 'Inicio de sesión cancelado.',
      failed: 'Discord no respondió. Inténtalo de nuevo en un momento.',
      expired: 'El inicio de sesión tardó demasiado. Inténtalo de nuevo.',
      required: 'Primero inicia sesión con Discord: así quien revisa puede escribirte.',
      old: 'Tu sesión de Discord ha caducado. Inicia sesión de nuevo y envía.',
      offline: 'No se pudo comprobar el inicio de sesión. Revisa la conexión e inténtalo de nuevo.'
    },
    fr: {
      label: 'Compte Discord *',
      hint: 'Pour envoyer, connectez-vous avec Discord. Vous devez être sur le serveur Xenon. Seul le relecteur voit votre nom Discord et votre e-mail, afin de vous contacter si des corrections sont nécessaires.',
      signin: 'Se connecter avec Discord', again: 'Rouvrir Discord',
      waiting: 'Terminez dans l\'onglet Discord, puis revenez ici.',
      as: 'Connecté en tant que', change: 'Changer', retry: 'Réessayer', join: 'Rejoindre le serveur',
      not_member: 'Ce compte Discord n\'est pas sur le serveur Xenon. Rejoignez-le, puis reconnectez-vous.',
      no_email: 'Discord n\'a pas d\'e-mail confirmé pour ce compte. Confirmez-le dans Discord (Paramètres utilisateur, Mon compte), puis reconnectez-vous.',
      cancelled: 'Connexion annulée.',
      failed: 'Discord n\'a pas répondu. Réessayez dans un instant.',
      expired: 'La connexion a pris trop de temps. Réessayez.',
      required: 'Connectez-vous d\'abord avec Discord : c\'est ainsi que le relecteur peut vous contacter.',
      old: 'Votre connexion Discord a expiré. Reconnectez-vous, puis envoyez.',
      offline: 'Impossible de vérifier la connexion. Vérifiez votre réseau et réessayez.'
    },
    ja: {
      label: 'Discord アカウント *',
      hint: '送信するには Discord でログインしてください。Xenon のサーバーに参加している必要があります。Discord の名前とメールは、修正が必要なときに連絡できるよう確認担当者だけが見ます。',
      signin: 'Discord でログイン', again: 'Discord をもう一度開く',
      waiting: 'Discord のタブで完了してから、ここに戻ってください。',
      as: 'ログイン中:', change: '変更', retry: 'もう一度', join: 'サーバーに参加',
      not_member: 'この Discord アカウントは Xenon のサーバーに参加していません。参加してから、もう一度ログインしてください。',
      no_email: 'このアカウントには Discord で確認済みのメールがありません。Discord (ユーザー設定、マイアカウント) で確認してから、もう一度ログインしてください。',
      cancelled: 'ログインはキャンセルされました。',
      failed: 'Discord から応答がありません。少ししてからもう一度お試しください。',
      expired: 'ログインに時間がかかりすぎました。もう一度お試しください。',
      required: '先に Discord でログインしてください。確認担当者があなたに連絡するために使います。',
      old: 'Discord のログインの有効期限が切れました。もう一度ログインしてから送信してください。',
      offline: 'ログインを確認できませんでした。接続を確認して、もう一度お試しください。'
    },
    ko: {
      label: 'Discord 계정 *',
      hint: '보내려면 Discord로 로그인하세요. Xenon 서버에 들어와 있어야 합니다. Discord 이름과 이메일은 고칠 점이 있을 때 연락할 수 있도록 검토자만 봅니다.',
      signin: 'Discord로 로그인', again: 'Discord 다시 열기',
      waiting: 'Discord 탭에서 마친 뒤 여기로 돌아오세요.',
      as: '로그인:', change: '변경', retry: '다시 시도', join: '서버 참여',
      not_member: '이 Discord 계정은 Xenon 서버에 없습니다. 서버에 참여한 뒤 다시 로그인하세요.',
      no_email: '이 계정에는 Discord에서 인증된 이메일이 없습니다. Discord(사용자 설정, 내 계정)에서 인증한 뒤 다시 로그인하세요.',
      cancelled: '로그인이 취소되었습니다.',
      failed: 'Discord가 응답하지 않았습니다. 잠시 후 다시 시도하세요.',
      expired: '로그인이 너무 오래 걸렸습니다. 다시 시도하세요.',
      required: '먼저 Discord로 로그인하세요. 검토자가 연락할 때 사용합니다.',
      old: 'Discord 로그인이 만료되었습니다. 다시 로그인한 뒤 보내세요.',
      offline: '로그인을 확인할 수 없습니다. 연결을 확인하고 다시 시도하세요.'
    },
    zh: {
      label: 'Discord 账号 *',
      hint: '提交前请用 Discord 登录。你必须在 Xenon 服务器中。你的 Discord 名称和邮箱仅审核者可见，以便需要修改时联系你。',
      signin: '用 Discord 登录', again: '重新打开 Discord',
      waiting: '在 Discord 标签页中完成后，回到这里。',
      as: '已登录：', change: '更换', retry: '重试', join: '加入服务器',
      not_member: '这个 Discord 账号不在 Xenon 服务器中。加入后再登录一次。',
      no_email: '这个账号在 Discord 上没有已验证的邮箱。请在 Discord（用户设置，我的账号）中验证后再登录一次。',
      cancelled: '登录已取消。',
      failed: 'Discord 没有响应。请稍后重试。',
      expired: '登录耗时太久。请重试。',
      required: '请先用 Discord 登录：审核者靠它联系你。',
      old: 'Discord 登录已过期。请重新登录后再提交。',
      offline: '无法确认登录。请检查网络后重试。'
    }
  };
  // What the hub's /submit answers when the sign-in is missing or not usable.
  var SUBMIT_ERRORS = {
    identity_required: 'required', identity_expired: 'old', identity_not_member: 'not_member',
    identity_no_email: 'no_email', identity_cancelled: 'cancelled', identity_failed: 'failed', identity_busy: 'failed'
  };
  var PROBLEMS = ['not_member', 'no_email', 'cancelled', 'failed', 'expired', 'busy', 'offline'];

  var hub = '';
  var lang = 'en';
  var host = null;
  var secret = '';
  var keyHash = '';
  var token = '';
  var who = null;          // { name, username, email } once Discord said yes
  var view = 'idle';       // idle | waiting | ok | problem
  var problem = '';
  var pollTimer = 0;
  var pollUntil = 0;

  function w(key) { return (WORDS[lang] || WORDS.en)[key] || WORDS.en[key] || key; }

  function readStored(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (e) { return ''; }
  }
  function store(key, v) {
    try { if (v) sessionStorage.setItem(key, v); else sessionStorage.removeItem(key); } catch (e) { /* private mode: lives in memory */ }
  }

  // The token the signed-in tab left for this sign-in, if it has arrived. Taken
  // once: another form tab's token (another key) is left where it is.
  function takeToken() {
    if (token || !keyHash) return;
    var done = null;
    try { done = JSON.parse(localStorage.getItem(DONE_KEY) || 'null'); } catch (e) { return; }
    if (!done || done.k !== keyHash || !HEX64.test(String(done.t || ''))) return;
    token = done.t;
    store(TOKEN_KEY, token);
    try { localStorage.removeItem(DONE_KEY); } catch (e) {}
  }

  function newSecret() {
    var bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function sha256Hex(text) {
    var buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // A fresh secret before the button can be pressed, so the click opens the tab
  // straight away (an awaited digest inside the click would trip popup blockers).
  async function prepare(reuse) {
    secret = reuse || newSecret();
    store(KEY, secret);
    token = reuse ? readStored(TOKEN_KEY) : '';
    if (!reuse) store(TOKEN_KEY, '');
    keyHash = await sha256Hex(secret);
    render();
  }

  function startUrl() {
    return hub + '/submit/identity/start?k=' + keyHash + '&lang=' + encodeURIComponent(lang);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = 0;
  }

  function startPolling() {
    stopPolling();
    pollUntil = Date.now() + POLL_FOR_MS;
    pollTimer = setTimeout(pollLoop, POLL_MS);
  }

  async function pollLoop() {
    pollTimer = 0;
    var answer = await ask();
    if (view !== 'waiting') return;
    if (answer === 'pending' || answer === 'offline') {
      if (Date.now() < pollUntil) { pollTimer = setTimeout(pollLoop, POLL_MS); return; }
      setProblem('expired');
    }
  }

  // Asks the hub what Discord said. Returns 'ok', 'pending', 'offline' or a problem.
  async function ask() {
    if (!secret) return 'pending';
    takeToken();
    var out = null;
    try {
      var res = await fetch(hub + '/submit/identity', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: secret, token: token })
      });
      out = await res.json();
    } catch (e) { return 'offline'; }
    if (out && out.ok) {
      stopPolling();
      who = { name: String(out.name || ''), username: String(out.username || ''), email: String(out.email || '') };
      view = 'ok';
      render();
      return 'ok';
    }
    var status = (out && out.status) || 'failed';
    if (status === 'pending') return 'pending';
    if (view === 'waiting') setProblem(status);
    return status;
  }

  function setProblem(status) {
    stopPolling();
    who = null;
    view = 'problem';
    problem = PROBLEMS.indexOf(status) >= 0 ? status : 'failed';
    render();
  }

  // Back to the start with a new secret: the old one may already be spent on
  // another account or an answer the creator wants to replace.
  function reset() {
    stopPolling();
    who = null;
    view = 'idle';
    problem = '';
    keyHash = '';
    token = '';
    render();
    prepare('');
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function button(text, cls, onClick) {
    var b = el('button', cls, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  function signInLink(text) {
    var a = el('a', 'btn ghost id-go', text);
    a.target = '_blank';
    a.rel = 'noopener';
    if (keyHash) a.href = startUrl();
    else a.setAttribute('aria-disabled', 'true');
    a.addEventListener('click', function (ev) {
      if (!keyHash) { ev.preventDefault(); return; }
      view = 'waiting';
      render();
      startPolling();
    });
    return a;
  }

  function render() {
    if (!host) return;
    host.textContent = '';
    host.appendChild(el('span', 'id-label', w('label')));
    host.appendChild(el('p', 'hint id-hint', w('hint')));
    var row = el('div', 'id-row');
    if (view === 'ok' && who) {
      var line = el('p', 'id-who');
      line.appendChild(document.createTextNode(w('as') + ' '));
      line.appendChild(el('b', '', who.name || who.username));
      if (who.username && who.username !== who.name) line.appendChild(document.createTextNode(' (@' + who.username + ')'));
      if (who.email) line.appendChild(el('span', 'id-mail', who.email));
      row.appendChild(line);
      row.appendChild(button(w('change'), 'btn ghost', reset));
    } else if (view === 'problem') {
      row.appendChild(el('p', 'id-problem', w(problem === 'busy' ? 'failed' : problem)));
      if (problem === 'not_member') {
        var join = el('a', 'btn ghost', w('join'));
        join.href = INVITE; join.target = '_blank'; join.rel = 'noopener';
        row.appendChild(join);
      }
      row.appendChild(button(w('retry'), 'btn ghost', reset));
    } else if (view === 'waiting') {
      row.appendChild(el('p', 'id-wait', w('waiting')));
      row.appendChild(signInLink(w('again')));
    } else {
      row.appendChild(signInLink(w('signin')));
    }
    host.appendChild(row);
  }

  // Coming back from the Discord tab: ask at once instead of waiting for the timer.
  function onReturn() {
    if (document.visibilityState !== 'visible' || !secret || view === 'ok') return;
    if (view === 'idle' || view === 'waiting') ask();
  }

  window.XenonSubmitIdentity = {
    mount: function (target, opts) {
      host = target;
      hub = String((opts && opts.hub) || '');
      lang = (opts && opts.lang) || 'en';
      document.addEventListener('visibilitychange', onReturn);
      window.addEventListener('focus', onReturn);
      // The signed-in tab writing the token: ask at once, even if this tab is behind it.
      window.addEventListener('storage', function (ev) { if (ev.key === DONE_KEY && view !== 'ok' && secret) ask(); });
      var kept = readStored(KEY);
      render();
      prepare(kept).then(function () { if (kept) ask(); });
    },
    setLang: function (l) { lang = l; render(); },
    // What /submit needs as `identity`, "<secret>.<token>", only once Discord said yes.
    secret: function () { return view === 'ok' && token ? secret + '.' + token : ''; },
    // The message for an identity_* error from /submit, '' for any other. A spent
    // or refused sign-in goes back to the button.
    errorText: function (err) {
      var key = SUBMIT_ERRORS[err];
      if (!key) return '';
      if (key !== 'required') reset();
      return w(key);
    },
    required: function () { return w('required'); }
  };
})();
