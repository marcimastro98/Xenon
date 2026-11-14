// The door Claude Code and Codex build widgets through, as the engine's request handler reaches
// it: refused to a paired device before the handler is called.

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  '* /api/mcp/dev/*': async (req, res, { json, reqPath, isRemote }, { handleMcpDevRoute }) => {
    // Claude Code / Codex building widgets (mcp-dev.js). Never from a paired
    // device: absent from remotePathAllowed, and refused here as well.
    if (isRemote) { res.writeHead(403); res.end(); return; }
    try {
      await handleMcpDevRoute(req, res, reqPath, json);
    } catch (e) {
      json({ ok: false, error: e instanceof SyntaxError ? 'bad_json' : (e && e.code === 'PAYLOAD_TOO_LARGE' ? 'too_large' : 'failed') });
    }
  },
};

module.exports = { branches };
