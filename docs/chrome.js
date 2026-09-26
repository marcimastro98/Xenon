/* docs/chrome.js: behaviour of the shared header and footer written by
   tools/site-chrome.mjs into every page except the home.

   - The labels follow the page's language: each page sets <html lang>, and the
     pages that translate themselves in place change it when they do, so a
     MutationObserver on that attribute is the one hook every page shares.
   - The Download key points at the visitor's own installer (permanent asset
     names, no API call); a phone or tablet, which can run none of them, is
     sent to the install section of the home instead.
   - The GitHub star count, from the public API, cached for the session so a
     visitor moving between pages makes one request, and hidden until it has
     a real number.
   Dependency-free and safe to load on any page: it does nothing without #xh. */
(function () {
  'use strict';
  var xh = document.getElementById('xh');
  if (!xh) return;

  var L = {"en":{"screens":"Screens","widgets":"Widgets","demo":"Demo","catalog":"Catalog","create":"Create","support":"Support","help":"Help","download":"Download","menu":"Menu","install":"Install","coffee":"Buy me a coffee","tag":"A free touch dashboard for the screens next to your PC. Windows, with macOS and Linux in beta.","app":"App","guides":"Guides","project":"Project","f.download":"Download","f.demo":"Browser demo","f.catalog":"Catalog","f.create":"Make widgets","f.releases":"Releases","f.edge":"Xenon on the Xeneon Edge","f.tablet":"Tablet or phone as a dashboard","f.phone":"Pairing a phone","f.linux":"Xenon on Linux","f.exe":"Is the installer safe?","f.support":"Supporters","f.faq":"Help and questions","f.privacy":"Privacy","legal":"Xenon is an independent project. Xeneon and iCUE are trademarks of CORSAIR.","hint":"This page is also in English.","home":"Home","crumbs":"Breadcrumb","more":"More guides","f.mac":"Xenon on a Mac","f.widgets":"Every widget","f.deck":"Deck keys","f.claude":"Claude Code on a touchscreen","f.sensor":"A sensor panel for your PC"},"it":{"screens":"Schermi","widgets":"Widget","demo":"Demo","catalog":"Catalogo","create":"Crea","support":"Sostieni","help":"Aiuto","download":"Scarica","menu":"Menu","install":"Installazione","coffee":"Offrimi un caffè","tag":"Una dashboard touch gratuita per gli schermi accanto al tuo PC. Windows, con macOS e Linux in beta.","app":"App","guides":"Guide","project":"Progetto","f.download":"Scarica","f.demo":"Demo nel browser","f.catalog":"Catalogo","f.create":"Crea widget","f.releases":"Release","f.edge":"Xenon sullo Xeneon Edge","f.tablet":"Tablet o telefono come dashboard","f.phone":"Abbinare un telefono","f.linux":"Xenon su Linux","f.exe":"L'installer è sicuro?","f.support":"Sostenitori","f.faq":"Aiuto e domande","f.privacy":"Privacy","legal":"Xenon è un progetto indipendente. Xeneon e iCUE sono marchi di CORSAIR.","hint":"Questa pagina è anche in italiano.","home":"Home","crumbs":"Percorso","more":"Altre guide","f.mac":"Xenon su Mac","f.widgets":"Tutti i widget","f.deck":"Tasti del Deck","f.claude":"Claude Code su uno schermo touch","f.sensor":"Un pannello sensori per il PC"},"es":{"screens":"Pantallas","widgets":"Widgets","demo":"Demo","catalog":"Catálogo","create":"Crear","support":"Apoyar","help":"Ayuda","download":"Descargar","menu":"Menú","install":"Instalación","coffee":"Invítame a un café","tag":"Un panel táctil gratis para las pantallas junto a tu PC. Windows, con macOS y Linux en beta.","app":"App","guides":"Guías","project":"Proyecto","f.download":"Descargar","f.demo":"Demo en el navegador","f.catalog":"Catálogo","f.create":"Crear widgets","f.releases":"Versiones","f.edge":"Xenon en el Xeneon Edge","f.tablet":"Tablet o teléfono como panel","f.phone":"Emparejar un teléfono","f.linux":"Xenon en Linux","f.exe":"¿Es seguro el instalador?","f.support":"Mecenas","f.faq":"Ayuda y preguntas","f.privacy":"Privacidad","legal":"Xenon es un proyecto independiente. Xeneon e iCUE son marcas comerciales de CORSAIR.","hint":"Esta página también está en español.","home":"Inicio","crumbs":"Ruta de navegación","more":"Más guías","f.mac":"Xenon en un Mac","f.widgets":"Todos los widgets","f.deck":"Teclas del Deck","f.claude":"Claude Code en una pantalla táctil","f.sensor":"Un panel de sensores para tu PC"},"ja":{"screens":"画面","widgets":"ウィジェット","demo":"デモ","catalog":"カタログ","create":"つくる","support":"支援","help":"ヘルプ","download":"ダウンロード","menu":"メニュー","install":"インストール","coffee":"コーヒーをおごる","tag":"PCの横にある画面のための、無料のタッチダッシュボード。Windowsに対応し、macOSとLinuxはベータ版です。","app":"アプリ","guides":"ガイド","project":"プロジェクト","f.download":"ダウンロード","f.demo":"ブラウザデモ","f.catalog":"カタログ","f.create":"ウィジェットを作る","f.releases":"リリース","f.edge":"Xeneon EdgeでのXenon","f.tablet":"タブレットやスマートフォンをダッシュボードに","f.phone":"スマートフォンのペアリング","f.linux":"LinuxでのXenon","f.exe":"インストーラーは安全ですか？","f.support":"サポーター","f.faq":"ヘルプとよくある質問","f.privacy":"プライバシー","legal":"Xenonは独立したプロジェクトです。XeneonとiCUEはCORSAIRの商標です。","hint":"このページは日本語でも読めます。","home":"ホーム","crumbs":"パンくずリスト","more":"その他のガイド","f.mac":"MacでのXenon","f.widgets":"すべてのウィジェット","f.deck":"Deckキー","f.claude":"タッチスクリーンでClaude Code","f.sensor":"PCのセンサーパネル"},"ko":{"screens":"화면","widgets":"위젯","demo":"데모","catalog":"카탈로그","create":"만들기","support":"후원","help":"도움말","download":"다운로드","menu":"메뉴","install":"설치","coffee":"커피 한 잔 사주기","tag":"PC 옆 화면을 위한 무료 터치 대시보드. Windows용이며 macOS와 Linux는 베타입니다.","app":"앱","guides":"가이드","project":"프로젝트","f.download":"다운로드","f.demo":"브라우저 데모","f.catalog":"카탈로그","f.create":"위젯 만들기","f.releases":"릴리스","f.edge":"Xeneon Edge에서 쓰는 Xenon","f.tablet":"태블릿이나 휴대폰을 대시보드로","f.phone":"휴대폰 페어링","f.linux":"Linux에서 쓰는 Xenon","f.exe":"설치 프로그램은 안전한가요?","f.support":"후원자","f.faq":"도움말과 질문","f.privacy":"개인정보","legal":"Xenon은 독립 프로젝트입니다. Xeneon과 iCUE는 CORSAIR의 상표입니다.","hint":"이 페이지는 한국어로도 볼 수 있습니다.","home":"홈","crumbs":"이동 경로","more":"다른 가이드","f.mac":"Mac에서 쓰는 Xenon","f.widgets":"모든 위젯","f.deck":"Deck 키","f.claude":"터치스크린에서 쓰는 Claude Code","f.sensor":"PC 센서 패널"},"zh":{"screens":"屏幕","widgets":"小组件","demo":"演示","catalog":"目录","create":"创作","support":"支持","help":"帮助","download":"下载","menu":"菜单","install":"安装","coffee":"请我喝杯咖啡","tag":"一款免费的触控仪表盘，用于电脑旁边的屏幕。支持 Windows，macOS 和 Linux 为 Beta 版。","app":"应用","guides":"指南","project":"项目","f.download":"下载","f.demo":"浏览器演示","f.catalog":"目录","f.create":"制作小组件","f.releases":"版本发布","f.edge":"在 Xeneon Edge 上使用 Xenon","f.tablet":"把平板或手机用作仪表盘","f.phone":"配对手机","f.linux":"在 Linux 上使用 Xenon","f.exe":"安装程序安全吗？","f.support":"支持者","f.faq":"帮助和常见问题","f.privacy":"隐私","legal":"Xenon 是一个独立项目。Xeneon 和 iCUE 是 CORSAIR 的商标。","hint":"本页也有中文版。","home":"首页","crumbs":"面包屑导航","more":"更多指南","f.mac":"在 Mac 上使用 Xenon","f.widgets":"全部小组件","f.deck":"Deck 按键","f.claude":"在触摸屏上使用 Claude Code","f.sensor":"电脑传感器面板"}};

  function lang() {
    var l = String(document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return L[l] ? l : 'en';
  }
  function label() {
    var d = L[lang()];
    var els = document.querySelectorAll('[data-xl]');
    for (var i = 0; i < els.length; i++) {
      var v = d[els[i].getAttribute('data-xl')];
      if (v) els[i].textContent = v;
    }
  }
  label();
  if ('MutationObserver' in window) {
    new MutationObserver(label).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  // Phone menu, and a quieter ground once the page scrolls.
  var btn = document.getElementById('xh-menu');
  if (btn) {
    btn.addEventListener('click', function () {
      var open = xh.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
    });
    var links = xh.querySelectorAll('.xh-mnav a');
    for (var j = 0; j < links.length; j++) links[j].addEventListener('click', function () {
      xh.classList.remove('open'); btn.setAttribute('aria-expanded', 'false');
    });
  }
  window.addEventListener('scroll', function () { xh.classList.toggle('scrolled', window.scrollY > 8); }, { passive: true });

  // Download: the visitor's installer, or the install section on a handheld.
  var dl = document.getElementById('xh-dl');
  if (dl) {
    var uad = navigator.userAgentData;
    var plat = String((uad && uad.platform) || navigator.platform || '') + ' ' + navigator.userAgent;
    var hand = (uad && uad.mobile === true) || /Android|iPhone|iPod|CrOS/i.test(plat) ||
      /iPad/i.test(plat) || (/Mac/i.test(plat) && navigator.maxTouchPoints > 1);
    var BASE = 'https://github.com/marcimastro98/Xenon/releases/latest/download/';
    if (hand) dl.href = '/#install';
    else if (/Mac/i.test(plat)) dl.href = BASE + 'Xenon-macOS-universal.dmg';
    else if (/Linux|X11/i.test(plat)) dl.href = BASE + 'Xenon-Linux-x86_64.AppImage';
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
        xh.parentNode.insertBefore(bar, xh.nextSibling);
      }
    }
  }
  // Choosing a language from the menu is remembered, like on the home page.
  var menuLinks = xh.querySelectorAll('.xh-lang a[hreflang]');
  for (var k = 0; k < menuLinks.length; k++) menuLinks[k].addEventListener('click', function () {
    try { localStorage.setItem('xenon.site.lang', this.getAttribute('hreflang')); } catch (e) {}
  });

  // Stars.
  var box = xh.querySelector('.xh-stars');
  if (box) {
    var show = function (n) {
      if (!n) return;
      box.querySelector('.n').textContent = new Intl.NumberFormat(lang()).format(n);
      box.hidden = false;
    };
    var cached = null;
    try { cached = Number(sessionStorage.getItem('xenon.site.stars')) || null; } catch (e) {}
    if (cached) show(cached);
    else fetch('https://api.github.com/repos/marcimastro98/Xenon', { cache: 'force-cache' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var n = j && j.stargazers_count;
        if (n) { try { sessionStorage.setItem('xenon.site.stars', String(n)); } catch (e) {} show(n); }
      })
      .catch(function () {});
  }
})();
