// A control Bit leaves in its reply after it changed something the person may want to set again
// by hand: the PC's volume, the microphone, the music or a light. The chat draws it
// (js/ai/reply-controls.js) and moves it through the dashboard's own endpoints, so it adds no
// new way to act on the PC; this only says which control, at most a few per reply, each once.
'use strict';

const { isEntityId } = require('../actions/home-assistant-entity.js');

const KINDS = new Set(['volume', 'mic', 'media', 'light']);
const MAX_PER_REPLY = 4;
const NAME_MAX = 80;

// "light.living_room" -> "living room", for a light HA has not described yet.
const nameFromId = (id) => id.slice(id.indexOf('.') + 1).replace(/_/g, ' ');

/**
 * @param {any} entity HA's compact entity (home-assistant-entity.js compactEntity), or null.
 * @param {boolean|null} on what the light was asked to be; null when that is not known yet.
 */
function lightControl(entityId, entity, on) {
  const modes = entity && Array.isArray(entity.colorModes) ? entity.colorModes : [];
  const brightness = entity && Number.isFinite(entity.brightness) ? entity.brightness : null;
  return {
    kind: 'light',
    entity: entityId,
    name: String(entity?.name || nameFromId(entityId)).slice(0, NAME_MAX),
    dimmable: modes.some((m) => m !== 'onoff'),
    on: on === null ? null : !!on,
    pct: brightness === null ? null : Math.max(1, Math.round(brightness / 255 * 100)),
  };
}

/** @param {any[]} clientActions the turn's list, added to in place. */
function offerControl(clientActions, control) {
  if (!Array.isArray(clientActions) || !control || !KINDS.has(control.kind)) return;
  if (control.kind === 'light' && !(isEntityId(control.entity) && String(control.entity).startsWith('light.'))) return;
  const offered = clientActions.filter((a) => a && a.action === 'reply_control');
  if (offered.length >= MAX_PER_REPLY) return;
  if (offered.some((a) => a.args.kind === control.kind && a.args.entity === control.entity)) return;
  clientActions.push({ action: 'reply_control', args: control });
}

module.exports = { offerControl, lightControl, MAX_PER_REPLY };
