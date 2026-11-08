/* docs/chrome.js: behaviour of the shared header and footer written by
   tools/site-chrome.mjs into every page except the home.

   - The labels follow the page's language: each page sets <html lang>, and the
     pages that translate themselves in place change it when they do, so a
     MutationObserver on that attribute is the one hook every page shares.
   - The Download key points at the visitor's own installer (permanent asset
     names, no API call) and says which system it is for; a phone or tablet,
     which can run none of them, is sent to the install section of the home.
   - While a page's own key is in view it is the main action, and the bar's
     Download stays a plain word until the key has gone by, as on the home.
   - The bar wears the page's sheet until the sheet has gone by, as on the home,
     and the page's contents mark the section on screen.
   Dependency-free and safe to load on any page: it does nothing without #xh. */
(function () {
  'use strict';
  var xh = document.getElementById('xh');
  if (!xh) return;

  var L = {"en":{"demo":"Demo","catalog":"Catalog","help":"Help","download":"Download","menu":"Menu","close":"Close","install":"Install","coffee":"Buy me a coffee","tag":"Free widgets for your PC, on any screen. Windows, with macOS and Linux in beta.","app":"App","guides":"Guides","project":"Project","f.download":"Download","f.demo":"Browser demo","f.catalog":"Catalog","f.create":"Make widgets","f.releases":"Releases","f.edge":"Xenon on the Xeneon Edge","f.tablet":"Tablet or phone as a dashboard","f.phone":"Pairing a phone","f.linux":"Xenon on Linux","f.exe":"Is the installer safe?","f.pawnio":"What is PawnIO?","f.support":"Supporters","f.faq":"Help and questions","f.privacy":"Privacy","legal":"Xenon is an independent project. Xeneon and iCUE are trademarks of CORSAIR. Every other name and logo belongs to its owner.","hint":"This page is also in English.","home":"Home","crumbs":"Breadcrumb","more":"More guides","f.mac":"Xenon on a Mac","f.widgets":"Every widget","f.deck":"Deck keys","f.claude":"Claude Code on a touchscreen","f.codex":"OpenAI Codex on a touchscreen","f.sensor":"A sensor panel for your PC","maker":"Maker","beta":"Beta","supporters":"Supporters","f.maker":"Xenon Maker","f.onescreen":"Xenon on one screen","f.fps":"FPS overlay","f.recorder":"Screen recorder","bit":"Bit lives in the Vitals widget and has opinions about your posture.","cta":"Download for Windows","ctaos":"Download for {os}","ctamac":"Download for macOS","ctalinux":"Download for Linux","ctaany":"Download Xenon","try":"Try it in your browser","onpage":"On this page"},"fr":{"demo":"Démo","catalog":"Catalogue","help":"Aide","download":"Télécharger","menu":"Menu","close":"Fermer","install":"Installer","coffee":"Offrez-moi un café","tag":"Des widgets gratuits pour votre PC, sur tous vos écrans. Windows, avec macOS et Linux en beta.","app":"Application","guides":"Guides","project":"Projet","f.download":"Télécharger","f.demo":"Démo du navigateur","f.catalog":"Catalogue","f.create":"Créer des widgets","f.releases":"Versions","f.edge":"Xenon sur le Xeneon Edge","f.tablet":"Tablette ou téléphone en tant que dashboard","f.phone":"Appairage d'un téléphone","f.linux":"Xenon sur Linux","f.exe":"L’installateur est-il sûr ?","f.pawnio":"PawnIO, c’est quoi ?","f.support":"Supporters","f.faq":"Aide et questions","f.privacy":"Confidentialité","legal":"Xenon est un projet indépendant. Xeneon et iCUE sont des marques déposées de CORSAIR. Les autres noms et logos appartiennent à leurs propriétaires.","hint":"Cette page est également disponible en anglais.","home":"Accueil","crumbs":"Vous êtes ici","more":"Plus de guides","f.mac":"Xenon sur un Mac","f.widgets":"Chaque widget","f.deck":"Touches du Deck","f.claude":"Claude Code sur un écran tactile","f.codex":"OpenAI Codex sur un écran tactile","f.sensor":"Un panneau de capteurs pour votre PC","maker":"Maker","beta":"Beta","supporters":"Supporters","f.maker":"Xenon Maker","f.onescreen":"Xenon sur un seul écran","f.fps":"Overlay FPS","f.recorder":"Enregistrer l’écran","bit":"Bit réside dans le widget Vitals et a des avis sur votre posture.","cta":"Télécharger pour Windows","ctaos":"Télécharger pour {os}","ctamac":"Télécharger pour macOS","ctalinux":"Télécharger pour Linux","ctaany":"Télécharger Xenon","try":"Essayez-le dans le navigateur","onpage":"Sur cette page"},"it":{"demo":"Demo","catalog":"Catalogo","help":"Aiuto","download":"Scarica","menu":"Menu","close":"Chiudi","install":"Installazione","coffee":"Offrimi un caffè","tag":"Widget gratis per il tuo PC, su ogni schermo. Windows, con macOS e Linux in beta.","app":"App","guides":"Guide","project":"Progetto","f.download":"Scarica","f.demo":"Demo nel browser","f.catalog":"Catalogo","f.create":"Crea widget","f.releases":"Release","f.edge":"Xenon sullo Xeneon Edge","f.tablet":"Tablet o telefono come dashboard","f.phone":"Abbinare un telefono","f.linux":"Xenon su Linux","f.exe":"L'installer è sicuro?","f.pawnio":"Cos'è PawnIO?","f.support":"Sostenitori","f.faq":"Aiuto e domande","f.privacy":"Privacy","legal":"Xenon è un progetto indipendente. Xeneon e iCUE sono marchi di CORSAIR. Ogni altro nome e logo appartiene al suo proprietario.","hint":"Questa pagina è anche in italiano.","home":"Home","crumbs":"Percorso","more":"Altre guide","f.mac":"Xenon su Mac","f.widgets":"Tutti i widget","f.deck":"Tasti del Deck","f.claude":"Claude Code su uno schermo touch","f.codex":"OpenAI Codex su uno schermo touch","f.sensor":"Un pannello sensori per il PC","maker":"Maker","beta":"Beta","supporters":"Sostenitori","f.maker":"Xenon Maker","f.onescreen":"Xenon su un solo schermo","f.fps":"Overlay FPS","f.recorder":"Registrare lo schermo","bit":"Bit vive nel widget Vitals e ha opinioni sulla tua postura.","cta":"Scarica per Windows","ctaos":"Scarica per {os}","ctamac":"Scarica per macOS","ctalinux":"Scarica per Linux","ctaany":"Scarica Xenon","try":"Provalo nel browser","onpage":"In questa pagina"},"es":{"demo":"Demo","catalog":"Catálogo","help":"Ayuda","download":"Descargar","menu":"Menú","close":"Cerrar","install":"Instalación","coffee":"Invítame a un café","tag":"Widgets gratis para tu PC, en cualquier pantalla. Windows, con macOS y Linux en beta.","app":"App","guides":"Guías","project":"Proyecto","f.download":"Descargar","f.demo":"Demo en el navegador","f.catalog":"Catálogo","f.create":"Crear widgets","f.releases":"Versiones","f.edge":"Xenon en el Xeneon Edge","f.tablet":"Tablet o teléfono como panel","f.phone":"Emparejar un teléfono","f.linux":"Xenon en Linux","f.exe":"¿Es seguro el instalador?","f.pawnio":"¿Qué es PawnIO?","f.support":"Mecenas","f.faq":"Ayuda y preguntas","f.privacy":"Privacidad","legal":"Xenon es un proyecto independiente. Xeneon e iCUE son marcas comerciales de CORSAIR. Los demás nombres y logotipos pertenecen a sus propietarios.","hint":"Esta página también está en español.","home":"Inicio","crumbs":"Ruta de navegación","more":"Más guías","f.mac":"Xenon en un Mac","f.widgets":"Todos los widgets","f.deck":"Teclas del Deck","f.claude":"Claude Code en una pantalla táctil","f.codex":"OpenAI Codex en una pantalla táctil","f.sensor":"Un panel de sensores para tu PC","maker":"Maker","beta":"Beta","supporters":"Mecenas","f.maker":"Xenon Maker","f.onescreen":"Xenon en una sola pantalla","f.fps":"Overlay de FPS","f.recorder":"Grabar la pantalla","bit":"Bit vive en el widget Vitals y tiene opiniones sobre tu postura.","cta":"Descargar para Windows","ctaos":"Descargar para {os}","ctamac":"Descargar para macOS","ctalinux":"Descargar para Linux","ctaany":"Descargar Xenon","try":"Pruébalo en el navegador","onpage":"En esta página"},"ja":{"demo":"デモ","catalog":"カタログ","help":"ヘルプ","download":"ダウンロード","menu":"メニュー","close":"閉じる","install":"インストール","coffee":"コーヒーをおごる","tag":"どの画面でも使える無料のPCウィジェット。Windowsに対応し、macOSとLinuxはベータ版です。","app":"アプリ","guides":"ガイド","project":"プロジェクト","f.download":"ダウンロード","f.demo":"ブラウザデモ","f.catalog":"カタログ","f.create":"ウィジェットを作る","f.releases":"リリース","f.edge":"Xeneon EdgeでのXenon","f.tablet":"タブレットやスマートフォンをダッシュボードに","f.phone":"スマートフォンのペアリング","f.linux":"LinuxでのXenon","f.exe":"インストーラーは安全ですか？","f.pawnio":"PawnIOとは","f.support":"サポーター","f.faq":"ヘルプとよくある質問","f.privacy":"プライバシー","legal":"Xenonは独立したプロジェクトです。XeneonとiCUEはCORSAIRの商標です。その他の名称とロゴは各所有者に帰属します。","hint":"このページは日本語でも読めます。","home":"ホーム","crumbs":"パンくずリスト","more":"その他のガイド","f.mac":"MacでのXenon","f.widgets":"すべてのウィジェット","f.deck":"Deckキー","f.claude":"タッチスクリーンでClaude Code","f.codex":"タッチスクリーンで OpenAI Codex","f.sensor":"PCのセンサーパネル","maker":"Maker","beta":"ベータ","supporters":"サポーター","f.maker":"Xenon Maker","f.onescreen":"1台の画面でXenonを使う","f.fps":"FPSオーバーレイ","f.recorder":"画面録画","bit":"BitはVitalsウィジェットに住んでいて、あなたの姿勢にひとこと言います。","cta":"Windows版をダウンロード","ctaos":"{os}版をダウンロード","ctamac":"macOS版をダウンロード","ctalinux":"Linux版をダウンロード","ctaany":"Xenonをダウンロード","try":"ブラウザで試す","onpage":"このページの内容"},"ko":{"demo":"데모","catalog":"카탈로그","help":"도움말","download":"다운로드","menu":"메뉴","close":"닫기","install":"설치","coffee":"커피 한 잔 사주기","tag":"어떤 화면에서든 쓰는 무료 PC 위젯. Windows용이며 macOS와 Linux는 베타입니다.","app":"앱","guides":"가이드","project":"프로젝트","f.download":"다운로드","f.demo":"브라우저 데모","f.catalog":"카탈로그","f.create":"위젯 만들기","f.releases":"릴리스","f.edge":"Xeneon Edge에서 쓰는 Xenon","f.tablet":"태블릿이나 휴대폰을 대시보드로","f.phone":"휴대폰 페어링","f.linux":"Linux에서 쓰는 Xenon","f.exe":"설치 프로그램은 안전한가요?","f.pawnio":"PawnIO란?","f.support":"후원자","f.faq":"도움말과 질문","f.privacy":"개인정보","legal":"Xenon은 독립 프로젝트입니다. Xeneon과 iCUE는 CORSAIR의 상표입니다. 그 밖의 이름과 로고는 각 소유자의 것입니다.","hint":"이 페이지는 한국어로도 볼 수 있습니다.","home":"홈","crumbs":"이동 경로","more":"다른 가이드","f.mac":"Mac에서 쓰는 Xenon","f.widgets":"모든 위젯","f.deck":"Deck 키","f.claude":"터치스크린에서 쓰는 Claude Code","f.codex":"터치스크린에서 쓰는 OpenAI Codex","f.sensor":"PC 센서 패널","maker":"Maker","beta":"베타","supporters":"후원자","f.maker":"Xenon Maker","f.onescreen":"화면 하나로 쓰는 Xenon","f.fps":"FPS 오버레이","f.recorder":"화면 녹화","bit":"Bit는 Vitals 위젯에 살면서 자세에 대해 한마디씩 합니다.","cta":"Windows용 다운로드","ctaos":"{os}용 다운로드","ctamac":"macOS용 다운로드","ctalinux":"Linux용 다운로드","ctaany":"Xenon 다운로드","try":"브라우저에서 체험하기","onpage":"이 페이지 내용"},"zh":{"demo":"演示","catalog":"目录","help":"帮助","download":"下载","menu":"菜单","close":"关闭","install":"安装","coffee":"请我喝杯咖啡","tag":"任何屏幕都能用的免费电脑小组件。支持 Windows，macOS 和 Linux 为 Beta 版。","app":"应用","guides":"指南","project":"项目","f.download":"下载","f.demo":"浏览器演示","f.catalog":"目录","f.create":"制作小组件","f.releases":"版本发布","f.edge":"在 Xeneon Edge 上使用 Xenon","f.tablet":"把平板或手机用作仪表盘","f.phone":"配对手机","f.linux":"在 Linux 上使用 Xenon","f.exe":"安装程序安全吗？","f.pawnio":"PawnIO 是什么？","f.support":"支持者","f.faq":"帮助和常见问题","f.privacy":"隐私","legal":"Xenon 是一个独立项目。Xeneon 和 iCUE 是 CORSAIR 的商标。其他名称和标志归各自所有者所有。","hint":"本页也有中文版。","home":"首页","crumbs":"面包屑导航","more":"更多指南","f.mac":"在 Mac 上使用 Xenon","f.widgets":"全部小组件","f.deck":"Deck 按键","f.claude":"在触摸屏上使用 Claude Code","f.codex":"在触摸屏上使用 OpenAI Codex","f.sensor":"电脑传感器面板","maker":"Maker","beta":"Beta","supporters":"支持者","f.maker":"Xenon Maker","f.onescreen":"在一块屏幕上使用 Xenon","f.fps":"FPS 叠加层","f.recorder":"屏幕录制","bit":"Bit 住在 Vitals 小组件里，对你的坐姿很有意见。","cta":"下载 Windows 版","ctaos":"下载 {os} 版","ctamac":"下载 macOS 版","ctalinux":"下载 Linux 版","ctaany":"下载 Xenon","try":"在浏览器中试用","onpage":"本页内容"}};

  function lang() {
    var l = String(document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return L[l] ? l : 'en';
  }
  // The visitor's system, named on <html> for the key's glyph in site.css. A handheld
  // runs no installer, so it gets the plain name and no glyph.
  var uad = navigator.userAgentData;
  var plat = String((uad && uad.platform) || navigator.platform || '') + ' ' + navigator.userAgent;
  var hand = (uad && uad.mobile === true) || /Android|iPhone|iPod|CrOS/i.test(plat) ||
    /iPad/i.test(plat) || (/Mac/i.test(plat) && navigator.maxTouchPoints > 1);
  var os = hand ? 'none' : /Mac/i.test(plat) ? 'macos' : /Linux|X11/i.test(plat) ? 'linux' : 'windows';
  var OS_NAME = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
  document.documentElement.setAttribute('data-os', os);

  function keyLabel(d) {
    return os === 'none' ? d.ctaany : d.ctaos.replace('{os}', OS_NAME[os]);
  }
  function label() {
    var d = L[lang()];
    var els = document.querySelectorAll('[data-xl]');
    for (var i = 0; i < els.length; i++) {
      var k = els[i].getAttribute('data-xl');
      var v = k === 'cta' ? keyLabel(d) : d[k];
      if (v) els[i].textContent = v;
    }
  }
  label();
  if ('MutationObserver' in window) {
    new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  // Phone and tablet menu: a sheet over the page. It locks the page behind it,
  // closes with Escape, with a link, with its own close button, or when the
  // window grows into the wide layout, and it hands the focus back to the icon.
  var btn = document.getElementById('xh-menu');
  var sheet = document.getElementById('xh-mnav');
  var closeBtn = document.getElementById('xh-mclose');
  function setMenu(open) {
    if (!btn || !sheet || xh.classList.contains('open') === open) return;
    xh.classList.toggle('open', open);
    document.documentElement.classList.toggle('xh-lock', open);
    btn.setAttribute('aria-expanded', String(open));
    if (open) { if (closeBtn) closeBtn.focus(); }
    else btn.focus();
  }
  if (btn && sheet) {
    btn.addEventListener('click', function () { setMenu(!xh.classList.contains('open')); });
    if (closeBtn) closeBtn.addEventListener('click', function () { setMenu(false); });
    var links = sheet.querySelectorAll('a');
    for (var j = 0; j < links.length; j++) links[j].addEventListener('click', function () {
      // A link to a section of this very page must not leave the page locked;
      // dropping focus() here keeps the jump to the anchor where it was aimed.
      xh.classList.remove('open'); document.documentElement.classList.remove('xh-lock');
      btn.setAttribute('aria-expanded', 'false');
    });
    document.addEventListener('keydown', function (e) {
      if (!xh.classList.contains('open')) return;
      if (e.key === 'Escape') { setMenu(false); return; }
      if (e.key !== 'Tab') return;
      var f = sheet.querySelectorAll('a[href], button');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    if (window.matchMedia) {
      var wide = window.matchMedia('(min-width: 1181px)');
      var onWide = function (m) { if (m.matches) setMenu(false); };
      if (wide.addEventListener) wide.addEventListener('change', onWide); else if (wide.addListener) wide.addListener(onWide);
    }
  }
  window.addEventListener('scroll', function () { xh.classList.toggle('scrolled', window.scrollY > 8); }, { passive: true });

  var sheetTop = document.querySelector('.pg');
  if (sheetTop && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (es) { xh.classList.toggle('off', !es[0].isIntersecting); }, { rootMargin: '-64px 0px 0px 0px' }).observe(sheetTop);
  }

  // The contents beside a guide: the link of the section being read is the marked one.
  var jumps = document.querySelectorAll('.jump a[href^="#"]');
  if (jumps.length && 'IntersectionObserver' in window) {
    var byId = {};
    var spy = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        Array.prototype.forEach.call(jumps, function (a) { a.removeAttribute('aria-current'); });
        byId[e.target.id].setAttribute('aria-current', 'location');
      });
    }, { rootMargin: '-96px 0px -70% 0px' });
    Array.prototype.forEach.call(jumps, function (a) {
      var id = decodeURIComponent(a.getAttribute('href').slice(1));
      var target = document.getElementById(id);
      if (!target) return;
      byId[id] = a;
      spy.observe(target);
    });
  }

  // Download: the visitor's installer, or the install section on a handheld.
  var dls = document.querySelectorAll('#xh-dl, [data-dl]');
  var BASE = 'https://github.com/marcimastro98/Xenon/releases/latest/download/';
  var target = { none: '/#install', macos: BASE + 'Xenon-macOS-universal.dmg', linux: BASE + 'Xenon-Linux-x86_64.AppImage' }[os];
  if (target) Array.prototype.forEach.call(dls, function (a) { a.href = target; });

  // One main action in view: the bar's Download fills only while none of the page's own keys
  // is on screen. A page can hold keys it has not shown yet, so each one is watched.
  var pageKeys = document.querySelectorAll('.pg-key');
  var barKey = document.getElementById('xh-dl');
  if (pageKeys.length && barKey && 'IntersectionObserver' in window) {
    var onScreen = new Set();
    var keyWatch = new IntersectionObserver(function (es) {
      es.forEach(function (e) { onScreen[e.isIntersecting ? 'add' : 'delete'](e.target); });
      barKey.classList.toggle('lit', !onScreen.size);
    }, { rootMargin: '-64px 0px 0px 0px' });
    Array.prototype.forEach.call(pageKeys, function (k) { keyWatch.observe(k); });
  }

  // A page published in the visitor's own language says so, once, as a link at
  // the top of the page. Never a redirect: the address someone opened, or a
  // crawler followed, always serves what it says it serves.
  var langs = (document.documentElement.getAttribute('data-langs') || '').split(',').filter(Boolean);
  var here = (document.documentElement.lang || 'en').slice(0, 2);
  if (langs.length > 1) {
    var want = null;
    try { want = localStorage.getItem('xenon.site.lang'); } catch (e) {}
    want = String(want || (navigator.languages && navigator.languages[0]) || navigator.language || '').slice(0, 2).toLowerCase();
    if (want && want !== here && langs.indexOf(want) > -1 && L[want] && L[want].hint) {
      var cur = xh.querySelector('.xh-lang a[hreflang="' + want + '"]');
      if (cur) {
        var bar = document.createElement('a');
        bar.className = 'xh-hint';
        bar.href = cur.getAttribute('href');
        bar.lang = want;
        bar.textContent = L[want].hint;
        // On a sheet it stands above the title, in the sheet's ink.
        var copy = document.querySelector('.pg-copy');
        if (copy) copy.insertBefore(bar, copy.firstChild);
        else xh.parentNode.insertBefore(bar, xh.nextSibling);
      }
    }
  }
  // Choosing a language from the menu is remembered, like on the home page.
  var menuLinks = xh.querySelectorAll('.xh-lang a[hreflang]');
  for (var k = 0; k < menuLinks.length; k++) menuLinks[k].addEventListener('click', function () {
    try { localStorage.setItem('xenon.site.lang', this.getAttribute('hreflang')); } catch (e) {}
  });

  // The month's drops (docs/promo.js): the strip above this header is on every page, so every
  // page that carries the shared header loads it. The home loads it itself.
  if (!document.querySelector('script[src="/promo.js"]')) {
    var ps = document.createElement('script');
    ps.src = '/promo.js';
    ps.defer = true;
    document.head.appendChild(ps);
  }
  // The numbers beside the bar's marks (docs/counts.js).
  var cs = document.createElement('script');
  cs.src = '/counts.js';
  cs.defer = true;
  document.head.appendChild(cs);
})();
