'use strict';
// What the two command-line assistants remember between calls: where Codex was found, the
// private folder they run in, the models Codex listed, the address of Xenon's tools, and how
// many turns are running.

const cliSession = {
  // ── locating the programs ───────────────────────────────────────────────────
  codexCache: null,
  // An empty folder of our own: no project files, no CLAUDE.md or AGENTS.md for
  // the program to pick up, nothing of the user's for it to wander into.
  //
  // Created once per run of the server with mkdtemp (a random name, mode 0700),
  // never a fixed name in the shared temp folder: on a machine with several
  // users another one could create /tmp/xenon-ai-cli first and plant a
  // CLAUDE.md, AGENTS.md or .claude/settings.json the assistant would obey, or
  // read the pictures attached to a question.
  workDir: null,
  // The models the program offers this account today. Claude Code: its own
  // list, from `initialize` above. Codex: its own catalog, `codex debug models`
  // (the ones it marks `visibility: "list"` are the ones its picker shows).
  // Only if the program cannot be asked does Claude Code fall back to its
  // family aliases, which it resolves to the newest model of each family.
  codexModels: { at: 0, list: null },
  mcpUrl: '',
  active: 0,
};

module.exports = { cliSession };
