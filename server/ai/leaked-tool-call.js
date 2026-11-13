// Recognises a tool call that a model wrote as plain text instead of calling the tool.

// Recent Gemini models occasionally "leak" a tool call as plain text — e.g.
// `[call:default_api:genesis_compose_page{name:Studio,widgets:[notes,tasks]}]`
// — instead of emitting a structured functionCall part. Without this fallback
// the call is never executed and the raw text is shown/spoken to the user.
// Returns { name, args } when the text contains a leaked call to a known
// function, or null. Pseudo-JSON args (unquoted keys/values) are tolerated.
const LEAKED_CALL_RE = /\[?\s*(?:tool_code\s+|call\s*:\s*)(?:default_api[.:])?\s*([A-Za-z0-9_]+)\s*[{(]([\s\S]*?)[)}]\s*\]?/;
function _parseLeakedToolCall(text, validNames) {
  const m = String(text || '').match(LEAKED_CALL_RE);
  if (!m || !validNames.has(m[1])) return null;
  const raw = m[2].trim();
  if (!raw) return { name: m[1], args: {} };
  // Quote bare words (keys and string values) so the pseudo-JSON parses;
  // already-quoted strings, numbers, true/false/null pass through untouched.
  const fixed = ('{' + raw + '}').replace(
    /"[^"]*"|'[^']*'|([A-Za-z_][A-Za-z0-9_\- ]*)/g,
    (tok, bare) => {
      if (bare === undefined) return tok.startsWith("'") ? JSON.stringify(tok.slice(1, -1)) : tok;
      const t = bare.trim();
      return /^(true|false|null)$/.test(t) ? t : JSON.stringify(t);
    }
  );
  try {
    const args = JSON.parse(fixed);
    return (args && typeof args === 'object') ? { name: m[1], args } : null;
  } catch { return null; }
}

module.exports = { LEAKED_CALL_RE, _parseLeakedToolCall };
