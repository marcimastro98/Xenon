'use strict';
// Who a Claude Code session is, the same way on every surface of the tile: a
// title, a line that places it, and a colour. Three sessions in one folder used
// to read "xenon", "xenon", "xenon", and the only way to tell them apart was to
// open each one.
//
//   title  what Claude Code calls the chat: a /rename, else its own summary
//          (payload.titles, read from the transcript), else the project.
//   sub    project · branch · #id4. The id slice is always there, so the same
//          session can be matched between the rail, the console, a card and the
//          terminal's /resume list.
//   slot   0..SLOTS-1, from the id, so a session keeps its colour for its whole
//          life and on every screen. The colours are CSS tokens (.is-s0..7).
//
// Pure; exported for node tests (test/claude-ident.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClaudeIdent = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const SLOTS = 8;

  // FNV-1a: tiny, stable across engines, and spreads uuids evenly enough over
  // eight slots. Not security, just a colour.
  function slot(id) {
    const s = String(id || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % SLOTS;
  }

  function shortId(id) { return String(id || '').slice(0, 4); }

  /**
   * @param {{id?:string, name?:string, project?:string, branch?:string}} sess
   * @param {Record<string,string>} [titles]
   * @param {string} [fallback] shown when nothing else names the session
   * @returns {{ title: string, sub: string[], slot: number, tag: string }}
   */
  function describe(sess, titles, fallback) {
    const s = sess || {};
    const id = String(s.id || '');
    const named = String(s.name || (titles && id && titles[id]) || '').trim();
    const project = String(s.project || '').trim();
    const title = named || project || String(fallback || '').trim();
    const sub = [];
    // The project is the title when nothing better names the session; saying
    // it twice on two lines reads as a glitch.
    if (project && named) sub.push(project);
    if (s.branch) sub.push(String(s.branch));
    const tag = id ? '#' + shortId(id) : '';
    if (tag) sub.push(tag);
    return { title, sub, slot: slot(id), tag };
  }

  // An MCP tool arrives as "mcp__<server>__<tool>". Printed raw it is the
  // longest thing on the line and the least readable; Claude Code itself shows
  // the server and the tool, so this does too.
  function toolLabel(name) {
    const s = String(name || '');
    const m = /^mcp__(.+?)__(.+)$/.exec(s);
    return m ? m[1] + ' · ' + m[2] : s;
  }

  return { SLOTS, slot, shortId, describe, toolLabel };
});
