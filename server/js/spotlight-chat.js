'use strict';

// Bit's chat in the search window, so it is one shortcut away from any app. Bit
// on the bar or Ctrl+B turns the window into the dashboard's own panel, the same
// one the alerts window loads (js/screen-bit.js), so the rules are the chat's:
// Sparks, limits, attachments. Pasting a picture or a file in the bar opens the
// chat with it. Nothing of the chat loads until it is first used; the talk stays
// in the page while the window is hidden, and Esc goes back to the search.

(function () {
  const FRAMELESS = /[?&]frameless=1/.test(location.search);
  let open = false;
  let entering = null;
  let watching = false;

  const field = () => document.getElementById('ai-text-input');

  function signal(url) {
    try { window.location.href = (window.__xenonSignal || String)(url); } catch (e) { /* not native */ }
  }

  function announce(isOpen) {
    window.dispatchEvent(new CustomEvent('spotlight-chat', { detail: { open: isOpen } }));
  }

  function putText(text) {
    const el = field();
    if (!el) return;
    if (text) {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.focus();
  }

  function leave() {
    if (!open) return;
    open = false;
    document.body.classList.remove('spot-chat');
    announce(false);
    window.Spotlight.fresh();
  }

  // The panel's own close (its X, its Esc) is the way back to the search.
  function watchPanel() {
    if (watching) return;
    watching = true;
    new MutationObserver(() => {
      if (open && !document.body.classList.contains('ai-open')) leave();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  // Settings and the Sparks shop live in the dashboard: the native window asks
  // the shell to open it. Edge keeps the chat's own fallbacks.
  function reachDashboard() {
    if (!FRAMELESS) return;
    const open_ = (query) => signal('xenon-app:open-dashboard?' + query);
    window.openSettings = (cat) => open_('open=settings&cat=' + encodeURIComponent(String(cat || 'ai')));
    window.CommunityGallery = { openSparks: () => open_('open=sparks') };
  }

  async function start() {
    open = true;
    document.body.classList.add('spot-chat');
    announce(true);
    try {
      await window.ScreenBit.load();
      // The chat tile's role: the theme's colours in place of the voice room's dark.
      document.querySelector('.ai-panel').setAttribute('data-chatf', 'pane');
      reachDashboard();
      openAiPanel();
      watchPanel();
    } catch (e) {
      open = false;
      document.body.classList.remove('spot-chat');
      announce(false);
      window.Spotlight.say(t('spot_chat_failed', 'La chat non si è aperta, riprova'));
      throw e;
    }
  }

  async function enter(text) {
    if (!open) entering = start().finally(() => { entering = null; });
    if (entering) await entering;
    putText(text);
  }

  function onKey(e) {
    if (e.key !== 'Escape' || !open || e.defaultPrevented) return;
    if (document.querySelector('.ai-attach-menu:not([hidden])')) return;
    e.preventDefault();
    closeAiPanel();
  }

  // The chat's own paste takes pictures only, and only with its field in focus:
  // here any file counts, from the bar too. Plain text stays where it was pasted.
  async function onPaste(e) {
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      await enter('');
      aiOnFileAttach({ files, value: '' });
    } catch (err) { /* enter said so */ }
  }

  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste, true);

  window.SpotlightChat = {
    // Answers a sentence when the chat could not open, nothing when it did.
    open(text, send) {
      return enter(text)
        .then(() => { if (send && text) window.aiSendText(); })
        .catch(() => t('spot_chat_failed', 'La chat non si è aperta, riprova'));
    },
    close() { if (open) closeAiPanel(); },
    isOpen: () => open,
    focus() { putText(''); },
  };
})();
