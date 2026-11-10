// Page checks for tools/site-review: pure colour maths plus one audit function
// that runs inside the page. The audit is sent to the browser as source text,
// so every helper it calls is listed in PAGE_LIB and must stay self-contained
// (no imports, no closures over this module).

// 'rgb(1, 2, 3)' / 'rgba(1, 2, 3, 0.5)' / 'rgb(1 2 3 / 50%)' -> {r,g,b,a}, or null.
export function parseColor(text) {
  const m = /^rgba?\(([^)]+)\)$/.exec(String(text).trim());
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const n = parts.map((p) => (p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p)));
  if (n.slice(0, 3).some((v) => !Number.isFinite(v))) return null;
  const a = parts.length > 3 && Number.isFinite(n[3]) ? n[3] : 1;
  return { r: n[0], g: n[1], b: n[2], a };
}

// Colour `top` painted over the opaque colour `under`.
export function over(top, under) {
  const a = top.a;
  return { r: top.r * a + under.r * (1 - a), g: top.g * a + under.g * (1 - a), b: top.b * a + under.b * (1 - a), a: 1 };
}

// WCAG 2.x relative luminance of an sRGB colour.
export function luminance(c) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// WCAG 1.4.3: large text (24px, or 18.66px bold) needs 3:1, the rest 4.5:1.
export function contrastNeeded(fontPx, weight) {
  return fontPx >= 24 || (fontPx >= 18.66 && weight >= 700) ? 3 : 4.5;
}

export const PAGE_LIB = [parseColor, over, luminance, contrastRatio, contrastNeeded].map((f) => f.toString()).join('\n');

// Runs in the page. `opts.minTarget` is the touch target size in CSS px.
export function auditPage(opts) {
  const W = document.documentElement.clientWidth;
  const out = { overflow: [], targets: [], clipped: [], contrast: [], contrastUnknown: 0, pageWidth: document.documentElement.scrollWidth, viewport: W };
  const shown = (el) => {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !el.closest('[aria-hidden="true"],[hidden],dialog:not([open])');
  };
  const name = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) return `${s}#${el.id}`;
    if (el.classList.length) s += '.' + [...el.classList].slice(0, 2).join('.');
    const sec = el.closest('section[id],header,footer');
    const where = sec ? (sec.id ? `#${sec.id}` : sec.tagName.toLowerCase()) : '';
    const text = (el.textContent || el.getAttribute('aria-label') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${where} ${s}${text ? ` "${text}"` : ''}`.trim();
  };
  // A box that scrolls sideways on purpose (carousels) owns its overflow.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden' || ox === 'clip') return true;
    }
    return false;
  };
  const all = [...document.body.querySelectorAll('*')];

  for (const el of all) {
    if (!shown(el) || getComputedStyle(el).position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && !inScroller(el)) out.overflow.push(`${name(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }

  // WCAG 2.5.8 exempts links inside a sentence; everything else gets the full size.
  const inSentence = (el) => getComputedStyle(el).display === 'inline'
    && (el.parentElement?.textContent || '').trim().length > (el.textContent || '').trim().length + 12;
  for (const el of document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[tabindex]:not([tabindex="-1"])')) {
    if (!shown(el) || inSentence(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < opts.minTarget - 0.5 || r.height < opts.minTarget - 0.5) out.targets.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  for (const el of all) {
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const box = el.getBoundingClientRect();
    if (box.width <= 2 || box.height <= 2) continue; // screen-reader-only text
    const hides = cs.overflowX !== 'visible' || cs.textOverflow === 'ellipsis' || cs.webkitLineClamp !== 'none';
    if (hides && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 2)) out.clipped.push(name(el));

    const fg = parseColor(cs.color);
    if (!fg) continue;
    let bg = null;
    let unknown = false;
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (ps.backgroundImage !== 'none') { unknown = true; break; }
      const c = parseColor(ps.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) { bg = c; break; } }
    }
    if (unknown) { out.contrastUnknown++; continue; }
    if (!bg) bg = parseColor(getComputedStyle(document.documentElement).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
    if (bg.a < 1) bg = over(bg, { r: 255, g: 255, b: 255, a: 1 });
    for (let i = layers.length - 1; i >= 0; i--) if (layers[i] !== bg) bg = over(layers[i], bg);
    const ratio = contrastRatio(fg.a < 1 ? over(fg, bg) : fg, bg);
    const need = contrastNeeded(parseFloat(cs.fontSize), Number(cs.fontWeight) || 400);
    if (ratio < need) out.contrast.push(`${name(el)} ${ratio.toFixed(2)} < ${need}`);
  }
  return out;
}

// Installed before the page loads: Largest Contentful Paint and the sum of
// layout shifts not caused by input (stricter than CLS's session windows).
export const VITALS_INIT = `window.__rv = { lcp: 0, lcpEl: '', cls: 0, shifts: [] };
try {
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__rv.lcp = e.startTime; const n = e.element; window.__rv.lcpEl = n ? (n.id ? n.tagName + '#' + n.id : n.tagName + (n.currentSrc ? ' ' + n.currentSrc.split('/').pop() : '')) : ''; } }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue; window.__rv.cls += e.value; const s = e.sources && e.sources[0] && e.sources[0].node; const src = e.sources && e.sources[0]; window.__rv.shifts.push([+e.value.toFixed(4), s ? (s.id || s.className || s.nodeName) + '' : '', src ? Math.round(src.previousRect.top) + '>' + Math.round(src.currentRect.top) : '', Math.round(e.startTime)]); } }).observe({ type: 'layout-shift', buffered: true });
} catch (e) {}`;

// One page's findings against the budgets; [] when it passes.
export function problems(r, budget = { lcp: 2500, cls: 0.1 }) {
  const p = [];
  if (r.pageWidth > r.viewport) p.push(`page scrolls sideways (${r.pageWidth} > ${r.viewport})`);
  for (const k of ['overflow', 'targets', 'clipped', 'contrast']) if (r[k].length) p.push(`${k}: ${r[k].length}`);
  if (r.lcp > budget.lcp) p.push(`LCP ${Math.round(r.lcp)} ms > ${budget.lcp}`);
  if (r.cls > budget.cls) p.push(`CLS ${r.cls.toFixed(3)} > ${budget.cls}`);
  if (r.errors?.length) p.push(`errors: ${r.errors.length}`);
  return p;
}
