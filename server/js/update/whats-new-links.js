// What the What's New screen loads and can open: its text, the screen menu, the Store and the look
// trial.
'use strict';

(() => {
  const { isNativeShell } = window.UpdateVersions;

  async function loadWhatsNew() {
    try {
      const res = await fetch('/whatsnew');
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // The menu takes the screen only where a shell draws it: never on a phone.
  async function menuKey() {
    if (!isNativeShell()) return '';
    try { return (await (await fetch(SERVER + '/xenon-menu')).json()).menuKey || ''; } catch { return ''; }
  }

  async function openScreenMenu(section) {
    try {
      const res = await fetch(SERVER + '/screen-menu', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ open: true, section }),
      });
      return res.ok ? (await res.json()).where : 'closed';
    } catch { return 'closed'; }
  }

  async function screenMenuOpen() {
    try { return (await (await fetch(SERVER + '/screen-menu', { cache: 'no-store' })).json()).open === true; } catch { return false; }
  }

  // `done` runs when it closes; without it the stage was asked for by hand.
  function openStoreFor(target) {
    const store = window.CommunityGallery;
    if (!store) return;
    if (target === 'supporters') store.openSupporters();
    else store.openSparks();
  }

  const lookOffer = () => (window.LookTrial && window.LookTrial.offered() ? window.LookTrial : null);

  window.UpdateWhatsNewLinks = {
    loadWhatsNew, menuKey, openScreenMenu, screenMenuOpen, openStoreFor, lookOffer,
  };
})();
