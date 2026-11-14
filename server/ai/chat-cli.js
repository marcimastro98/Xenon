// One chat turn answered by the Claude Code or Codex program of the person, with their own
// subscription.

// The lines of the function stood in handleRequest of server/server.js, under `if
// (aiCli.isCliProvider(provider))`, and are written here as they were, indentation included.
// The function is handed what they read of that function and of the file.
/** @param {any} context what these lines read of the function they stood in, and of its file */
async function chatWithCli(context) {
  const {
    AI_FUNCTIONS, SYS_BASE, SYS_LANG, SYS_TEXT, SYS_VOICE, _aiPictures, _aiSurface, _latestExplicitlyWantsScreen,
    _latestLooksLikeClothingWeather, _latestUserText, _uiLang2, apiKey, currentMessages, hasAudio, isRemote, isVoice,
    json, langName, provider, res, turnRecord, aiCli, aiStoppedReply, aiTurns, executeAiTool, readHubSettings,
  } = context;
        // The user's own subscription, through the official Claude Code / Codex
        // program (see ai-cli.js for what that may and may not do). Xenon's tools
        // reach the model over MCP (ai-mcp-bridge.js) and run through the very
        // same executeAiTool as every other provider; the program's own tools
        // (shell, files, web) stay off.
        const settings = await readHubSettings().catch(() => null);
        const cliModel = aiCli.sanitizeModel(settings && (provider === 'claudecode' ? settings.claudeCodeModel : settings.codexModel));
        const SYS_XLATE = (langName ? ` Tool results (especially web_search) may be written in English; ALWAYS translate and write your final answer in ${langName}, never copy the English text verbatim.` : '');
        const SYS_MCP = ' Your tools come from the "xenon" MCP server; their names may carry a prefix such as mcp__xenon__. You have no other tools: no shell, no file access, no web browsing except the web_search tool.';
        const systemText = SYS_BASE + SYS_MCP + ((isVoice || hasAudio) ? SYS_VOICE : SYS_TEXT) + SYS_LANG + SYS_XLATE;
        try {
          const result = await aiCli.chat({
            provider, model: cliModel, systemText, history: currentMessages,
            tools: AI_FUNCTIONS, signal: aiTurns.signal(),
            executeTool: (fnName, fnArgs) => executeAiTool(fnName, fnArgs, {
              apiKey, uiLang: _uiLang2, latestUserText: _latestUserText,
              latestLooksLikeClothingWeather: _latestLooksLikeClothingWeather,
              latestExplicitlyWantsScreen: _latestExplicitlyWantsScreen,
              pictures: _aiPictures,
              surface: _aiSurface,
              remote: isRemote,
              provider,
            }).then(r => turnRecord.note(fnName, r)).then(r => ({ fnResult: r.fnResult, clientActions: r.clientActions, pendingScreenImage: r.pendingScreenImage })),
          });
          json({ text: result.text, clientActions: result.clientActions, newContent: turnRecord.message(result.text) });
        } catch (e) {
          if (aiStoppedReply(e, json)) return;
          const code = (e && e.code) || 'cli_failed';
          res.writeHead(code === 'cli_failed' ? 502 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: code, detail: code === 'cli_failed' ? String((e && e.message) || '').slice(0, 400) : undefined }));
        }
}

module.exports = { chatWithCli };
