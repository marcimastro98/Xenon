'use strict';
// What Home Assistant is asked to do: a Deck action turned into a service call, a service
// called, the connection tried, and the dashboards listed.

const { isEntityId } = require('./home-assistant-entity.js');
const { actionToServiceCall } = require('./home-assistant-service.js');
const { normalizeDashboards } = require('./home-assistant-settings.js');

function makeCalls({ states, connect, request, seedStates }) {
  // Execute a validated Deck HA action. Returns {ok} — never throws.
  async function runAction(action) {
    const id = action && String(action.entity == null ? '' : action.entity).trim();
    // The entity's own lists vet a chosen source or mode; a key pressed before
    // anything is cached (no tile watching) seeds the states once first. Only an
    // empty cache does: an id HA does not know must not re-seed on every press.
    if (id && !states.size) { try { await connect(); await seedStates(); } catch (e) { /* the call below says why */ } }
    const call = actionToServiceCall(action, id ? states.get(id) : null);
    if (!call) return { ok: false, error: 'bad_ha_action' };
    return callService(call.domain, call.service, call.target, call.data);
  }

  async function callService(domain, service, target, data) {
    if (!/^[a-z_]+$/.test(String(domain)) || !/^[a-z0-9_]+$/.test(String(service))) return { ok: false, error: 'bad_service' };
    try {
      const extra = { domain, service, service_data: data || {} };
      if (target && target.entity_id && isEntityId(target.entity_id)) extra.target = { entity_id: target.entity_id };
      await request('call_service', extra);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'ha_call_failed' };
    }
  }

  // Verify config by opening a connection and seeding once. Returns a compact
  // status used by the Settings "Connect" button.
  async function test() {
    try {
      await connect();
      if (!states.size) await seedStates();
      return { ok: true, count: states.size };
    } catch (e) {
      return { ok: false, error: (e && e.message) || 'ha_connect_failed' };
    }
  }

  // The dashboards for Settings. A failed connection throws (the caller says
  // so); a token that may not list them gets the Overview alone.
  async function listDashboards() {
    await connect();
    const raw = await request('lovelace/dashboards/list').catch(() => []);
    return normalizeDashboards(raw);
  }

  return { runAction, callService, test, listDashboards };
}

module.exports = { makeCalls };
