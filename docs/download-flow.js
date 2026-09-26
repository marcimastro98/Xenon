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
// Phones, tablets and Chromebooks go through the same page. None of them can
// run these files, so the thanks page does not start a download there: it says
// the file is for a computer and offers to send the link. Never add a shortcut
// that lets a handheld skip the thanks page, it would save the .exe on a phone.
//
// It listens in the bubble phase and never stops the event, so analytics.js
// (capture phase) has already counted the click by the time this runs.
(function () {
  'use strict';

  var REL = 'https://github.com/marcimastro98/Xenon/releases/latest/download/';
  var THANKS = '/thanks.html?f=';
  // The installers only. SHA256SUMS and the release page are left alone, and
  // this list matches the one /thanks.html accepts.
  var ASSETS = [
    'Xenon-Setup-x64.exe',
    'Xenon-macOS-universal.dmg',
    'Xenon-Linux-x86_64.AppImage',
    'Xenon-Linux-x86_64.deb',
    'Xenon-Linux-x86_64.rpm'
  ];

  // A device that cannot run a desktop installer. The same test lives in the
  // <head> of /thanks.html; keep the two in step.
  function handheld() {
    try {
      var u = navigator.userAgentData;
      var p = String((u && u.platform) || navigator.platform || '') + ' ' + navigator.userAgent;
      if (u && u.mobile === true) return true;
      if (/Android|iPhone|iPad|iPod|CrOS|Chrome OS/i.test(p)) return true;
      // iPadOS reports itself as a Mac, and a Mac has no touchscreen.
      if (/Mac/i.test(p) && navigator.maxTouchPoints > 1) return true;
      // An Android tablet asking for the desktop site can drop "Android" from
      // its user agent while navigator.platform still names the ARM CPU. The
      // Linux builds are x86_64 only, so an ARM touchscreen runs none of them.
      return /Linux (arm|aarch64)/i.test(navigator.platform || '') && navigator.maxTouchPoints > 0;
    } catch (e) {
      return false;
    }
  }

  // The installer a link points at, or null. On a handheld the link may
  // already point at the thanks page (see the end of this file).
  function fileOf(a) {
    var href = a.href || '';
    var here = location.origin + THANKS;
    var file = null;
    if (href.indexOf(REL) === 0) {
      file = href.slice(REL.length);
    } else if (href.indexOf(here) === 0) {
      try { file = decodeURIComponent(href.slice(here.length)); } catch (e) { file = null; }
    }
    return ASSETS.indexOf(file) === -1 ? null : file;
  }

  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var t = e.target;
    var a = t && t.closest && t.closest('a[href]');
    if (!a) return;
    // Read at click time: the home page swaps the href to the visitor's OS.
    var file = fileOf(a);
    if (!file) return;
    e.preventDefault();
    location.href = THANKS + encodeURIComponent(file);
  });

  // On a handheld a click is not the only way to reach a file: a long press
  // offers "Download link" and "Open in new tab", and neither fires a click.
  // Pointing the link at the thanks page as the finger lands covers those as
  // well. Computers never get here, so their links keep pointing at GitHub.
  if (handheld()) {
    document.addEventListener('pointerdown', function (e) {
      var t = e.target;
      var a = t && t.closest && t.closest('a[href]');
      var file = a && fileOf(a);
      if (file) a.href = THANKS + encodeURIComponent(file);
    }, true);
  }
})();
