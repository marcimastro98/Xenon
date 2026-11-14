// The Gemini key a request runs with: the one it carries, or the one in the settings, which
// never leaves this PC.

const { readHubSettings } = require('../settings/read.js');

// The server-side half of "the Gemini key never leaves this machine" (see
// ai-provider-creds.js). The client still sends a `key` field — every AI request
// body has carried one since v2 and other callers (the iCUE widget, a widget's
// own key one day) may legitimately supply their own — but the dashboard's copy
// is now always empty, so an empty one means "use the key on disk" rather than
// "no key". Endpoints that already read settings for other reasons keep their
// inline `body.key || settings.geminiApiKey`; this exists for the ones that do
// not, so a settings read is paid only when the fallback is actually needed.
// Never turn this into a way to READ the key back out over HTTP.
async function geminiKeyFor(bodyKey) {
  const given = String(bodyKey || '').trim().slice(0, 200);
  if (given) return given;
  const s = await readHubSettings().catch(() => null);
  return String((s && s.geminiApiKey) || '').trim().slice(0, 200);
}

module.exports = { geminiKeyFor };
