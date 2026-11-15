'use strict';
// A notification from the PC opens its app: the row in the Notifications widget
// and the pop-up's "Open" button ask the server (capability notificationOpen,
// server/notification-open/) to bring the app's window forward or start it.
// Only the feed's own id travels; the server finds the app itself.
//
// Not on a paired phone: the app would open on the PC, out of the user's reach,
// and the phone may run only keys set up on the PC anyway.
(function () {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : fb);
  let busy = false;

  // Something to find the app by, on the PC itself.
  function canOpen(item) {
    if (window.__xenonRemote || !item || !Number.isInteger(item.id)) return false;
    return !!(item.aumid || item.desktopEntry || item.app);
  }

  // The reason in the user's words (deck-error-text.js), never the code.
  function say(code) {
    if (!window.XenonToast) return;
    const why = window.DeckErrorText ? window.DeckErrorText.describe(code, t) : '';
    window.XenonToast.show({ type: 'error', title: t('wn_open_failed', 'Could not open the app'), message: why, duration: 3600 });
  }

  async function open(item) {
    if (busy || !canOpen(item)) return;
    busy = true;
    try {
      const res = await apiJson('/actions/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'notificationOpen', id: String(item.id) }),
      });
      // apiJson answers null instead of throwing.
      if (!res || res.ok !== true) say((res && res.error) || 'launch_failed');
    } finally {
      busy = false;
    }
  }

  // The row's text becomes a button: tap, Enter or Space opens the app. The
  // row's other buttons (mute) stay outside it.
  function bind(node, item) {
    if (!node || !canOpen(item)) return;
    node.classList.add('is-openable');
    node.setAttribute('role', 'button');
    node.tabIndex = 0;
    node.setAttribute('aria-label', t('wn_open_app', 'Open {app}').replace('{app}', item.app || t('wn_title', 'Notifications')));
    node.addEventListener('click', () => open(item));
    node.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      open(item);
    });
  }

  // The "Open" button of a new notification's pop-up.
  function toastAction(item) {
    return canOpen(item) ? { label: t('wn_open', 'Open'), primary: true, onClick: () => open(item) } : null;
  }

  window.NotificationOpen = { canOpen, open, bind, toastAction };
})();
