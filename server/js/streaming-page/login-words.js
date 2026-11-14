// What the streaming page says when a sign-in does not go through: the sentence for each reason
// Discord or Xenon gives, the line shown while Discord asks for approval, the note under a card,
// and a row with a name and its key.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));
  const el = makeEl; // shared DOM factory from utils.js

  // A name on the left and its key on the right, like every Settings row.
  function keyRow(text, key, cls) {
    const row = el('div', 'settings-row');
    const line = el('span', 'settings-label-line');
    line.appendChild(el('span', cls, text));
    row.append(line, key);
    return row;
  }

  // Any failure without a sentence of its own still says what it was: the
  // code, and the words behind it when there are any.
  function genericLoginError(r) {
    const code = (r && r.error) || '';
    const detail = (r && typeof r.detail === 'string') ? r.detail : '';
    if (code === 'no_server') return t('streaming_no_server', 'Xenon did not answer. If you have just updated Xenon, restart it and try again.');
    return t('streaming_error', 'Could not start login. Try again.')
      + (code ? ' (' + code + ')' : '') + (detail ? ' “' + detail + '”' : '');
  }

  // Map a discord-rpc login() result to a specific, actionable note. Most RPC
  // failures come down to the desktop Discord being signed in with a DIFFERENT
  // account than the one that created the app, a wrong Client ID/Secret, or a
  // redirect-URL mismatch — so each case points the user at the likely fix
  // instead of the generic "try again". `r.detail` carries Discord's own error
  // words (capped, plain text) — appended so the real cause is never invisible.
  function rpcLoginError(r) {
    const err = (r && r.error) || '';
    const detail = (r && typeof r.detail === 'string') ? r.detail : '';
    const withDetail = (msg) => msg + (detail ? ' “' + detail + '”' : '');
    switch (err) {
      case 'discord_not_running':
        return t('streaming_discord_notrunning', 'Discord desktop app not detected. Open Discord and try again.');
      case 'discord_pipe_busy':
        return t('streaming_discord_busy', 'Discord\'s local connection is busy (another app may be using it). Wait a moment and try Connect again.');
      case 'discord_pipe_denied':
        return t('streaming_discord_pipedenied', 'Discord is running as administrator, so Xenon is not allowed to talk to it. Quit Discord completely (tray icon → Quit) and reopen it normally, then press Connect. Waiting will not help.');
      case 'login_in_progress':
        return t('streaming_discord_inflight', 'A login is already waiting for approval: look for the pop-up in Discord (or wait for it to time out) before trying again.');
      case 'invalid_client_id':
        return t('streaming_discord_badclientid', 'Discord rejected the Client ID. Copy the "Application ID" from your app\'s General Information page in the Developer Portal and re-enter it under Edit credentials.');
      case 'discord_closed':
        return withDetail(t('streaming_discord_closed', 'Discord closed the connection. Check that the Client ID is correct and that Discord desktop is signed in with the account that created this application.'));
      case 'authorize_denied':
        return t('streaming_discord_denied', 'Authorization was denied in Discord. Approve the request, and make sure you are signed in with the account that owns this application.');
      case 'invalid_scope':
        return withDetail(t('streaming_discord_invalidscope', 'Discord rejected the requested permissions. Check, in this order: the Discord desktop app is signed in with the account that OWNS this application (or one you added under the app\'s OAuth2 testers); your app has at least one redirect registered (http://localhost); and the app is not an Activity, the "Embedded App" flag blocks this kind of access.'));
      case 'authorize_failed':
        return withDetail(t('streaming_discord_authfailed', 'Discord refused the authorization. The Discord desktop app must be signed in with the same account that owns this application in the Developer Portal.'));
      case 'authorize_timeout':
        return t('streaming_discord_timeout', 'The authorization window timed out. Try again and click "Authorize" in Discord promptly.');
      case 'bad_client_secret':
        return t('streaming_discord_badsecret', 'Discord rejected the Client Secret. Open your app in the Developer Portal, reset the secret, and paste the new value under Edit credentials.');
      case 'token_exchange_failed':
        return withDetail(t('streaming_token_failed', 'Login failed while exchanging the code. Check the Client Secret and that the redirect URL is exactly http://localhost.'));
      case 'token_network_failed':
        return withDetail(t('streaming_discord_network', 'Discord authorized, but this PC could not reach discord.com to finish the login. Check VPN, firewall or proxy settings and try Connect again.'));
      case 'no_client':
        return t('streaming_discord_noclient', 'Xenon has no Discord Client ID and Client Secret yet. Enter them under Edit credentials, then press Connect.');
      case 'login_failed':
        return withDetail(t('streaming_login_failed', 'The login failed inside Xenon, not in Discord. Try once more, and if it keeps happening, tell us on the Xenon Discord with the reason shown here.'));
      default:
        return genericLoginError(r);
    }
  }

  // Interim state while the Discord consent dialog is open (RPC flow).
  function showRpcWaiting(card) {
    card.querySelectorAll('.streaming-login, .streaming-err').forEach(n => n.remove());
    const box = el('div', 'streaming-login');
    box.appendChild(el('p', 'settings-note', t('streaming_discord_authorize', 'Open Discord and click "Authorize" in the pop-up that appears.')));
    box.appendChild(el('p', 'streaming-poll', t('streaming_waiting', 'Waiting for authorisation…')));
    card.appendChild(box);
  }

  function setNote(card, msg) {
    let note = card.querySelector('.streaming-err');
    if (!note) { note = el('p', 'settings-note streaming-err'); card.appendChild(note); }
    note.textContent = msg;
  }

  window.StreamingPageLoginWords = {
    t, el, keyRow, genericLoginError, rpcLoginError, showRpcWaiting, setNote,
  };
})();
