// What the assistant does when asked to make a widget or to read one the user made: a new
// widget passes the same check as any widget that is installed, and nothing is granted to it
// here.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const aiPictures = require('../ai-attached-pictures.js');
const { externalizeInlineScripts } = require('../ai-widget-scripts.js');
const sdkWidgets = require('../sdk-widgets.js');
const { SDK_WIDGETS_DIR } = require('./data-places.js');
const aiMyWidgets = require('../ai-my-widgets.js');
const aiPresets = require('../ai-presets.js');
const { addConsiderations } = require('../ai-preset-critique.js');
const aiXenon = require('../ai-xenon-credits.js');
const { DATA_DIR } = require('../engine/paths.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'create_widget': async ({ fnArgs, clientActions, provider, pictures }, { aiPresetDeps, installWidgetPayload, sdkFeatureEnabled, trialVault, widgetExportable }) => {
      let fnResult;
      // AI-authored community widget: files arrive as plain text, get base64-
      // encoded into the EXACT /sdk/install payload and pass through the same
      // validateWidgetPayload boundary (installWidgetPayload is the ONE writer).
      // Never grants, never assigns — the user approves permissions on first use.
      if (!sdkFeatureEnabled()) {
        fnResult = { ok: false, error: 'sdk_disabled', hint: 'Ask the user to enable Community widgets in Settings → Widgets & sharing first.' };
      } else {
        // A file whose content is "attached:N" becomes that attached picture.
        const placed = aiPictures.resolvePictures(Array.isArray(fnArgs.files) ? fnArgs.files.slice(0, 40) : [], pictures);
        const problem = aiPictures.pictureProblem(placed);
        // An inline <script> never runs in the sandbox: it moves to a file first.
        const files = externalizeInlineScripts(problem ? [] : placed.value).files;
        const id = String(fnArgs.id || '');
        const changed = files.map(f => ({ path: String(f && f.path || ''), data: f && typeof f.data === 'string' ? f.data : Buffer.from(String(f && f.content || ''), 'utf8').toString('base64') }));
        // An id already installed is an edit, and only of the user's own work:
        // a Store or shared widget is never overwritten by the assistant.
        const current = await sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id);
        const editing = !!current || trialVault.has(id);
        let r;
        let all = changed;
        if (problem) {
          r = problem;
        } else if (editing && !widgetExportable(id)) {
          r = { ok: false, error: 'not_yours' };
        } else {
          if (current) all = aiMyWidgets.mergeEdit(current, changed, fnArgs.remove);
          // 'creator': an AI-authored widget is the user's own build, so it stays
          // exportable/shareable — unlike packages that arrive via import.
          r = await installWidgetPayload({ id, files: all }, 'creator');
        }
        if (r.ok) clientActions.push({ action: 'place_created_widget', args: { id: r.id } });
        fnResult = r.ok
          ? { ok: true, id: r.id, name: r.name, note: (editing ? 'Updated: the files you sent replaced theirs, the rest stayed. ' : 'Installed and put on the page the user is looking at, in the shape its manifest "size" names. ') + 'A widget already on a tile only refreshes that tile. If it needs permissions, the user approves them in the window that opens, never automatically. If critique lists fix items, correct them and call create_widget again with the same id (only the files you fix) before telling the user.' }
          : r.error === 'not_yours'
            ? { ok: false, error: 'not_yours', hint: 'This id is a widget from the Store or a share code, which belongs to someone else. Make a new widget with a different id.' }
            : problem || { ok: false, error: r.error };
        // The same checks a create_preset widget gets, on the whole package as installed.
        const whole = r.ok ? aiMyWidgets.readOwn({ id, files: all }) : null;
        const checked = r.ok ? aiPresets.critiqueWidget(r.id, whole && whole.ok ? whole.files : files, aiPresetDeps()) : null;
        if (checked) {
          fnResult.critique = provider === 'xenon'
            ? addConsiderations(checked.critique, await aiXenon.designAdvice(DATA_DIR, checked.code))
            : checked.critique;
        }
      }
      return fnResult;
  },

  'my_widgets': async ({ fnArgs }, { refreshSdkScan, widgetExportable }) => {
      let fnResult;
      // Read-only: the user's own widgets, and one's files to change it later.
      const id = String(fnArgs.id || '');
      if (!id) {
        fnResult = { ok: true, widgets: aiMyWidgets.listOwn((await refreshSdkScan()).packages, widgetExportable) };
      } else if (!widgetExportable(id)) {
        fnResult = { ok: false, error: 'not_yours_or_missing', hint: 'Only widgets the user made can be read. Call my_widgets with no id for the list.' };
      } else {
        const payload = await sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id);
        fnResult = payload ? aiMyWidgets.readOwn(payload) : { ok: false, error: 'not_found' };
      }
      return fnResult;
  },

  'sdk_reference': async ({ fnArgs }) => {
      let fnResult;
      // Read-only grounding for create_widget: the code-authoritative SDK
      // allowlists plus docs/WIDGET_SDK.md by section.
      fnResult = await require('../ai-knowledge.js').getSdkReference(fnArgs.section || '');
      return fnResult;
  },
};

module.exports = { branches };
