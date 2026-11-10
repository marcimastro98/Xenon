/* docs/counts.js: the live numbers beside the site's marks, from public APIs:
   installer downloads on GitHub and Discord members.

   Every element carrying data-count="dl" or data-count="dc" gets its number as soon
   as it lands. Each is fetched on its own and cached for the session (GitHub allows
   60 anonymous calls an hour per address). A failure leaves the bare mark, never a
   zero. Loaded by the home and, through chrome.js, by every page with the shared bar. */
(function () {
  'use strict';
  var WORDS = {
    en: { dl: '{n} downloads on GitHub', dc: '{n} people on Discord' },
    it: { dl: '{n} download su GitHub', dc: '{n} persone su Discord' },
    es: { dl: '{n} descargas en GitHub', dc: '{n} personas en Discord' },
    fr: { dl: '{n} téléchargements sur GitHub', dc: '{n} personnes sur Discord' },
    ja: { dl: 'GitHub からのダウンロード {n} 回', dc: 'Discord の参加者 {n} 人' },
    ko: { dl: 'GitHub 다운로드 {n}회', dc: 'Discord 멤버 {n}명' },
    zh: { dl: 'GitHub 上 {n} 次下载', dc: 'Discord 上 {n} 人' },
  };
  var REPO = 'https://api.github.com/repos/marcimastro98/Xenon';
  var INVITE = 'https://discord.com/api/v10/invites/MBVrw9kZyg?with_counts=true';

  // Installers only, counted the way the old page did: a release that has the
  // stable-named files (the ones the site links) counts only those, so the app's
  // own updater, which fetches the version-stamped files, is not a person
  // installing Xenon; older releases fall back to the name shape.
  var STABLE = /^Xenon-(Setup-x64\.exe|macOS-universal\.dmg|Linux-x86_64\.(AppImage|deb|rpm))$/i;
  var SHAPE = /setup|\.(dmg|appimage|deb|rpm)$/i;

  function installs(releases) {
    if (!Array.isArray(releases)) return null;
    var total = 0;
    releases.forEach(function (r) {
      if (!r || r.draft) return;
      var assets = (r.assets || []).filter(function (x) { return x && !/\.sig$/i.test(x.name); });
      var stable = assets.some(function (x) { return STABLE.test(x.name); });
      assets.forEach(function (x) {
        if (stable ? STABLE.test(x.name) : SHAPE.test(x.name)) total += x.download_count || 0;
      });
    });
    return total || null;
  }

  function json(url) {
    return fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function cached(key, load) {
    try {
      var kept = sessionStorage.getItem(key);
      if (kept) return Promise.resolve(JSON.parse(kept));
    } catch (e) { /* no storage: fetch it */ }
    return load().then(function (v) {
      if (v != null) { try { sessionStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* no storage */ } }
      return v;
    });
  }

  function lang() {
    var l = String(document.documentElement.lang || 'en').slice(0, 2).toLowerCase();
    return WORDS[l] ? l : 'en';
  }

  function format(n) {
    try { return new Intl.NumberFormat(lang(), { useGrouping: true }).format(n); } catch (e) { return String(n); }
  }

  var known = {};
  function paint(kind) {
    var n = known[kind];
    document.querySelectorAll('[data-count="' + kind + '"]').forEach(function (el) {
      if (!n) { el.remove(); return; }
      el.textContent = format(n);
      var link = el.closest('a');
      if (link) link.title = WORDS[lang()][kind].replace('{n}', format(n));
    });
  }

  function land(kind, n) { known[kind] = n; paint(kind); }

  cached('xenon.site.dl', function () { return json(REPO + '/releases?per_page=100').then(installs); })
    .then(function (n) { land('dl', n); });
  cached('xenon.site.discord', function () {
    return json(INVITE).then(function (r) { return (r && r.approximate_member_count) || null; });
  }).then(function (n) { land('dc', n); });

  // A page that translates itself in place changes <html lang> after this ran.
  new MutationObserver(function () {
    if (known.dl) paint('dl');
    if (known.dc) paint('dc');
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
})();
