// The supporter sheet's moving picture: the drops open today, four to a sheet,
// from the marketing files of each pack. Crops keep brand names out: the Wall
// Plate cell is its Hall card, the only one with no streaming service on it.
import path from 'node:path';

const PACKS = 'xenon-creator-output';
export const CLIP = { width: 960, height: 920, gap: 4, seconds: 10, fps: 24, ink: '0x15171a' };

export const CELLS = [
  { name: 'Haunted House', video: 'xenon-haunted-house/marketing/site/banner.mp4', crop: { x: 40, y: 40, w: 500, h: 480 } },
  { name: 'Wall Plate', video: 'xenon-casa/marketing/site/banner.mp4', from: 6.2, span: 3.6, crop: { x: 470, y: 60, w: 500, h: 480 } },
  { name: 'Pit Wall', stills: ['xenon-pit-wall/marketing/pit-wall.png', 'xenon-pit-wall/marketing/pit-wall-2.png'], crop: { x: 160, y: 0, w: 542, h: 520 } },
  { name: 'Lakeside', video: 'xenon-lakeside/marketing/amb_anim.gif', crop: { x: 560, y: 0, w: 376, h: 360 } },
];

export function cellSize(clip = CLIP) {
  return { w: (clip.width - clip.gap) / 2, h: (clip.height - clip.gap) / 2 };
}

/** ffmpeg inputs of one cell: a looped video or stills held for the whole clip. */
function cellInputs(cell, clip, root) {
  const file = (f) => path.join(root, PACKS, f);
  if (cell.stills) return cell.stills.flatMap((f) => ['-loop', '1', '-t', String(clip.seconds), '-i', file(f)]);
  if (cell.span) return ['-ss', String(cell.from), '-t', String(cell.span), '-i', file(cell.video)];
  return ['-stream_loop', '-1', '-i', file(cell.video)];
}

/** The filter of one cell, reading from input `at`, writing [c<i>]. */
function cellFilter(cell, i, at, clip) {
  const { w, h } = cellSize(clip);
  const { crop } = cell;
  const fit = `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${w}:${h}:flags=lanczos,setsar=1,fps=${clip.fps},format=yuv420p`;
  if (cell.stills) {
    const half = clip.seconds / 2 - 0.5;
    return `[${at}:v]${fit}[s${i}a];[${at + 1}:v]${fit}[s${i}b];[s${i}a][s${i}b]xfade=transition=fade:duration=1:offset=${half},trim=duration=${clip.seconds}[c${i}]`;
  }
  // A span plays over and over on its own: the rest of that video is not for this sheet.
  const again = cell.span ? `,loop=loop=-1:size=${Math.round(cell.span * clip.fps)}:start=0` : '';
  return `[${at}:v]${fit}${again},trim=duration=${clip.seconds},setpts=PTS-STARTPTS[c${i}]`;
}

export function mosaicArgs(root, out, cells = CELLS, clip = CLIP) {
  const inputs = [];
  const filters = [];
  let at = 0;
  cells.forEach((cell, i) => {
    inputs.push(...cellInputs(cell, clip, root));
    filters.push(cellFilter(cell, i, at, clip));
    at += cell.stills ? cell.stills.length : 1;
  });
  const { w, h } = cellSize(clip);
  const step = { x: w + clip.gap, y: h + clip.gap };
  const stack = `${cells.map((_, i) => `[c${i}]`).join('')}xstack=inputs=4:layout=0_0|${step.x}_0|0_${step.y}|${step.x}_${step.y}:fill=${clip.ink}[v]`;
  return ['-y', '-v', 'error', ...inputs, '-filter_complex', [...filters, stack].join(';'), '-map', '[v]', '-t', String(clip.seconds), '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out];
}
