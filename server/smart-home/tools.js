// What the assistant does when asked about the smart home: list what is there, switch something
// or start a scene, and never a lock, an alarm or a door.

const aiPcApps = require('../ai-pc-apps.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'home_assistant': async ({ fnArgs, runAction }, { deckHa }) => {
      let fnResult;
      // Smart-home control. `list` reads the entity roster (so the model can match
      // a friendly name → entity_id); everything else goes through the registry's
      // validated HA actions (the provider re-validates entity_id/service).
      const action = String(fnArgs.action || '');
      const entity = String(fnArgs.entity_id || '').trim();
      if (action === 'list') {
        const ents = await deckHa.listEntities().catch(() => []);
        fnResult = {
          ok: true,
          entities: (Array.isArray(ents) ? ents : []).slice(0, 80).map(e => ({
            id: e.id, name: e.name, domain: e.domain, area: e.area || null, state: e.state, unit: e.unit || undefined,
          })),
        };
      } else {
        const map = {
          turn_on: { type: 'haToggle', entity, mode: 'on' },
          turn_off: { type: 'haToggle', entity, mode: 'off' },
          toggle: { type: 'haToggle', entity, mode: 'toggle' },
          scene: { type: 'haScene', entity },
          service: { type: 'haCallService', service: String(fnArgs.service || ''), entity, data: String(fnArgs.data || '') },
        };
        const act = map[action];
        // Locks, alarms, covers, scripts and the like are not Bit's to drive
        // on its own (ai-pc-apps.js): both the entity's and the service's
        // domain must be ordinary ones.
        const service = action === 'service' ? String(fnArgs.service || '') : '';
        if (act && ((entity && !aiPcApps.haDomainAllowed(entity)) || (service && !aiPcApps.haDomainAllowed(service)))) {
          fnResult = { error: 'not allowed: locks, alarms, covers, garage doors, scripts and automations are not controlled by the assistant. The user can do it in Home Assistant or with a Deck key.' };
        } else {
          fnResult = act ? await runAction(act) : { error: 'bad_action' };
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
