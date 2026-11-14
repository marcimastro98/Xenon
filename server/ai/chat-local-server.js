// One chat turn answered by a server the person runs on this PC: its address and key come from
// the settings, never the request.

// The lines of the function stood in handleRequest of server/server.js, under `if (provider ===
// 'localapi')`, and are written here as they were, indentation included. The function is handed
// what they read of that function and of the file.
/** @param {any} context what these lines read of the function they stood in, and of its file */
async function chatWithLocalServer(context) {
  const {
    AI_TOOLS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
    _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote, isVoice,
    json, langName, provider, res, toolKit, turnRecord, aiLocalServer, aiStoppedReply, aiTurns, executeAiTool,
    readHubSettings,
  } = context;
        // A server the user runs on this PC. Its URL and key come from the
        // settings, never the request. Same tools and reply shape as ChatGPT;
        // a turn can sit on a slow model for minutes, so stop cuts it at once.
        const settings = await readHubSettings().catch(() => null);
        const SYS_XLATE = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const systemText = SYS_BASE + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_XLATE;
        try {
          const result = await aiLocalServer.chat({
            config: aiLocalServer.configFrom(settings), geminiTools: AI_TOOLS,
            history: currentMessages, systemText, signal: aiTurns.signal(),
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
          json({ text: result.text, clientActions: result.clientActions, newContent: turnRecord.message(result.text), toolGroups: toolKit.groups(), toolsOff: result.toolsOff });
        } catch (e) {
          if (aiStoppedReply(e, json)) return;
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message, detail: e.detail, clientActions: aiTurns.madeSoFar() }));
        }
}

module.exports = { chatWithLocalServer };
