'use strict';
// A widget's timers live on the same Timers tile as the user's, under a name the
// widget cannot choose: "<package id>: <label>". The prefix is what keeps it away
// from the user's own timers, because every timer action addresses a timer by
// name, and starting a name that exists restarts it.
//
// The host stamps `owner` on what a widget sends (js/custom-widget.js), so a widget
// never supplies it. Manifest Deck macros cannot name these actions at all: they
// run on the server, with nobody to stamp them (SDK_MACRO_ACTION_TYPES).

const OWNER_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const OWN_LABEL_MAX = 24;
const OWNED_MAX = 5;
// The stored name must hold the longest one whole: cut short, it stops matching
// the name the next action asks for, and the cap above stops counting it.
const SCOPED_LABEL_MAX = 41 + ': '.length + OWN_LABEL_MAX;

const ownerPrefix = (owner) => owner + ': ';

// The name to act on. `grows` says the action can add a timer, which is the one
// that counts against OWNED_MAX: restarting a widget's own timer adds nothing.
function scopeTimerLabel(rawAction, label, timers, { grows = false } = {}) {
  const plain = String(label == null ? '' : label).trim();
  const owner = rawAction && rawAction.owner;
  if (owner == null) return plain ? { label: plain } : { error: 'empty_label' };
  if (typeof owner !== 'string' || !OWNER_RE.test(owner)) return { error: 'bad_owner' };
  const own = plain.slice(0, OWN_LABEL_MAX).trim();
  if (!own) return { error: 'empty_label' };
  const scoped = ownerPrefix(owner) + own;
  if (!grows) return { label: scoped };
  const held = timers.labels().map((l) => l.toLowerCase()).filter((l) => l.startsWith(ownerPrefix(owner)));
  if (held.length >= OWNED_MAX && !held.includes(scoped.toLowerCase())) return { error: 'max_timers' };
  return { label: scoped };
}

module.exports = { scopeTimerLabel, OWN_LABEL_MAX, OWNED_MAX, SCOPED_LABEL_MAX };
