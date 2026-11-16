// What the transfer tile holds: the list from the server, the uploads in flight and their queue,
// the Phone settings it shows, and where its tiles are.
'use strict';

(() => {
  const held = {
    // Server truth, replaced wholesale by every `transfer` SSE frame. A whole-list
    // push rather than a delta: a surface that reconnects is then correct with no
    // replay to reason about, the shape notes and tasks already use.
    state: { enabled: true, items: [], pending: [], bytes: 0, quotaBytes: 0, maxBytes: 0 },
    seeded: false,
  };
  // Live upload progress for the rows THIS surface is sending. The server's own
  // counter is ahead of the network (kernel socket buffers), so the sender
  // trusts its own numbers and the SSE frames are for everybody else.
  const localProgress = new Map();   // localId -> { name, size, sent, status, error }
  const queue = [];
  const sendRun = {
    sending: false,
    cancelled: false,
    activeXhr: null,
  };

  function tiles() {
    return Array.from(document.querySelectorAll('[data-dashboard-widget="transfer"]'))
      .filter((n) => n.closest('.pager-page, .layer-slot'));
  }

  const isRemote = () => !!(typeof window !== 'undefined' && window.__xenonRemote);
  const onPhone = () => !!(window.PhoneView && window.PhoneView.isActive());

  function settings() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings.fileTransfer : null;
    return (hs && typeof hs === 'object') ? hs : {};
  }

  const setup = {
    // Rendered in JS into an empty div, the shape remote-access-page.js uses. It
    // reads and writes /api/transfer/settings, which is loopback-only: the folder
    // is a path on THIS PC, so it is not in the settings blob a phone receives
    // and cannot be edited from one.
    //
    // One section of the same rows as every Settings page (SettingsPage.css).
    cfg: null,
    settingsBox: null,
    pushInfo: { supported: false, secure: false },
  };

  window.TransferWidgetKnown = {
    held, localProgress, queue, sendRun, tiles, isRemote, settings, setup,
  };
})();
