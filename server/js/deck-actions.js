'use strict';
// Typed-action catalog (metadata only) + validator for the Deck widget. Shared
// by the editor (browser, window.DeckActions) and — in a later phase — the
// server action registry (require). No DOM, no execution here.
//
// param.kind: 'text' | 'path' | 'url' | 'select' (select carries `options`).

const ACTION_CATALOG = [
  { type: 'openApp',  group: 'system', labelKey: 'deck_act_openApp',  params: [{ name: 'path', kind: 'path' }] },
  { type: 'openFile', group: 'system', labelKey: 'deck_act_openFile', params: [{ name: 'path', kind: 'path' }] },
  { type: 'openUrl',  group: 'system', labelKey: 'deck_act_openUrl',  params: [{ name: 'url',  kind: 'url'  }] },
  { type: 'media',    group: 'media',  labelKey: 'deck_act_media',    params: [{ name: 'cmd',  kind: 'select', options: ['playpause', 'next', 'previous'] }] },
  { type: 'micMute',  group: 'audio',  labelKey: 'deck_act_micMute',  params: [{ name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
  { type: 'volume',   group: 'audio',  labelKey: 'deck_act_volume',   params: [{ name: 'mode', kind: 'select', options: ['mute', 'up', 'down'] }] },
  { type: 'obsScene',  group: 'obs', labelKey: 'deck_act_obsScene',  params: [{ name: 'scene',  kind: 'obsScene' }] },
  { type: 'obsSceneNext', group: 'obs', labelKey: 'deck_act_obsSceneNext', params: [] },
  { type: 'obsRecord', group: 'obs', labelKey: 'deck_act_obsRecord', params: [{ name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop'] }] },
  { type: 'obsStream', group: 'obs', labelKey: 'deck_act_obsStream', params: [{ name: 'mode', kind: 'select', options: ['toggle', 'start', 'stop'] }] },
  { type: 'obsMute',   group: 'obs', labelKey: 'deck_act_obsMute',   params: [{ name: 'source', kind: 'obsSource' }, { name: 'mode', kind: 'select', options: ['toggle', 'mute', 'unmute'] }] },
  { type: 'remoteDisconnect',  group: 'remote', labelKey: 'deck_act_remoteDisconnect',  params: [] },
  { type: 'remoteBlock',       group: 'remote', labelKey: 'deck_act_remoteBlock',       params: [{ name: 'mode', kind: 'select', options: ['toggle', 'block', 'unblock'] }] },
  { type: 'remoteScreenCycle', group: 'remote', labelKey: 'deck_act_remoteScreenCycle', params: [] },
  { type: 'ai', group: 'ai', labelKey: 'deck_act_ai', params: [{ name: 'mode', kind: 'select', options: ['prompt', 'voice', 'open'] }, { name: 'prompt', kind: 'text' }] },
  { type: 'lighting', group: 'lighting', hidden: true, labelKey: 'deck_act_lighting', params: [{ name: 'mode', kind: 'select', options: ['set', 'restore'] }, { name: 'color', kind: 'text' }, { name: 'style', kind: 'select', options: ['solid', 'breathing', 'cycle'] }] },
];

function actionSpec(type) {
  return ACTION_CATALOG.find(a => a.type === type) || null;
}

// Return a clean action with ONLY the params its spec allows, or null if the
// type is unknown. select → coerced to a valid option; text/url/path → string,
// capped. This is the single source of truth the server registry will reuse.
function validateAction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const spec = actionSpec(raw.type);
  if (!spec) return null;
  const out = { type: spec.type };
  for (const p of spec.params) {
    let v = raw[p.name];
    if (p.kind === 'select') {
      v = (typeof v === 'string' && p.options.includes(v)) ? v : p.options[0];
    } else {
      v = String(v == null ? '' : v).slice(0, 1024);
    }
    out[p.name] = v;
  }
  return out;
}

function clampDelay(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(10000, n));
}

// Canonicalise a trigger (a single Action, or a Multi-Action {steps:[...]}) into
// an ordered list of validated [{action, delayMs}]. Invalid steps are dropped.
function triggerSteps(trigger) {
  if (!trigger || typeof trigger !== 'object') return [];
  if (Array.isArray(trigger.steps)) {
    const out = [];
    for (const s of trigger.steps) {
      const action = validateAction(s && s.action);
      if (action) out.push({ action, delayMs: clampDelay(s && s.delayMs) });
    }
    return out;
  }
  const action = validateAction(trigger);
  return action ? [{ action, delayMs: 0 }] : [];
}

// Inverse of triggerSteps: turn a list of {action, delayMs} into the smallest
// valid trigger value — null if empty, a bare Action for one zero-delay step,
// else { steps:[...] }. Invalid steps are dropped (validated).
function compactTrigger(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const out = [];
  for (const s of list) {
    const action = validateAction(s && s.action);
    if (action) out.push({ action, delayMs: clampDelay(s && s.delayMs) });
  }
  if (!out.length) return null;
  if (out.length === 1 && !out[0].delayMs) return out[0].action;
  return { steps: out };
}

if (typeof window !== 'undefined') {
  window.DeckActions = { ACTION_CATALOG, actionSpec, validateAction, triggerSteps, clampDelay, compactTrigger };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ACTION_CATALOG, actionSpec, validateAction, triggerSteps, clampDelay, compactTrigger };
}
