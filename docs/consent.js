// Cookie consent banner for the Xenon site (xenon-app.com).
//
// Pairs with the inline Consent Mode v2 block in each page's <head>. That block
// is what actually gates the tags — it must run before gtag.js, so it cannot
// live here. This file only owns the UI and the user's choice:
//
//   1. render the banner when no choice is stored;
//   2. push `consent: update` to gtag the moment the user picks;
//   3. persist the pick so the inline block can replay it on the next page.
//
// The banner is shown everywhere, but the *default* differs by region (see the
// inline block): denied in the EEA/UK/CH where prior consent is required, and
// granted elsewhere. So for a visitor outside the EEA the banner is a courtesy
// they can dismiss — for one inside it, nothing is measured until they accept.
//
// Self-contained on purpose: the site's i18n dictionary lives inside index.html
// only, and this script also runs on /get, /catalog, /create and /submit. It
// carries its own strings for the same five languages and follows the language
// the site persists under `xenon.site.lang`.
(function () {
  'use strict';

  var STORE_KEY = 'xenon.site.consent';
  var LANG_KEY = 'xenon.site.lang';
  var LANGS = ['en', 'it', 'ko', 'ja', 'zh'];

  var STR = {
    en: {
      title: 'Cookies on this site',
      body: 'The Xenon app on your PC sends no telemetry — that does not change. This website is separate: it uses Google Analytics to see which pages and downloads people actually reach.',
      accept: 'Accept',
      reject: 'Reject',
      more: 'Privacy policy',
    },
    it: {
      title: 'Cookie su questo sito',
      body: "L'app Xenon sul tuo PC non manda telemetria — e questo non cambia. Il sito è un'altra cosa: usa Google Analytics per capire quali pagine e download vengono davvero raggiunti.",
      accept: 'Accetta',
      reject: 'Rifiuta',
      more: 'Informativa privacy',
    },
    ko: {
      title: '이 사이트의 쿠키',
      body: 'PC의 Xenon 앱은 텔레메트리를 보내지 않습니다 — 이 점은 변하지 않습니다. 웹사이트는 별개입니다: 어떤 페이지와 다운로드가 실제로 사용되는지 확인하기 위해 Google Analytics를 사용합니다.',
      accept: '동의',
      reject: '거부',
      more: '개인정보 처리방침',
    },
    ja: {
      title: 'このサイトのCookie',
      body: 'お使いのPC上のXenonアプリはテレメトリを送信しません — これは変わりません。ウェブサイトは別です: どのページとダウンロードが実際に利用されているかを把握するためGoogle Analyticsを使用します。',
      accept: '同意する',
      reject: '拒否する',
      more: 'プライバシーポリシー',
    },
    zh: {
      title: '本网站的 Cookie',
      body: '您电脑上的 Xenon 应用不发送遥测数据 — 这一点不会改变。网站则是另一回事：它使用 Google Analytics 来了解哪些页面和下载真正被访问。',
      accept: '接受',
      reject: '拒绝',
      more: '隐私政策',
    },
  };

  function lang() {
    var l = null;
    try { l = localStorage.getItem(LANG_KEY); } catch (e) { /* private mode */ }
    if (LANGS.indexOf(l) !== -1) return l;
    var wanted = (navigator.languages || [navigator.language || 'en']);
    for (var i = 0; i < wanted.length; i++) {
      var s = String(wanted[i]).slice(0, 2).toLowerCase();
      if (LANGS.indexOf(s) !== -1) return s;
    }
    return 'en';
  }

  function t(key) {
    var d = STR[lang()] || STR.en;
    return d[key] != null ? d[key] : STR.en[key];
  }

  // gtag may be missing entirely (adblocker stripped the tag). Storing the
  // choice still matters — it keeps the banner from reappearing every visit.
  function pushConsent(granted) {
    var v = granted ? 'granted' : 'denied';
    try {
      if (typeof window.gtag === 'function') {
        window.gtag('consent', 'update', {
          ad_storage: v,
          ad_user_data: v,
          ad_personalization: v,
          analytics_storage: v,
        });
      }
    } catch (e) { /* consent is best-effort, never fatal */ }
  }

  function stored() {
    try {
      var v = localStorage.getItem(STORE_KEY);
      return v === 'granted' || v === 'denied' ? v : null;
    } catch (e) { return null; }
  }

  function remember(v) {
    try { localStorage.setItem(STORE_KEY, v); } catch (e) { /* private mode */ }
  }

  var STYLE = [
    '#xc-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9000;',
    'max-width:520px;margin:0 auto;padding:20px 22px;border-radius:14px;',
    'background:rgba(14,16,15,0.92);backdrop-filter:blur(14px);',
    '-webkit-backdrop-filter:blur(14px);border:1px solid rgba(240,243,241,0.12);',
    'box-shadow:0 18px 60px rgba(0,0,0,0.55);color:#f0f3f1;',
    "font-family:'Inter',system-ui,-apple-system,sans-serif;",
    'opacity:0;transform:translateY(14px);',
    'transition:opacity .45s cubic-bezier(0.16,1,0.3,1),transform .45s cubic-bezier(0.16,1,0.3,1)}',
    '#xc-consent.in{opacity:1;transform:none}',
    '#xc-consent h2{margin:0 0 8px;font-size:15px;font-weight:650;letter-spacing:-0.01em}',
    '#xc-consent p{margin:0 0 16px;font-size:13.5px;line-height:1.6;color:#9aa8a1}',
    '#xc-consent .xc-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '#xc-consent button{flex:1 1 0;min-width:120px;min-height:44px;padding:11px 18px;',
    "border-radius:11px;font-family:inherit;font-size:13.5px;font-weight:600;cursor:pointer;",
    'border:1px solid transparent;transition:background .2s,border-color .2s,color .2s}',
    '#xc-consent .xc-yes{background:#1ed760;color:#052012}',
    '#xc-consent .xc-yes:hover{background:#2ee36f}',
    '#xc-consent .xc-no{background:transparent;border-color:rgba(240,243,241,0.22);color:#f0f3f1}',
    '#xc-consent .xc-no:hover{border-color:#1ed760;color:#1ed760}',
    '#xc-consent a{display:inline-block;margin-top:12px;font-size:12.5px;color:#66736c;',
    'text-decoration:underline;text-underline-offset:3px}',
    '#xc-consent a:hover{color:#1ed760}',
    '@media (max-width:520px){#xc-consent .xc-row{flex-direction:column}',
    '#xc-consent button{width:100%;flex:none}}',
    '@media (prefers-reduced-motion:reduce){#xc-consent{transition:none}}',
  ].join('');

  function render() {
    if (document.getElementById('xc-consent')) return;

    // Injected once per page, not once per render — the privacy page can call
    // xenonConsentReset() repeatedly, and re-appending would stack dead <style>
    // nodes in <head> for the life of the document.
    if (!document.getElementById('xc-consent-style')) {
      var style = document.createElement('style');
      style.id = 'xc-consent-style';
      style.textContent = STYLE;
      document.head.appendChild(style);
    }

    var box = document.createElement('div');
    box.id = 'xc-consent';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-label', t('title'));

    var h = document.createElement('h2');
    h.textContent = t('title');

    var p = document.createElement('p');
    p.textContent = t('body');

    var row = document.createElement('div');
    row.className = 'xc-row';

    // Reject sits first and matches Accept in size: refusing must never be the
    // harder path, which is both the legal bar in the EEA and the honest one.
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'xc-no';
    no.textContent = t('reject');

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'xc-yes';
    yes.textContent = t('accept');

    var link = document.createElement('a');
    link.href = '/privacy.html';
    link.textContent = t('more');

    function close(granted) {
      pushConsent(granted);
      remember(granted ? 'granted' : 'denied');
      // Drop the id before the fade-out, not after: while the old banner is
      // still animating out, a reset would otherwise find it by id and
      // early-return, leaving the user staring at a button that did nothing.
      box.removeAttribute('id');
      box.classList.remove('in');
      setTimeout(function () { if (box.parentNode) box.parentNode.removeChild(box); }, 450);
    }

    no.addEventListener('click', function () { close(false); });
    yes.addEventListener('click', function () { close(true); });

    row.appendChild(no);
    row.appendChild(yes);
    box.appendChild(h);
    box.appendChild(p);
    box.appendChild(row);
    box.appendChild(link);
    document.body.appendChild(box);

    // Re-translate live if the visitor switches language while it is open.
    document.addEventListener('xenon:lang', function () {
      box.setAttribute('aria-label', t('title'));
      h.textContent = t('title');
      p.textContent = t('body');
      no.textContent = t('reject');
      yes.textContent = t('accept');
      link.textContent = t('more');
    });

    requestAnimationFrame(function () {
      requestAnimationFrame(function () { box.classList.add('in'); });
    });
  }

  function boot() {
    if (stored()) return; // already chosen — the inline block replayed it
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Lets the privacy page offer a "change your choice" affordance.
  window.xenonConsentReset = function () {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { /* private mode */ }
    render();
  };
})();
