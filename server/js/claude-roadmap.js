'use strict';
// The phases of a plan, as a roadmap that lights up with the work.
//
// Claude Code's plan is free-form markdown, so the phases are read out of its
// shape (numbered headings, then a top-level numbered list, then the main
// headings). Where the session keeps a TodoWrite list of the same length, that
// list is the truth about progress. Where it does not, progress is inferred:
// an edit that touches a file or name a phase mentions moves the roadmap to
// that phase, and it only ever moves forward.
//
// Pure functions, exported for node tests (test/claude-roadmap.test.mjs).
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClaudeRoadmap = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX_PHASES = 12;
  const MAX_TITLE = 90;
  const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const NUMBERED = /^(?:\d+[.)]|(?:step|fase|phase|passo|etapa|schritt|étape)\s*\d+)/i;
  const GENERIC = /^(?:context|contesto|background|overview|summary|riepilogo|verification|verifica|testing|test plan|tests?|files?|critical files|out of scope|risks?|rischi)\b/i;
  const FILE_TOKEN = /[\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|css|html|json|md|py|rs|cs|swift|ps1|sh|yml|yaml)\b/gi;
  const CODE_TOKEN = /`([A-Za-z_][\w.$-]{3,40})`/g;

  function clean(s) {
    return String(s).replace(/[*_`#]/g, '').replace(/^\s*(?:\d+[.)]|[-•])\s*/, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  }

  // Lower-cased names a phase mentions: file basenames and `identifiers`.
  function tokensOf(text) {
    const out = new Set();
    for (const m of String(text).matchAll(FILE_TOKEN)) out.add(m[0].split('/').pop().toLowerCase());
    for (const m of String(text).matchAll(CODE_TOKEN)) out.add(m[1].toLowerCase());
    return [...out];
  }

  function group(lines, starts) {
    return starts.map((at, i) => {
      const body = lines.slice(at, i + 1 < starts.length ? starts[i + 1] : lines.length).join('\n');
      return { title: clean(lines[at]), tokens: tokensOf(body) };
    }).filter((p) => p.title).slice(0, MAX_PHASES);
  }

  /** The plan's phases: [{ title, tokens }], or [] when it has no clear steps. */
  function parsePhases(plan) {
    const lines = String(plan || '').split(/\r?\n/);
    const heading = (i) => /^#{2,4}\s+(.+)/.exec(lines[i]);
    const idx = (test) => lines.map((_, i) => i).filter(test);

    // The number is tested before clean(), which strips it.
    const numberedHeads = idx((i) => { const m = heading(i); return m && NUMBERED.test(m[1].replace(/[*_`]/g, '').trim()); });
    if (numberedHeads.length >= 2) return group(lines, numberedHeads);

    // A numbered list under "Verification" or "Context" is not the work itself.
    const generic = [];
    let inGeneric = false;
    lines.forEach((line, i) => {
      const m = heading(i) || /^#\s+(.+)/.exec(line);
      if (m) inGeneric = GENERIC.test(clean(m[1]));
      generic[i] = inGeneric;
    });
    const numberedItems = idx((i) => !generic[i] && /^\d+[.)]\s+\S/.test(lines[i]));
    if (numberedItems.length >= 2) return group(lines, numberedItems);

    for (const level of [2, 3]) {
      const re = new RegExp('^#{' + level + '}\\s+(.+)');
      const heads = idx((i) => { const m = re.exec(lines[i]); return m && !GENERIC.test(clean(m[1])); });
      if (heads.length >= 2) return group(lines, heads);
    }
    return [];
  }

  /**
   * Which phase is current, given the last one and what the session did since
   * the plan was written. Moves forward only, on an edit whose path or command
   * names something the phase mentions.
   */
  function advance(prev, phases, activity, sinceMs) {
    let at = Math.max(0, Math.min(prev || 0, phases.length - 1));
    for (const a of activity || []) {
      if (!a || !EDIT_TOOLS.has(a.tool) || (sinceMs && a.at < sinceMs)) continue;
      const detail = String(a.detail || '').toLowerCase();
      const hit = phases.findIndex((p, i) => i >= at && p.tokens.some((t) => detail.includes(t)));
      if (hit >= 0) at = hit;
    }
    return at;
  }

  /**
   * [{ title, state: 'done' | 'doing' | 'todo' }] for the plan. `todos` (the
   * TodoWrite list) decides when it has one entry per phase; otherwise `current`
   * (from advance) does, and `running` says whether that phase is being worked.
   */
  function roadmap(phases, todos, current, running) {
    if (!phases.length) return [];
    if (Array.isArray(todos) && todos.length === phases.length) {
      return phases.map((p, i) => ({ title: p.title, state: todos[i].status }));
    }
    return phases.map((p, i) => ({
      title: p.title,
      state: i < current ? 'done' : (i === current && running ? 'doing' : 'todo'),
    }));
  }

  return { parsePhases, advance, roadmap, tokensOf };
});
