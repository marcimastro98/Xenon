'use strict';
// One notification as the child reader printed it, turned into the shape the dashboards get:
// known keys only, lengths capped, and an id the server gives.

const { notifWatch } = require('./winnotif-state.js');

const TEXT_MAX = 200;
const BODY_MAX = 400;
const ICON_MAX = 128 * 1024;     // data: URI cap (helper caps the raw logo lower)

// Server-side re-projection at the trust boundary: known keys only, length
// caps, server-assigned monotonic id (child ids reset per session, so they
// are unusable as feed keys). Anything malformed collapses to a safe shape.
function _project(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const icon = typeof r.icon === 'string' && r.icon.startsWith('data:image/') && r.icon.length <= ICON_MAX
    ? r.icon : null;
  return {
    id: ++notifWatch.seq,
    // The CHILD's own id, kept alongside ours. Ours is the feed key (child ids
    // reset every session, so they are unusable for that); this one is what the
    // `present` event speaks, and it is the only way to tell that a particular
    // toast has been removed from Action Center. Absent when the child is an
    // older helper that does not report ids.
    srcId: Number.isFinite(r.id) ? Math.floor(r.id) : null,
    app: String(r.app || '').slice(0, TEXT_MAX),
    aumid: String(r.aumid || '').slice(0, TEXT_MAX),
    // Linux only: the .desktop id the notification named (linux-notif.js).
    desktopEntry: typeof r.desktopEntry === 'string' && /^[A-Za-z0-9][\w.-]{0,119}$/.test(r.desktopEntry) ? r.desktopEntry : '',
    title: String(r.title || '').slice(0, TEXT_MAX),
    body: String(r.body || '').slice(0, BODY_MAX),
    at: Number.isFinite(r.at) && r.at > 0 ? Math.floor(r.at) : Date.now(),
    icon,
  };
}

module.exports = { TEXT_MAX, BODY_MAX, ICON_MAX, _project };
