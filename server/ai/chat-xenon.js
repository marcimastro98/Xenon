// One chat turn paid with Xenon credits: each round goes through the supporter hub, which
// charges it.

// The lines of the function stood in handleRequest of server/server.js, under `if (provider ===
// 'xenon')`, and are written here as they were, indentation included. The function is handed
// what they read of that function and of the file.
/** @param {any} context what these lines read of the function they stood in, and of its file */
async function chatWithXenon(context) {
  const {
    AI_TOOLS, SYS_BASE, SYS_LANG, SYS_NOW, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
    _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote, isVoice,
    json, langName, provider, res, toolKit, turnRecord, DATA_DIR, aiStoppedReply, aiXenon, executeAiTool, hub,
    readHubSettings,
  } = context;
        // Xenon credits (ai-xenon-credits.js): the Claude loop, each round through
        // the supporter hub, which charges it. The remembered pass stays on disk.
        // The time rides on the turn instead of the system text, so the system
        // prefix is the same from one turn to the next and the hub's cache holds.
        const settings = await readHubSettings().catch(() => null);
        const SYS_XLATE = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE.slice(SYS_NOW.length) + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_XLATE;
        try {
          const result = await aiXenon.chat({
            dataDir: DATA_DIR, model: settings && settings.xenonModel, effort: settings && settings.xenonEffort, geminiTools: AI_TOOLS,
            // Read live: set_creation_model may change them during this turn.
            creation: () => ({ model: hub.settings.xenonModel, effort: hub.settings.xenonEffort }),
            history: currentMessages, systemText, turnNote: SYS_NOW,
            executeTool: (fnName, fnArgs) => toolKit.call(fnName, fnArgs, () => executeAiTool(fnName, fnArgs, {
              apiKey, uiLang: _uiLang2, latestUserText: _latestUserText,
              latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
              latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
              pictures: _aiPictures,
              surface: _aiSurface,
              remote: isRemote,
              provider,
            }).then(r => turnRecord.note(fnName, r)).then(r => ({ fnResult: r.fnResult, clientActions: r.clientActions, pendingScreenImage: r.pendingScreenImage }))),
          });
          json({ text: result.text, clientActions: result.clientActions, newContent: turnRecord.message(result.text), credits: result.balance, toolGroups: toolKit.groups() });
        } catch (e) {
          if (aiStoppedReply(e, json, { credits: Number.isFinite(e.balance) ? e.balance : undefined })) return;
          const code = (e && e.code) || 'network';
          const payable = code === 'no_credits' || code === 'no_code' || code === 'bad_code';
          if (e && e.detail) console.warn('[ai] Xenon AI ' + code + ':', e.detail);
          // What the turn already made (a widget to place) goes back with the error.
          const made = Array.isArray(e && e.clientActions) ? e.clientActions : undefined;
          res.writeHead(payable ? 402 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'xenon_' + code, credits: Number.isFinite(e && e.balance) ? e.balance : undefined, clientActions: made }));
        }
}

module.exports = { chatWithXenon };
