'use strict';
// One call to the OpenAI API with the user's own key, and its failure as an error the assistant
// can show.

const OPENAI_BASE = 'https://api.openai.com/v1';

// Turn an OpenAI error body/status into a message the user can act on.
function _httpError(status, bodyText) {
  let detail = '';
  try { const j = JSON.parse(bodyText); detail = (j && j.error && j.error.message) || ''; } catch { /* not JSON */ }
  let err;
  if (status === 401) {
    err = new Error('ChatGPT (OpenAI): the API key is invalid or expired. Check it in Settings → Bit.');
    err.code = 'bad_key';
  } else if (status === 429) {
    err = new Error('ChatGPT (OpenAI): quota exceeded or too many requests (rate limit). Check your OpenAI account credit.');
    err.code = 'rate_limited';
  } else if (status === 404) {
    err = new Error('ChatGPT (OpenAI): the requested model is not available for your key. Pick another in Settings → Bit.' + (detail ? ' (' + detail + ')' : ''));
    err.code = 'model_missing';
  } else {
    err = new Error('ChatGPT (OpenAI): HTTP error ' + status + (detail ? ' — ' + detail : ''));
    err.code = 'openai_http';
  }
  return err;
}

async function _post(pathname, apiKey, body, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(OPENAI_BASE + pathname, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') { const err = new Error('ChatGPT (OpenAI): request timed out.'); err.code = 'timeout'; throw err; }
    throw e;
  }
  clearTimeout(timer);
  const text = await res.text();
  if (!res.ok) throw _httpError(res.status, text);
  try { return JSON.parse(text); } catch { throw new Error('ChatGPT (OpenAI): invalid response.'); }
}

module.exports = { OPENAI_BASE, _httpError, _post };
