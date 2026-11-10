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

const ALLOWED = new Set(['GET', 'HEAD']);

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
