// Sends a download button through the thanks page (/thanks.html) instead of
// straight to the file, the way blender.org shows its donation page while the
// download starts.
//
// Progressive by design: every download link on the site still points straight
// at the GitHub release, so without this script, with it blocked, or on a
// middle click or Ctrl/Cmd click the visitor gets the file exactly as before.
// Only a plain left click is turned into a visit to the thanks page, which
// starts the same download itself.
//
// It listens in the bubble phase and never stops the event, so analytics.js
// (capture phase) has already counted the click by the time this runs.
(function () {
  'use strict';

  var REL = 'https://github.com/marcimastro98/Xenon/releases/latest/download/';
  // The installers only. SHA256SUMS and the release page are left alone, and
  // this list matches the one /thanks.html accepts.
  var ASSETS = [
    'Xenon-Setup-x64.exe',
    'Xenon-macOS-universal.dmg',
    'Xenon-Linux-x86_64.AppImage',
    'Xenon-Linux-x86_64.deb',
    'Xenon-Linux-x86_64.rpm'
  ];

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    var a = t && t.closest && t.closest('a[href]');
    if (!a) return;
    // Read at click time: the home page swaps the href to the visitor's OS.
    var href = a.href || '';
    if (href.indexOf(REL) !== 0) return;
    var file = href.slice(REL.length);
    if (ASSETS.indexOf(file) === -1) return;
    e.preventDefault();
    location.href = '/thanks.html?f=' + encodeURIComponent(file);
  });
})();
