'use strict';
// The limits of the assistant's subscription providers (Claude Code, Codex): which they are,
// how long a turn may take, how much text is kept, and what a model name may look like.

const PROVIDERS = Object.freeze(['claudecode', 'codex']);
const TIMEOUT_MS = 180000;          // a long reasoning answer, not a hung child
const TOOL_TIMEOUT_MS = 300000;     // a turn that may call several dashboard tools
const STATUS_TIMEOUT_MS = 30000;  // a first start on Windows can take a while
const STATUS_TTL_MS = 30000;
const MODELS_TTL_MS = 60 * 60 * 1000;   // Settings asks for a fresh list whenever it opens
const MAX_ACTIVE = 2;               // concurrent turns; the quota is shared and finite
const MAX_PROMPT_CHARS = 60000;     // history is trimmed from the oldest turn
const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

// Claude Code's own aliases (claude --help: "an alias for the latest model").
// The subscription decides which ones the account may use; the program answers
// with a clear error for one it may not, and that error reaches the chat.
const CLAUDE_MODELS = Object.freeze([
  { id: 'fable', label: 'Fable' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
]);

function isCliProvider(p) { return PROVIDERS.includes(p); }

// 'default' = let the program choose (its own default, or the user's). Anything
// else is a model name: letters first, so it can never be read as a flag.
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
function sanitizeModel(v) {
  const s = String(v == null ? '' : v).trim();
  return s && s !== 'default' && MODEL_RE.test(s) ? s : 'default';
}

module.exports = {
  PROVIDERS, TIMEOUT_MS, TOOL_TIMEOUT_MS, STATUS_TIMEOUT_MS, STATUS_TTL_MS, MODELS_TTL_MS,
  MAX_ACTIVE, MAX_PROMPT_CHARS, MAX_STDOUT, MAX_STDERR, CLAUDE_MODELS, isCliProvider, MODEL_RE,
  sanitizeModel,
};
