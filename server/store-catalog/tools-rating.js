// What the assistant does when asked to vote something of the Store: the vote only counts after
// the user approves it on a card.

const aiSurface = require('../ai-surface.js');
const UsageMode = require('../js/usage-mode.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const aiRateStore = require('../ai-rate-store.js');
const aiDeckRun = require('../ai-deck-run.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'rate_store_item': async ({ fnArgs, clientActions, surface }, { _deckConfirms, hub, ratingVotes }) => {
      let fnResult;
      const refused = aiSurface.clientActionRefusal('run_deck_action', surface, UsageMode.widgetsOnly(hub.settings && hub.settings.usageMode));
      if (refused && surface === 'screen') broadcastSSE('needs_dashboard', {});
      const step = refused ? null : await aiRateStore.plan(fnArgs, { settings: () => hub.settings, stateOf: ratingVotes.stateOf });
      if (!step || !step.ok) {
        fnResult = refused || step;
      } else {
        const nonce = _deckConfirms.issue(step.action);
        clientActions.push({ action: 'confirm_deck_action', args: { nonce, type: step.action.type, params: aiRateStore.cardParams(step.action), description: aiDeckRun.purposeOf(fnArgs) } });
        fnResult = { status: 'pending_confirmation', message: 'The vote is NOT in yet: the user sees a confirmation card and it counts only if they approve. Tell them to confirm on the card.' };
      }
      return fnResult;
  },
};

module.exports = { branches };
