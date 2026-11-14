// What the assistant does when asked to open the Deck in a window, or to do what a Deck key
// does: same check and same list of actions as a key press, and the risky ones wait for the
// user on a card.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const aiDeckRun = require('../ai-deck-run.js');
const aiSurface = require('../ai-surface.js');
const UsageMode = require('../js/usage-mode.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const remoteActions = require('../remote-actions.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'open_virtual_deck': async ({ fnArgs }, { openDeckPopupWindow }) => {
      let fnResult;
      fnResult = await openDeckPopupWindow(String(fnArgs.instance || ''), fnArgs.topmost !== false);
      return fnResult;
  },

  'run_deck_action': async ({ fnArgs, clientActions, remote, surface }, { _deckConfirms, deckRegistry, hub, readDeckStore }) => {
      let fnResult;
      // A key press, by Bit: same validator, same registry. Risky types wait on
      // a card (ai-deck-run.js), sound and mixer steps play in the chat's page.
      const step = aiDeckRun.plan(fnArgs.action);
      const refused = step.mode && step.mode !== 'run' && aiSurface.clientActionRefusal('run_deck_action', surface, UsageMode.widgetsOnly(hub.settings && hub.settings.usageMode));
      if (refused && surface === 'screen') broadcastSSE('needs_dashboard', {});
      // Asked from a paired phone, Bit can do what the phone can (remote-actions.js).
      const phoneVerdict = remote && step.mode && step.mode !== 'client' ? remoteActions.remoteMayRun(step.action, await readDeckStore()) : null;
      if (!step.mode || refused) {
        fnResult = refused || step;
      } else if (phoneVerdict && !phoneVerdict.ok) {
        fnResult = { ok: false, error: phoneVerdict.error, hint: 'A paired device cannot run this: say it has to be done at the PC, or from a Deck key the user set up there.' };
      } else if (step.mode === 'confirm') {
        const nonce = _deckConfirms.issue(step.action);
        clientActions.push({ action: 'confirm_deck_action', args: { nonce, type: step.action.type, params: aiDeckRun.describe(step.action), description: aiDeckRun.purposeOf(fnArgs) } });
        fnResult = { status: 'pending_confirmation', message: 'It has NOT run yet: the user sees a confirmation card and it runs only if they approve. Do NOT say it is done; tell them to confirm on the card.' };
      } else if (step.mode === 'client') {
        clientActions.push({ action: 'run_deck_client', args: { action: step.action } });
        fnResult = { ok: true };
      } else {
        fnResult = await deckRegistry.run(step.action);
      }
      return fnResult;
  },

  'deck_action_catalog': async () => {
      let fnResult;
      // Read-only grounding for configure_deck: the full typed-action catalog
      // (compact), the live-state sources and the slider targets.
      // `info` is what the action does, the same sentence the Deck editor shows.
      const info = await require('../ai-creation-labels.js').englishByPrefix('deck_info_');
      const catalog = require('../js/deck-actions.js').ACTION_CATALOG
        .filter(a => !a.hidden)
        .map(a => ({ type: a.type, group: a.group, ...(info[a.type] ? { info: info[a.type] } : {}), params: a.params.map(p => p.kind === 'select' ? { name: p.name, options: p.options } : { name: p.name }) }));
      const dm = require('../js/deck-model.js');
      fnResult = { ok: true, actions: catalog, stateSources: dm.DECK_STATE_SOURCES, liveSources: dm.DECK_LIVE_SOURCES, sensorMetrics: dm.DECK_SENSOR_METRICS, vitalsMeters: dm.DECK_VITALS_METERS, sliderTargets: dm.SLIDER_TARGETS };
      return fnResult;
  },
};

module.exports = { branches };
