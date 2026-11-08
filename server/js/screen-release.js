'use strict';
// After an update with no dashboard ("widgets only"): the alerts window says what
// happened, as a card in the corner that nothing else closes. A major opens full
// screen only when asked, on the window's whole surface (js/screen-alerts.js
// takes `.wn-stage` as a card, so the window takes every click while it is up).
//
// A viewer like the rest of this page: what has been read goes to the server
// (POST /update/notice-seen), which broadcasts the settings back.
(function () {
  const MENU_SIGNAL_PATH = '/screen-menu';

  function create({ server, ready, tr, seen, openUpdate, openDashboard }) {
    let up = null;   // the card or stage on screen, as its remover
    let staged = false;   // that is the full-screen stage
    const marked = {};   // read here, before the settings come back from the server

    const text = (v) => window.XenonReleaseNotice.localText(v, document.documentElement.lang);
    const post = (path, body) => fetch(server + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const openUrl = (url) => post('/actions/run', { type: 'openUrl', url }).catch(() => { /* the server is restarting */ });

    async function read(path) {
      try {
        const res = await fetch(server + path, { cache: 'no-store' });
        return res.ok ? await res.json() : null;
      } catch (e) { return null; }
    }

    async function done(mark) {
      up = null;
      Object.assign(marked, mark.whatsNew ? { whatsNew: mark.whatsNew } : {}, mark.notes ? { notes: mark.notes } : {},
        mark.failedAt ? { updateFail: mark.failedAt } : {});
      try { await post('/update/notice-seen', mark); } catch (e) { /* it comes back at the next load */ }
      await window.ScreenRelease.check();
    }

    async function openMenu(section) {
      try {
        const res = await post(MENU_SIGNAL_PATH, { open: true, section });
        const body = res.ok ? await res.json() : null;
        return body && body.where;
      } catch (e) { return 'closed'; }
    }

    async function menuIsOpen() {
      const state = await read(MENU_SIGNAL_PATH);
      return !!(state && state.open);
    }

    async function openStage(wn) {
      staged = true;
      const menu = await read('/xenon-menu');
      up = window.XenonWhatsNewStage.open(wn, {
        text, tr, openUrl, openMenu, menuIsOpen, canOpenMenu: true, menuKey: (menu && menu.menuKey) || '',
        openStore: openDashboard,
        onClose: () => { staged = false; return done({ whatsNew: wn.id }); },
      });
    }

    // Bit was asked for it: the stage at once, read before or not. A card in the
    // corner gives way, and check() brings it back when the stage closes.
    async function reopen() {
      if (staged) return;
      const wn = await read('/whatsnew');
      if (staged || !wn || !Array.isArray(wn.highlights) || !wn.highlights.length) return;
      if (up) up();
      await openStage(wn);
    }

    function showMajor(wn) {
      const count = wn.highlights.filter((h) => h.go !== 'look').length; // this window has no dashboard to try it on
      up = window.XenonReleaseNotes.cornerMajor({
        name: `Xenon ${Number.parseInt(wn.id, 10) || wn.id}`, tr,
        line: tr('wn_card_line').replace('{n}', String(count)),
        onOpen: () => openStage(wn),
      });
    }

    function showNotes(wn, notes) {
      up = window.XenonReleaseNotes.cornerNotes({
        notes, text, tr, url: wn.url, openUrl, onClose: () => done({ notes: notes.version }),
      });
    }

    function showFailed(lastResult) {
      up = window.XenonReleaseNotes.cornerFailed({
        lastResult, detail: String(lastResult.detail || '').trim().slice(0, 200), tr,
        onRetry: openUpdate, onClose: () => done({ failedAt: lastResult.at }),
      });
    }

    // Called at boot, when the stream comes back, when an automatic update ended
    // and when a game closed. One thing at a time: closing it asks again.
    async function check() {
      if (up || !ready()) return;
      const [wn, status] = await Promise.all([read('/whatsnew'), read('/update/self-status')]);
      if (up || !ready()) return;
      const was = { ...seen(), ...marked };
      const lastResult = status && status.lastResult;
      if (window.XenonReleaseNotice.failurePending(lastResult, was.updateFail)) { showFailed(lastResult); return; }
      if (!wn) return;
      const { major, notes } = window.XenonReleaseNotice.pick({ wn, whatsNewSeen: was.whatsNew, notesSeen: was.notes });
      if (major) showMajor(wn);
      else if (notes) showNotes(wn, notes);
    }

    return { check, reopen };
  }

  window.ScreenRelease = {
    start(deps) {
      const made = create(deps);
      window.ScreenRelease.check = made.check;
      window.XenonWhatsNew = { reopen: made.reopen };   // the name ai.js calls on every surface
      return made.check();
    },
    check: async () => {},
  };
})();
