// The rows the remote access page is built from: a section, a switch, a key, an address, the steps
// to set it up and the list of what a paired device cannot do.

(() => {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The pieces every Settings page is built from (SettingsPage.css).
  function section(title) {
    const box = el('section', 'settings-section');
    if (title) box.appendChild(typeof title === 'string' ? el('div', 'settings-section-title', title) : title);
    return box;
  }

  function switchRow(label, hint, checked, onChange) {
    const row = el('label', 'settings-toggle-row');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'settings-check';
    input.checked = checked;
    input.addEventListener('change', () => onChange(input));
    const words = el('span', 'settings-label-line');
    words.appendChild(el('span', null, label));
    if (hint) words.appendChild(el('span', 'settings-hint', hint));
    row.append(input, words);
    return row;
  }

  function keyRow(...keys) {
    const row = el('div', 'settings-row settings-row-keys');
    row.append(...keys);
    return row;
  }

  // A name and the address under it, with a key on the right when there is one.
  function addressRow(label, address, key) {
    const row = el('div', 'settings-row ra-address');
    const words = el('span', 'settings-label-line');
    words.append(el('span', null, label), el('code', 'settings-hint', address));
    row.appendChild(words);
    if (key) row.appendChild(key);
    return row;
  }

  // Tailscale's admin console. A fixed, first-party URL — the one step of the
  // setup that happens somewhere other than this machine, and the one nobody
  // would think to look for.
  const TAILNET_ADMIN = 'https://login.tailscale.com/admin/dns';

  // The whole procedure, shown under the reason. Knowing WHICH step is missing
  // does not tell anyone what the steps are, and not one of these is guessable:
  // that it needs an account at all, that the certificate switch lives in a web
  // console rather than in the Tailscale app, that the PHONE needs the same app
  // signed into the same account, and that its VPN toggle has to be on.
  function howToSetUp() {
    const box = el('div', 'ra-how');
    box.appendChild(el('h4', 'ra-limits-title', t('ra_https_how_title')));
    const list = el('ol', 'ra-how-list');
    for (const key of ['ra_https_how_1', 'ra_https_how_2', 'ra_https_how_3', 'ra_https_how_4']) {
      const li = el('li', null, t(key));
      if (key === 'ra_https_how_2') {
        // The console is a page on the web, so it opens in the real browser.
        // `noopener` because this is a link out of a dashboard that holds a
        // local API — the opened tab must never get a handle back to us.
        li.appendChild(document.createTextNode(' '));
        const a = el('a', 'ra-how-link', 'login.tailscale.com');
        a.href = TAILNET_ADMIN;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        li.appendChild(a);
      }
      list.appendChild(li);
    }
    box.appendChild(list);
    return box;
  }

  // What a paired device can and cannot do. Stated in the UI, not only in the
  // code: a user who expects something from the phone should learn it here rather
  // than by tapping it and getting nothing.
  function appendLimits(page, st) {
    const box = section();
    const more = el('details', 'settings-expander');
    const name = el('summary');
    name.appendChild(el('span', 'settings-label-line', t('ra_limits_title')));
    const list = el('ul', 'settings-expander-list');
    for (const key of ['ra_can_1', 'ra_can_2', 'ra_can_3', 'ra_cant_1', 'ra_cant_2', 'ra_cant_3']) {
      list.appendChild(el('li', null, t(key)));
    }
    // The cleartext caveat is true of the LAN door and stops being true the
    // moment the secure one is up. Leaving it on screen either way would be the
    // panel contradicting itself.
    if (!(st.https && st.https.running)) list.appendChild(el('li', null, t('ra_http_note')));
    more.append(name, list);
    box.appendChild(more);
    page.appendChild(box);
  }

  window.RemoteAccessPageRows = {
    el, section, switchRow, keyRow, addressRow, TAILNET_ADMIN, howToSetUp, appendLimits,
  };
})();
