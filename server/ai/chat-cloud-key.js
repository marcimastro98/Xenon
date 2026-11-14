// One chat turn answered by ChatGPT or Claude with the person's own key, read from the settings
// and never from the request.

// The lines of the function stood in handleRequest of server/server.js, under `if (provider ===
// 'openai' || provider === 'anthropic')`, and are written here as they were, indentation
// included. The function is handed what they read of that function and of the file.
/** @param {any} context what these lines read of the function they stood in, and of its file */
async function chatWithCloudKey(context) {
  const {
    AI_TOOLS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
    _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote, isVoice,
    json, langName, provider, res, toolKit, turnRecord, aiAnthropic, aiOpenai, aiStoppedReply, executeAiTool,
    providerModelFor, readHubSettings,
  } = context;
        // Server-mediated cloud providers (ChatGPT / Claude). Their keys are
        // SERVER-ONLY, so read them from settings — never from the request body.
        // Chat + function-calling + vision reuse the same tools and the same
        // { text, clientActions, newContent } response shape as Gemini/local.
        const settings = await readHubSettings().catch(() => null);
        const provKey = provider === 'openai'
          ? String((settings && settings.openaiApiKey) || '').trim()
          : String((settings && settings.anthropicApiKey) || '').trim();
        if (!provKey) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing_key' })); return;
        }
        const provModel = providerModelFor(provider, 'chat', settings);
        // web_search for these providers runs key-free via DuckDuckGo (see below),
        // whose snippets are often English — reinforce the language lock, exactly
        // like the local path does.
        const SYS_XLATE = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_XLATE;
        const mod = provider === 'openai' ? aiOpenai : aiAnthropic;
        try {
          const result = await mod.chat({
            apiKey: provKey, model: provModel, geminiTools: AI_TOOLS,
            history: currentMessages, systemText,
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
          json({ text: result.text, clientActions: result.clientActions, newContent: turnRecord.message(result.text), toolGroups: toolKit.groups() });
        } catch (e) {
          if (aiStoppedReply(e, json)) return;
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
}

module.exports = { chatWithCloudKey };
