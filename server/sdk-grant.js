'use strict';
// A widget's approval pressed on a screen. The pages of the screens save no
// settings, so without this Allow lived in that page's memory and the widget
// asked again at every load. The grant is built here from the package's own
// manifest: the page only says which widget, and the addresses the person typed.

const FLAGS = Object.freeze([
  'storage', 'secrets', 'island', 'islandDynamic', 'islandFull', 'badge', 'badgeAction',
  'mini', 'topbarButton', 'clipboard', 'ai', 'accent', 'expand',
]);
const MAX_ADDRESS = 253;

const list = (value) => (Array.isArray(value) ? value.slice() : []);

// Only the slots the package declares, whatever else the page sent. The address
// itself is checked again at every use (sdk-widgets.js resolveUserHosts).
function addressesFor(pkg, sent) {
  const out = {};
  const given = sent && typeof sent === 'object' ? sent : {};
  for (const slot of list(pkg.userHosts)) {
    const value = given[slot.id];
    if (!value || typeof value !== 'object' || typeof value.host !== 'string') continue;
    if (!value.host || value.host.length > MAX_ADDRESS) continue;
    out[slot.id] = { host: value.host, port: Number.isInteger(value.port) ? value.port : 0, scheme: value.scheme === 'https' ? 'https' : 'http' };
  }
  return out;
}

function grantFrom(pkg, userHosts) {
  const grant = {
    streams: list(pkg.streams),
    actions: list(pkg.actions),
    hosts: list(pkg.hosts),
    hooks: list(pkg.hooks),
    handlers: list(pkg.deck && pkg.deck.handlers).map((h) => h.id),
    userHosts: addressesFor(pkg, userHosts),
  };
  for (const flag of FLAGS) grant[flag] = pkg[flag] === true;
  grant.storageGroup = grant.storage && typeof pkg.storageGroup === 'string' ? pkg.storageGroup : '';
  return grant;
}

function plan(body, packages) {
  const id = body && typeof body.id === 'string' ? body.id : '';
  const pkg = list(packages).find((p) => p.id === id);
  if (!pkg) return { error: 'unknown_widget' };
  return { id, grant: grantFrom(pkg, body.userHosts), enabled: body.enabled === true };
}

function apply(cur, { id, grant, enabled }) {
  const sdk = cur.sdkWidgets && typeof cur.sdkWidgets === 'object' ? cur.sdkWidgets : {};
  const next = { ...sdk, grants: { ...(sdk.grants || {}), [id]: grant } };
  if (enabled) next.enabled = true;
  return { sdkWidgets: next };
}

module.exports = { FLAGS, grantFrom, plan, apply };
