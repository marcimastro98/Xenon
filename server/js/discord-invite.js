'use strict';

// ── Community Discord: single source for the invite URL + the startup invite card.
// The invite is MOCKED until the real server exists (same placeholder the website
// uses); when it's ready, change INVITE here and the REPLACE_ME in docs/index.html.
// Every in-app Discord link carries `data-discord` and gets its href wired here, so
// there is exactly one URL to update.
(function () {
  const INVITE = 'https://discord.gg/REPLACE_ME';
  window.XENON_DISCORD_INVITE = INVITE;

  // Permanent "don't show again" flag for the startup card. A plain close (×) is
  // session-only — the card returns next launch — so users who ignore it still get
  // a gentle reminder, while "Don't show again" silences it for good.
  const DISMISS_KEY = 'xenonedge.discordInvite.v1';
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function dismissed() {
    try { return localStorage.getItem(DISMISS_KEY) === 'dismissed'; } catch { return false; }
  }
  function setDismissed() {
    try { localStorage.setItem(DISMISS_KEY, 'dismissed'); } catch { /* ignore */ }
  }

  // Official Discord mark; inherits `currentColor` so CSS controls the tint.
  const LOGO = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.317 4.369A19.79 19.79 0 0 0 16.885 3.1a.074.074 0 0 0-.079.037c-.34.607-.719 1.4-.984 2.02a18.27 18.27 0 0 0-5.487 0 12.6 12.6 0 0 0-.997-2.02.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.891.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.056c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.028zM8.02 15.331c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>';
  const CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  // Point every [data-discord] link (e.g. the Settings support link) at the invite.
  function wireLinks() {
    document.querySelectorAll('a[data-discord]').forEach(a => { a.href = INVITE; });
  }

  function openInvite() { try { window.open(INVITE, '_blank', 'noopener'); } catch { /* ignore */ } }

  function showCard() {
    if (document.getElementById('discord-invite')) return;
    const card = document.createElement('div');
    card.className = 'discord-invite';
    card.id = 'discord-invite';
    card.setAttribute('role', 'complementary');
    card.setAttribute('aria-label', t('discord_invite_title', 'Join the Xenon community'));

    const head = document.createElement('div');
    head.className = 'discord-invite-head';
    const logo = document.createElement('div');
    logo.className = 'discord-invite-logo';
    logo.innerHTML = LOGO;                 // static, trusted markup
    const title = document.createElement('div');
    title.className = 'discord-invite-title';
    title.textContent = t('discord_invite_title', 'Join the Xenon community');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'discord-invite-close';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.innerHTML = CLOSE;               // static, trusted markup
    close.addEventListener('click', () => hideCard());   // session-only: returns next launch
    head.append(logo, title, close);

    const text = document.createElement('p');
    text.className = 'discord-invite-text';
    text.textContent = t('discord_invite_text', 'Share your themes, swap ideas, and get help — come hang out with other Xenon users on our Discord.');

    const actions = document.createElement('div');
    actions.className = 'discord-invite-actions';
    const join = document.createElement('button');
    join.type = 'button';
    join.className = 'discord-invite-join';
    join.innerHTML = LOGO;                 // static, trusted markup
    const joinLabel = document.createElement('span');
    joinLabel.textContent = t('discord_invite_join', 'Join Discord');
    join.appendChild(joinLabel);
    join.addEventListener('click', () => { openInvite(); setDismissed(); hideCard(); });
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'discord-invite-dismiss';
    dismiss.textContent = t('discord_invite_dismiss', "Don't show again");
    dismiss.addEventListener('click', () => { setDismissed(); hideCard(); });
    actions.append(join, dismiss);

    card.append(head, text, actions);
    document.body.appendChild(card);
    // next frame → transition in
    requestAnimationFrame(() => card.classList.add('is-in'));
  }

  function hideCard() {
    const card = document.getElementById('discord-invite');
    if (!card) return;
    card.classList.remove('is-in');
    setTimeout(() => { card.remove(); }, 320);
  }

  function maybeShowStartup() {
    if (dismissed()) return;
    // A short delay so it doesn't fight the initial dashboard paint / greeting.
    setTimeout(showCard, 1400);
  }

  function init() {
    wireLinks();
    maybeShowStartup();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
