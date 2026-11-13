// What the assistant does when asked to change a setting, or the model and the effort it
// creates with.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const aiXenon = require('../ai-xenon-credits.js');
const { nextSettingsRev } = require('../settings-rev.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const aiCreationLabels = require('../ai-creation-labels.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'change_setting': async ({ fnArgs }, { changeSetting }) => {
      let fnResult;
      fnResult = await changeSetting(fnArgs);
      return fnResult;
  },

  'set_creation_model': async ({ fnArgs, provider, uiLang }, { hub, readHubSettingsForUpdate, withHubSettingsLock, writeHubSettings }) => {
      let fnResult;
      // The credits turn reads these again at its hand-over (creation: in the
      // xenon branch below), so a change made earlier in the same turn applies.
      const model = fnArgs.model == null || fnArgs.model === '' ? null : String(fnArgs.model).toLowerCase();
      const effort = fnArgs.effort == null || fnArgs.effort === '' ? null : String(fnArgs.effort).toLowerCase();
      if (provider !== 'xenon') {
        fnResult = { ok: false, error: 'not_on_credits', hint: 'The creation model and reasoning level belong to Sparks, Bit credits. Tell the user they apply when Sparks is the provider in Settings → Bit.' };
      } else if ((!model && !effort) || (model && !aiXenon.MODELS.includes(model)) || (effort && !aiXenon.EFFORTS.includes(effort))) {
        fnResult = { ok: false, error: 'bad_args', hint: 'model: haiku, sonnet or opus; effort: low, medium or high.' };
      } else {
        const saved = await withHubSettingsLock(async () => {
          const cur = await readHubSettingsForUpdate();
          const next = { ...cur, ...(model ? { xenonModel: model } : {}), ...(effort ? { xenonEffort: effort } : {}), rev: nextSettingsRev(cur.rev) };
          hub.settings = await writeHubSettings(next);
          return hub.settings;
        });
        broadcastSSE('settings', { rev: saved.rev });
        fnResult = {
          ok: true, model: saved.xenonModel, effort: saved.xenonEffort,
          names: await aiCreationLabels.namesFor(uiLang),
          hint: 'Call the model and the level by these names, the ones Settings shows the user, never by the English ids.',
        };
      }
      return fnResult;
  },
};

module.exports = { branches };
