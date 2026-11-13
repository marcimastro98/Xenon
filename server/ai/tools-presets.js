// What the assistant does when asked to make a look, a layout or another share code: it reads
// what a code may hold, builds one and tries it against the import, and never applies it (the
// user sees the usual review).

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const aiPresets = require('../ai-presets.js');
const { addConsiderations } = require('../ai-preset-critique.js');
const aiXenon = require('../ai-xenon-credits.js');
const { DATA_DIR } = require('../engine/paths.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'preset_reference': async ({ fnArgs }, { aiPresetDeps }) => {
      let fnResult;
      // Read-only grounding for create_preset, built from the import's own code.
      fnResult = aiPresets.runPresetReference(fnArgs, aiPresetDeps());
      return fnResult;
  },

  'create_preset': async ({ fnArgs, clientActions, provider, pictures }, { aiPresetDeps }) => {
      let fnResult;
      // Builds a share code and dry-runs it through the import's normalizers.
      // It never applies anything: on success the client opens the normal
      // import review window with the code, exactly as marketplace_install does.
      const out = aiPresets.runCreatePreset(fnArgs, aiPresetDeps(), pictures);
      clientActions.push(...out.clientActions);
      fnResult = out.fnResult;
      // On Xenon credits the hub's design check (what reads as generated) joins
      // the critique, so the assistant can fix it before the user looks.
      if (provider === 'xenon' && out.code) {
        fnResult.critique = addConsiderations(fnResult.critique, await aiXenon.designAdvice(DATA_DIR, out.code));
      }
      return fnResult;
  },
};

module.exports = { branches };
