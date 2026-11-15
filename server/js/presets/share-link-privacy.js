'use strict';
// The copy of a link that may leave this PC inside a shared Deck profile
// (js/preset-share.js, on export AND on import). A link to a chat names a
// person: Telegram Web keeps the chat id after the '#', wa.me carries a phone
// number, a Discord DM link carries the conversation id. Found in a community
// submission on 10 Nov 2026, where a key opened its author's own Telegram chat
// and would have gone into the public catalog. A creator cannot be counted on
// to notice, so the share path removes it on its own.
//
// What is kept is the app the key opens (Telegram Web, WhatsApp Web, Discord):
// the receiver still gets a working key, on their own account. Anything else
// that identifies someone in any link goes too: a user and password before
// the host, and query values named like a token, a key, a phone or an email.
(function () {
  // Messaging apps: the host family, and the address of its home on the web,
  // which opens the receiver's own account.
  const CHAT_APPS = [
    { hosts: ['web.telegram.org'], home: (u) => 'https://web.telegram.org/' + telegramClient(u) },
    { hosts: ['t.me', 'telegram.me', 'telegram.dog'], home: () => 'https://web.telegram.org/' },
    { hosts: ['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'chat.whatsapp.com'], home: () => 'https://web.whatsapp.com/' },
    { hosts: ['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'], home: discordHome },
    { hosts: ['m.me', 'messenger.com', 'www.messenger.com'], home: () => 'https://www.messenger.com/' },
    { hosts: ['signal.me', 'signal.group'], home: () => 'https://signal.org/' },
    { hosts: ['instagram.com', 'www.instagram.com'], home: instagramHome },
  ];
  // Query names whose value is a secret or someone's address. Matched whole,
  // case-insensitive, after '-' and '_' are dropped (api_key, api-key, apikey).
  const SECRET_PARAMS = new Set(['token', 'accesstoken', 'idtoken', 'refreshtoken', 'authtoken', 'apikey', 'key',
    'auth', 'password', 'passwd', 'pwd', 'pass', 'secret', 'clientsecret', 'sig', 'signature', 'session',
    'sessionid', 'sid', 'phone', 'tel', 'email', 'mail']);

  // Telegram Web has three clients (/a/, /k/, /z/); the chat is in the fragment.
  function telegramClient(u) {
    const m = /^\/([akz])(\/|$)/.exec(u.pathname);
    return m ? m[1] + '/' : '';
  }

  // A server's channel link is not personal by itself, but a DM link
  // (/channels/@me/<id>) is, and both name things only the sender belongs to.
  // An invite (discord.gg, /invite/) is made to be shared, so it stays.
  function discordHome(u) {
    if (/^\/invite\//.test(u.pathname)) return null;
    return /^\/channels\//.test(u.pathname) ? 'https://discord.com/channels/@me' : null;
  }

  // A profile page is public; the inbox (/direct/t/<id>) is a conversation.
  function instagramHome(u) {
    return /^\/direct\//.test(u.pathname) ? 'https://www.instagram.com/direct/inbox/' : null;
  }

  function chatApp(host) {
    return CHAT_APPS.find((app) => app.hosts.includes(host)) || null;
  }

  function parse(raw) {
    const v = String(raw == null ? '' : raw).trim();
    if (!v) return null;
    const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : 'https://' + v;
    try { return new URL(withScheme); } catch (e) { return null; }
  }

  /**
   * The link a shared key may carry: the same link with what identifies a
   * person taken out, the chat app's home for a link into a conversation, or
   * '' for a link that is nothing but an address (mailto:, tel:, an app
   * scheme). A link with nothing personal comes back exactly as it was.
   */
  function shareableLink(raw) {
    const original = String(raw == null ? '' : raw).trim();
    const u = parse(original);
    if (!u) return original;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const app = chatApp(u.hostname.toLowerCase());
    const home = app ? app.home(u) : null;
    if (home) return home;
    let changed = false;
    if (u.username || u.password) { u.username = ''; u.password = ''; changed = true; }
    for (const name of Array.from(u.searchParams.keys())) {
      if (SECRET_PARAMS.has(name.toLowerCase().replace(/[-_]/g, ''))) { u.searchParams.delete(name); changed = true; }
    }
    return changed ? u.toString() : original;
  }

  const api = { shareableLink };
  if (typeof window !== 'undefined') window.ShareLinkPrivacy = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
