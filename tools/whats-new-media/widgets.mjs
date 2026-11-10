// The widgets sheet's moving picture: the desktop picture of the site, taken
// apart. The wallpaper stays, and each placed widget arrives on it in turn.
import { PLAN, VIEWPORT } from '../site-shots/desktop.mjs';

export const CLIP = { width: 960, height: 920, seconds: 7, fps: 30 };
const FIRST_AT = 0.5;
const EVERY = 0.8;
const ARRIVE = 0.4;
const RISE = 26;
const LEAVE = 0.4;
// Room around a tile for its shadow, in clip pixels.
const MARGIN = 10;

/** The part of the desktop the clip shows: the widgets, with even margins, at the clip's shape. */
export function view(plan = PLAN, viewport = VIEWPORT, clip = CLIP) {
  const W = viewport.width * viewport.scale;
  const H = viewport.height * viewport.scale;
  const w = Math.round((H * clip.width) / clip.height);
  const left = Math.min(...plan.map(([, r]) => r.x)) * W;
  const right = Math.max(...plan.map(([, r]) => r.x + r.w)) * W;
  const x = Math.round((left + right - w) / 2);
  return { x: Math.max(0, Math.min(x, W - w)), y: 0, w, h: H, W, H };
}

/** One tile's rectangle in clip pixels, margin included, on even numbers. */
export function tileBox(rect, v = view(), clip = CLIP) {
  const k = clip.width / v.w;
  const even = (n) => Math.max(0, Math.round(n / 2) * 2);
  const x = even((rect.x * v.W - v.x) * k - MARGIN);
  const y = even((rect.y * v.H - v.y) * k - MARGIN);
  return {
    x, y,
    w: Math.min(even(rect.w * v.W * k + MARGIN * 2), clip.width - x),
    h: Math.min(even(rect.h * v.H * k + MARGIN * 2), clip.height - y),
  };
}

export function arrivals(plan = PLAN) {
  return plan.map((_, i) => FIRST_AT + i * EVERY);
}

export function widgetsArgs(wall, layer, out, plan = PLAN, clip = CLIP) {
  const v = view(plan, VIEWPORT, clip);
  const fit = `crop=${v.w}:${v.h}:${v.x}:${v.y},scale=${clip.width}:${clip.height}:flags=lanczos,setsar=1`;
  const leaveAt = clip.seconds - LEAVE - 0.1;
  const times = arrivals(plan);
  const parts = [`[0:v]${fit},format=yuv420p[b0]`, `[1:v]${fit},format=rgba,split=${plan.length}${plan.map((_, i) => `[l${i}]`).join('')}`];
  plan.forEach(([, rect], i) => {
    const box = tileBox(rect, v, clip);
    const at = times[i];
    const next = i === plan.length - 1 ? 'v' : `b${i + 1}`;
    parts.push(`[l${i}]crop=${box.w}:${box.h}:${box.x}:${box.y},fade=t=in:st=${at}:d=${ARRIVE}:alpha=1,fade=t=out:st=${leaveAt}:d=${LEAVE}:alpha=1[t${i}]`);
    parts.push(`[b${i}][t${i}]overlay=x=${box.x}:y='${box.y}+${RISE}*pow(1-clip((t-${at})/${ARRIVE},0,1),3)':eval=frame:format=auto[${next}]`);
  });
  const still = (f) => ['-loop', '1', '-framerate', String(clip.fps), '-t', String(clip.seconds), '-i', f];
  return ['-y', '-v', 'error', ...still(wall), ...still(layer), '-filter_complex', parts.join(';'), '-map', '[v]', '-t', String(clip.seconds), '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '23', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}
