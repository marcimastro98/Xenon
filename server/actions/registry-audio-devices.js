'use strict';
// Finds the audio output an action names in the list of outputs that are connected now, for one
// device, a pair to switch between, or an ordered list. Part of the action registry: only
// registry.js requires this file.

const { repairMojibake } = require('../svv-text.js');

// Resolve an output-device id against a LIVE enumeration. Pure and exported so
// the check that makes `audioDevice` safe is unit-tested rather than trusted:
// SoundVolumeView's /SetDefault accepts render and capture ids from one
// namespace, so accepting an unmatched string would let a caller change the
// default MICROPHONE. Only entries present in the `speakers` (render) list are
// resolvable — an id that is merely well-formed, or that names a capture
// device, has no match and cannot be used.
//
// A key saved before issue #145 was fixed may hold the id as it was misread
// then ("KopfhÃ¶rer" for "Kopfhörer"). That spelling is repaired and tried
// second, against the same live list, so the key works again without being
// set up anew; the check that makes this safe is unchanged.
function resolveOutputDevice(id, speakers) {
  const wanted = String(id == null ? '' : id).trim();
  if (!wanted) return null;
  const list = Array.isArray(speakers) ? speakers : [];
  const find = (target) => list.find((s) => s && typeof s.id === 'string' && s.id === target) || null;
  const exact = find(wanted);
  if (exact) return exact;
  const repaired = repairMojibake(wanted);
  return repaired ? find(repaired) : null;
}

// The output a toggle key switches to: the second device when the first is the
// current default, the first in every other case (the second is current, or
// neither is, e.g. a third output was picked from the OS). Both must be in the
// live list, through the same check as a single device: a toggle is not a way
// around it. Null when either is missing, so an unplugged headset reads as
// "not connected" instead of the key quietly doing half of its job.
function pickToggleDevice(a, b, speakers) {
  const first = resolveOutputDevice(a, speakers);
  const second = resolveOutputDevice(b, speakers);
  if (!first || !second) return null;
  const current = (Array.isArray(speakers) ? speakers : []).find((s) => s && s.isDefault);
  return current && current.id === first.id ? second : first;
}

// The output an ordered list lands on: the first id that is in the live list,
// each through the same check as a single device (a microphone id never
// resolves). Null when none of them is connected, so the key can say so
// instead of picking something that was not on the list.
function pickFirstConnected(ids, speakers) {
  for (const id of Array.isArray(ids) ? ids : []) {
    const hit = resolveOutputDevice(id, speakers);
    if (hit) return hit;
  }
  return null;
}

module.exports = { resolveOutputDevice, pickToggleDevice, pickFirstConnected };
