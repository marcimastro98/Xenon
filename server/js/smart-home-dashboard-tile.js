/* Settings → Smart Home → "Home Assistant dashboard": put one of the user's own
 * Home Assistant dashboards on the current page, in a Browser tile with its
 * toolbar hidden. The Browser tile is a real Chromium with its own sign-in, so
 * nothing here widens the dashboard's CSP or frames Home Assistant.
 *
 * One IIFE so it loads as a classic script and also requires in node:test
 * (pageUrl is pure). */
(function () {
  const PATH_MAX = 200;

  // The address of a Home Assistant page, always on the configured HA origin:
  // a dashboard slug ("lovelace", "dashboard-wall") or a typed path such as
  // "/dashboard-wall/0". Anything that would leave that origin returns ''.
  function pageUrl(base, path) {
    let origin;
    try {
      const b = new URL(String(base || '').trim());
      if (b.protocol !== 'http:' && b.protocol !== 'https:') return '';
      origin = b.origin;
    } catch (e) { return ''; }
    let p = String(path || '').trim();
    if (!p || p.length > PATH_MAX || p.includes('\\')) return '';
    if (p.charAt(0) !== '/') {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(p)) return '';
      p = '/' + p;
    }
    if (p.charAt(1) === '/') return '';            // "//host" is another origin
    let u;
    try { u = new URL(p, origin + '/'); } catch (e) { return ''; }
    return u.origin === origin ? u.href : '';
  }

  // Adds a Browser tile on the current page showing `url`, toolbar hidden.
  // The tile reads its config when it mounts, one animation frame after the
  // layout change, so writing it straight after the add is in time; the
  // reconcile covers a tile that mounted anyway.
  function addTile(url) {
    const DG = window.DashboardGrid;
    if (!DG || typeof DG.addWidgetToPage !== 'function' || typeof hubSettings !== 'object') return false;
    const pager = window.DashboardPager;
    const page = (pager && typeof pager.getCurrentPage === 'function' && pager.getCurrentPage()) || 'dashboard';
    const id = DG.addWidgetToPage('browser', page);
    if (!id) return false;
    if (!hubSettings.browserTiles || typeof hubSettings.browserTiles !== 'object') hubSettings.browserTiles = {};
    hubSettings.browserTiles[id] = { tabs: [{ url }], active: 0, chromeHidden: true };
    if (typeof saveHubSettings === 'function') saveHubSettings({ server: true });
    if (window.BrowserTile && typeof window.BrowserTile.reconcileFromSettings === 'function') window.BrowserTile.reconcileFromSettings();
    return true;
  }

  function build(opts) {
    const { el, t, api, haUrl } = opts;
    const node = el('div', 'sh-set-dash');
    node.append(
      el('div', 'sh-set-picker-title', t('settings_ha_dash_title', 'Home Assistant dashboard')),
      el('div', 'sh-set-hint', t('settings_ha_dash_hint', 'Shows a Home Assistant dashboard in a Browser tile on the current page. Sign in inside the tile the first time. To hide the Home Assistant sidebar, turn on the option that always hides it in your Home Assistant profile.')));

    const select = el('select', 'sh-set-input');
    const loading = el('option', '', t('settings_ha_connecting', 'Connecting…'));
    select.appendChild(loading); select.disabled = true;
    const other = el('option', '', t('settings_ha_dash_other', 'Other page…')); other.value = '';

    const pathRow = el('label', 'sh-set-row');
    const path = el('input', 'sh-set-input'); path.type = 'text'; path.placeholder = '/dashboard-wall/0'; path.spellcheck = false;
    pathRow.append(el('span', 'sh-set-label', t('settings_ha_dash_path', 'Page address')), path);
    pathRow.hidden = true;

    const actions = el('div', 'sh-set-actions');
    const add = el('button', 'ui-btn ui-btn--secondary'); add.type = 'button'; add.textContent = t('settings_ha_dash_add', 'Add as a tile');
    const status = el('span', 'sh-set-status');
    status.setAttribute('role', 'status');
    actions.append(add, status);
    node.append(select, pathRow, actions);

    const say = (cls, text) => { status.className = 'sh-set-status' + (cls ? ' ' + cls : ''); status.textContent = text; };
    select.addEventListener('change', () => { pathRow.hidden = select.value !== ''; if (!pathRow.hidden) path.focus(); });

    add.addEventListener('click', () => {
      const url = pageUrl(haUrl, select.value || path.value);
      if (!url) { say('err', t('settings_ha_dash_bad_path', 'Type a page of your Home Assistant, starting with /.')); return; }
      if (addTile(url)) say('ok', t('settings_ha_dash_added', 'Added to the current page.'));
      else say('err', t('settings_ha_dash_failed', 'The tile could not be added.'));
    });

    // apiJson, not the global `api`: that is the Deck store's object.
    apiJson('/api/homeassistant/dashboards').then((r) => {
      const list = r && r.ok && Array.isArray(r.dashboards) ? r.dashboards : [{ path: 'lovelace', title: '' }];
      select.replaceChildren();
      list.forEach((d) => {
        const o = el('option', '', d.path === 'lovelace' ? t('settings_ha_dash_overview', 'Overview') : d.title);
        o.value = d.path; select.appendChild(o);
      });
      select.appendChild(other);
      select.disabled = false;
      if (!(r && r.ok)) say('', t('settings_ha_dash_list_failed', 'Your dashboards could not be listed. The Overview and other pages still work.'));
    });
    return node;
  }

  const exported = { pageUrl, build };
  if (typeof window !== 'undefined') window.SmartHomeDashboardTile = exported;
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
})();
