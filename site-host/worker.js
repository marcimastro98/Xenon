// xenon-app.com on Cloudflare (10 Nov 2026): the built docs/ served by a Worker with static assets,
// with GitHub Pages' URL rules, so every address the site, the app (server/community-catalog.js
// reads /community/), old links and search engines know answers exactly as before:
//   /faq.html  the file                  /faq   the same file (Pages serves it without .html)
//   /it/       it/index.html             /it    301 to /it/
//   www.       301 to the bare domain    else   404.html with a 404 status
// The assets themselves use html_handling "none": the automatic modes would send /faq.html to
// /faq, and every canonical URL and sitemap entry of the site ends in .html.
// Pages answered every file with Access-Control-Allow-Origin: *; kept so nothing that read the
// catalog or the banners from another origin breaks.
//
// /community/ (catalog, codes, banners, messages) also has a live copy: the supporter hub writes
// every file it commits there to the LIVE bucket (its src/site-live.js), stamped with the commit's
// time. A copy NEWER than the commit this build came from (SITE_COMMIT_TIME, passed by the deploy)
// is served instead of the built file, so a publish is online before the deploy finishes; once
// the deploy catches up the built file wins again. A copy marked deleted answers 404.

const ALLOWED = new Set(['GET', 'HEAD']);
const LIVE_DIR = '/community/';

/** The asset paths to try for a request path, in order. Pure, tested in server/test/site-host.test.mjs. */
export function candidates(path) {
  if (path.endsWith('/')) return [path + 'index.html'];
  const last = path.slice(path.lastIndexOf('/') + 1);
  return last.includes('.') ? [path] : [path, path + '.html'];
}

function dress(res, status) {
  const out = new Response(res.body, { status: status || res.status, statusText: status ? '' : res.statusText, headers: res.headers });
  out.headers.set('access-control-allow-origin', '*');
  return out;
}

function asset(env, request, path) {
  const url = new URL(request.url);
  url.pathname = path;
  return env.ASSETS.fetch(new Request(url, request));
}

/** Whether a live copy's metadata is newer than the build. Pure, tested. */
export function liveIsNewer(meta, siteCommitTime) {
  const copy = Number(meta && meta.committedAt);
  const built = Number(siteCommitTime) || 0;
  return Number.isFinite(copy) && copy > built;
}

// The live copy for a /community/ path, or null to serve the built file. Never throws: a bucket
// that fails leaves the site on its build.
async function live(env, request, url) {
  if (!env.LIVE || !url.pathname.startsWith(LIVE_DIR)) return null;
  try {
    const key = decodeURIComponent(url.pathname.slice(1));
    if (key.includes('..') || key.endsWith('/')) return null;
    const obj = await env.LIVE.get(key);
    if (!obj || !liveIsNewer(obj.customMetadata, env.SITE_COMMIT_TIME)) return null;
    if (obj.customMetadata.deleted === '1') return dress(await asset(env, request, '/404.html'), 404);
    const headers = new Headers({
      'content-type': (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream',
      'cache-control': 'public, max-age=0, must-revalidate',
      etag: obj.httpEtag,
    });
    const fresh = request.headers.get('if-none-match') === obj.httpEtag;
    const body = fresh || request.method === 'HEAD' ? null : obj.body;
    return dress(new Response(body, { status: fresh ? 304 : 200, headers }));
  } catch (err) {
    console.log('live copy unavailable: ' + String((err && err.message) || err).slice(0, 120));
    return null;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname.startsWith('www.')) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
    if (!ALLOWED.has(request.method)) {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const fromLive = await live(env, request, url);
    if (fromLive) return fromLive;
    for (const path of candidates(url.pathname)) {
      const res = await asset(env, request, path);
      if (res.status !== 404) return dress(res);
    }
    if (!url.pathname.endsWith('/')) {
      const folder = await asset(env, request, url.pathname + '/index.html');
      if (folder.ok) {
        url.pathname += '/';
        return Response.redirect(url.toString(), 301);
      }
    }
    return dress(await asset(env, request, '/404.html'), 404);
  },
};
