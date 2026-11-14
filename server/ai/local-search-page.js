'use strict';
// Fetches a DuckDuckGo results page for the free web search and reads the results out of its
// HTML.

const { armDeadline } = require('../net-guard.js');
const https = require('node:https');

// HTTPS GET returning the response body as text, following 30x redirects.
function _httpsGetText(url, timeoutMs = 8000, _redirects = 0) {
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('too many redirects'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept': 'text/html,application/json',
      },
    }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(_httpsGetText(next, timeoutMs, _redirects + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('http ' + code)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('search request timed out')); });
    // setTimeout is an idle timeout; a page trickling bytes would hold the
    // search forever. Cap the whole request too.
    armDeadline(req, timeoutMs * 2);
  });
}

// Strip HTML tags and decode the handful of entities DuckDuckGo emits.
function _stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// DuckDuckGo result links are redirect URLs (//duckduckgo.com/l/?uddg=<enc>).
// Extract and decode the real destination, or return the href unchanged.
function _ddgRealUrl(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : 'https:' + href;
  } catch { return href; }
}

// Parse organic results from the DuckDuckGo lite/html SERP.
function _parseDdgHtml(html, limit = 4) {
  const sources = [];
  const linkRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) && sources.length < limit) {
    const url = _ddgRealUrl(m[1]);
    const title = _stripHtml(m[2]);
    if (title && url) sources.push({ title, url });
  }
  const snippets = [];
  const snipRe = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = snipRe.exec(html)) && snippets.length < limit) {
    const text = _stripHtml(m[1]);
    if (text) snippets.push(text);
  }
  return { sources, snippets };
}

module.exports = { _httpsGetText, _stripHtml, _ddgRealUrl, _parseDdgHtml };
