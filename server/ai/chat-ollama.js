// One chat turn answered by Ollama on this PC, at the address the request or the settings name
// when it is this PC.

// The lines of the function stood in handleRequest of server/server.js, under `if (provider ===
// 'ollama')`, and are written here as they were, indentation included. The function is handed
// what they read of that function and of the file.
/** @param {any} context what these lines read of the function they stood in, and of its file */
async function chatWithOllama(context) {
  const {
    AI_TOOLS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
    _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, aiBody, apiKey, currentMessages, hasAudio, isRemote,
    isVoice, json, langName, ollModel, res, toolKit, turnRecord, aiLocal, aiStoppedReply, executeAiTool,
    readHubSettings,
  } = context;
        const settings = await readHubSettings().catch(() => null);
        const baseUrl = aiLocal.sanitizeOllamaUrl(aiBody.ollamaUrl || (settings && settings.ollamaUrl));
        const concreteModel = aiLocal.resolveModel(ollModel, settings && settings.hardwareScan);
        // Smaller local models tend to parrot tool output verbatim, so reinforce
        // the language lock: web_search snippets often come back in English and
        // must be translated into the user's language before answering.
        const SYS_LOCAL = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_LOCAL;
        try {
          const result = await aiLocal.localChat({
            baseUrl, model: concreteModel, geminiTools: AI_TOOLS,
            history: currentMessages, systemText,
            executeTool: (fnName, fnArgs) => toolKit.call(fnName, fnArgs, () => executeAiTool(fnName, fnArgs, {
              apiKey, uiLang: _uiLang2, latestUserText: _latestUserText,
              latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
              latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
              pictures: _aiPictures,
              surface: _aiSurface,
              remote: isRemote,
              provider: 'ollama',
            }).then(r => turnRecord.note(fnName, r)).then(r => ({ fnResult: r.fnResult, clientActions: r.clientActions }))),
          });
          json({ text: result.text, clientActions: result.clientActions, newContent: turnRecord.message(result.text), toolGroups: toolKit.groups() });
        } catch (e) {
          if (aiStoppedReply(e, json)) return;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
}

module.exports = { chatWithOllama };
