'use strict';
// GET /i18n-langs.json?l=de,fr: whole languages of the app's strings, for
// js/i18n-load.js. A page loads only the saved language, the browser's and
// English (/layer-i18n.js); it asks here for the rest when it needs them: a
// language picked since it loaded, or every language for the searches that
// match words in any of them. Read-only, built from js/i18n.js
// (layer-strings.js); unknown codes are left out, never an error.

const LayerI18n = require('../layer-strings.js');

async function readLanguages(req, res) {
  try {
    const query = new URL(req.url || '/', 'http://localhost').searchParams.get('l') || '';
    const body = await LayerI18n.tablesFor(query.split(','));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch (e) {
    console.error('[i18n-langs]', e && e.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('strings unavailable');
  }
}

module.exports = { routes: { 'GET /i18n-langs.json': readLanguages }, readLanguages };
