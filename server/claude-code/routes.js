// What the engine answers about a Claude Code session: its transcript, a picture from it, an
// agent and the plan.

const claudeTranscript = require('../claude-transcript.js');
const claudeUsage = require('../claude-usage.js');
const claudeSubagent = require('../claude-subagent.js');

/** @type {Record<string, (req: any, res: any, context: any) => Promise<void>>} */
const branches = {
  'GET /api/claude/transcript': async (_req, _res, { json, err500, urlObj }) => {
    // The last turns of one session, so a follow-up is not written blind. Pure
    // read, and the session id is matched against a strict shape before it is
    // ever used to look for a file.
    try {
      const out = await claudeTranscript.readTail(
        claudeUsage.resolveProjectsDir(),
        urlObj.searchParams.get('session') || '',
        { full: urlObj.searchParams.get('full') === '1' });
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/transcript-image': async (_req, res, { err500, urlObj }) => {
    // One picture from a session's thread, named by the id the transcript reply
    // gave it. The session id is matched against a strict shape and the image id
    // is two numbers; the answer is an allowlisted image type, never a path or HTML.
    try {
      const out = await claudeTranscript.readImage(claudeUsage.resolveProjectsDir(),
        urlObj.searchParams.get('session') || '', urlObj.searchParams.get('id') || '');
      if (!out.ok) { res.writeHead(out.error === 'bad_request' ? 400 : 404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': out.mime,
        'Content-Length': out.data.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      });
      res.end(out.data);
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/agent': async (_req, _res, { json, err500, urlObj }) => {
    // One subagent of a session, read from Claude Code's own files: type, label,
    // model, effort, context size and its last tool calls. Ids only, both
    // shape-checked before a path is built; never its prompt or tool results.
    try {
      const out = await claudeSubagent.readAgent(claudeUsage.resolveProjectsDir(),
        urlObj.searchParams.get('session') || '', urlObj.searchParams.get('id') || '');
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /api/claude/plan': async (_req, _res, { json, err500, urlObj }) => {
    // The last plan a session wrote, read back from its transcript: the Plan tab
    // asks once when the live feed has none (Xenon started after the plan).
    try {
      json(await claudeTranscript.lastPlan(claudeUsage.resolveProjectsDir(), urlObj.searchParams.get('session') || ''));
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
