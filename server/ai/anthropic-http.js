'use strict';
// One call to the Anthropic API with the user's own key, and its failure as an error the
// assistant can show.

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

function _httpError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j && j.error && j.error.message) || ''; } catch { /* not JSON */ }
  let err;
  if (status === 401) {
    err = new Error('Claude (Anthropic): the API key is invalid. Check it in Settings → Bit.');
    err.code = 'bad_key';
  } else if (status === 429) {
    err = new Error('Claude (Anthropic): too many requests or credit exhausted (rate limit). Check your Anthropic account.');
    err.code = 'rate_limited';
  } else if (status === 404) {
    err = new Error('Claude (Anthropic): the requested model is not available for your key. Pick another in Settings → Bit.' + (detail ? ' (' + detail + ')' : ''));
    err.code = 'model_missing';
  } else {
    err = new Error('Claude (Anthropic): HTTP error ' + status + (detail ? ' — ' + detail : ''));
    err.code = 'anthropic_http';
  }
  return err;
}

async function _post(apiKey, body, timeoutMs = 90000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') { const err = new Error('Claude (Anthropic): request timed out.'); err.code = 'timeout'; throw err; }
    throw e;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) throw _httpError(res.status, text);
  try { return JSON.parse(text); } catch { throw new Error('Claude (Anthropic): invalid response.'); }
}

module.exports = { ANTHROPIC_URL, ANTHROPIC_VERSION, _httpError, _post };
