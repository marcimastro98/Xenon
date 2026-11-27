// What the assistant does when asked about the smart home: list what is there, switch something
// or start a scene, and never a lock, an alarm or a door.

const aiPcApps = require('../ai/ai-pc-apps.js');
const { offerControl, lightControl } = require('../ai/reply-control-offer.js');

const SWITCH_ON = { turn_on: () => true, turn_off: () => false, toggle: (was) => !was };

// A light Bit switched gets its switch and brightness under the reply. HA's new state arrives
// later, so the switch shows what was asked, worked out from the state read before the call
// (none when HA was not connected yet: then a toggle's result is left to the live state).
function offerLight(clientActions, deckHa, action, entity, before, fnResult) {
  if (!entity.startsWith('light.') || !SWITCH_ON[action] || (fnResult && (fnResult.error || fnResult.ok === false))) return;
  const known = deckHa.snapshot([entity])[0] || before || null;
  const on = before ? SWITCH_ON[action](before.state === 'on') : (action === 'toggle' ? null : SWITCH_ON[action](false));
  offerControl(clientActions, lightControl(entity, known, on));
}

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'home_assistant': async ({ fnArgs, runAction, clientActions }, { deckHa }) => {
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
          const before = act && deckHa.snapshot([entity])[0];
          fnResult = act ? await runAction(act) : { error: 'bad_action' };
          if (act) offerLight(clientActions, deckHa, action, entity, before, fnResult);
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
