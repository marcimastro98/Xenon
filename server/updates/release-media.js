// Pictures and videos in release notes: which addresses are allowed, what kind a file is, and
// the ones a release really has.

const UPDATE_MEDIA_MAX = 6;                     // at most this many bare URLs get a content-type probe

// ── Release-notes media (screenshots + videos) ──────────────────────────────
// The modal renders images/videos embedded in the GitHub release body. Because
// that body is untrusted text, media is restricted to GitHub-hosted URLs only
// (no arbitrary hosts → no tracking-pixel / IP-leak on open). Markdown images
// `![](url)` are unambiguously images; GitHub embeds *videos* as a bare URL on
// their own line (a UUID with no extension), so those are classified by a
// bounded content-type probe. Result: a `{ url: 'image' | 'video' }` map the
// client uses to pick <img> vs <video>. All of this rides the daily update-check
// cache — it runs at most once a day, never on a request hot path.
function isAllowedMediaUrl(u) {
  try {
    const url = new URL(String(u));
    if (url.protocol !== 'https:') return false;
    const h = url.hostname.toLowerCase();
    if (h === 'github.com') return url.pathname.startsWith('/user-attachments/assets/');
    return h === 'githubusercontent.com' || h.endsWith('.githubusercontent.com');
  } catch { return false; }
}

// Probe a bare media URL's content-type. Tries HEAD, then a 2-byte ranged GET
// (some GitHub asset redirects only surface the type on GET). Fail-silent.
async function classifyMediaContentType(url) {
  const read = async (method, extra) => {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': 'XenonEdgeHub', ...(extra || {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(4000),
    });
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch {}
    if (!res.ok && res.status !== 206) return '';
    return ct;
  };
  let ct = '';
  try { ct = await read('HEAD'); } catch {}
  if (!ct) { try { ct = await read('GET', { Range: 'bytes=0-1' }); } catch {} }
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('image/')) return 'image';
  return '';
}

async function resolveReleaseMedia(body) {
  const md = String(body || '');
  const types = {};
  // Markdown images — trust the syntax, just enforce the host allowlist (no probe).
  const imgRe = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = imgRe.exec(md)) !== null) {
    if (isAllowedMediaUrl(m[1])) types[m[1]] = 'image';
  }
  // Bare URLs alone on a line — GitHub's video-embed shape (also occasionally an
  // image). Classify by content-type, bounded and in parallel so the daily probe
  // never stalls on a slow host.
  const bare = [];
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (/^https?:\/\/\S+$/.test(line) && isAllowedMediaUrl(line) && !types[line] && !bare.includes(line)) {
      bare.push(line);
    }
  }
  const probed = await Promise.all(
    bare.slice(0, UPDATE_MEDIA_MAX).map(async (url) => [url, await classifyMediaContentType(url).catch(() => '')])
  );
  for (const [url, t] of probed) if (t) types[url] = t;
  return types;
}

module.exports = {
  UPDATE_MEDIA_MAX, isAllowedMediaUrl, classifyMediaContentType, resolveReleaseMedia,
};
