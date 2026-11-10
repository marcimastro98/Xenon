#!/usr/bin/env node
// Exports Bit, from the same engine the app draws with, as SVG, PNG, sprite
// sheets, GIF, animated WebP and MP4. See .claude/docs/strumenti.md.
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bit, parseColor, rasterFrame } from './raster.mjs';
import { encodePng, joinHorizontal } from './png.mjs';
import { encodeGif } from './gif.mjs';
import { encodeVideo } from './video.mjs';

const { stillIndex } = createRequire(import.meta.url)('../../packages/core/src/bit-player.js');

export const FORMATS = ['svg', 'png', 'sheet', 'gif', 'webp', 'mp4'];
const VIDEO_BG = '#0a0c0d'; // MP4 has no transparency: Bit's dark screen

const USAGE = `Usage: node tools/bit-export/cli.mjs [clip ...] [options]
  clip              clip ids (default: all); --list shows them
  --kind <k>        only mood | fidget | react clips
  --format <list>   ${FORMATS.join(',')} (default: png,gif)
  --scale <n>       pixels per Bit cell, 1-64 (default 16)
  --bg <#rrggbb>    background; default transparent (MP4: ${VIDEO_BG})
  --tint <mood>     color: a mood name or r,g,b
  --loops <n>       repeat the clip n times in GIF/WebP/MP4 (default 1)
  --out <dir>       output folder (default: <temp>/xenon-bit)`;

function frames(clip, opts, loops = 1) {
  const one = clip.frames.map((f, i) => ({ ...rasterFrame(clip, i, opts), ms: f.ms }));
  return Array.from({ length: loops }, () => one).flat();
}

/**
 * Write one clip in the given formats. Returns the files written.
 * @param {string} id
 * @param {{ formats: string[], scale?: number, background?: string|null, tint?: string, loops?: number, outDir: string }} o
 */
export async function exportClip(id, o) {
  const clip = bit.clip(id);
  if (!clip) throw new Error(`Unknown clip: ${id}`);
  const base = { scale: o.scale || 16, background: o.background || null, tint: o.tint };
  const loops = Math.max(1, o.loops || 1);
  const out = (ext) => path.join(o.outDir, `${id}.${ext}`);
  const written = [];
  const save = async (file, data) => {
    await writeFile(file, data);
    written.push(file);
  };
  for (const format of o.formats) {
    if (format === 'svg') {
      await save(out('svg'), bit.frameSvg(clip, stillIndex(clip), { size: 18 * base.scale, background: base.background, tint: base.tint }));
    } else if (format === 'png') {
      await save(out('png'), encodePng(rasterFrame(clip, stillIndex(clip), base)));
    } else if (format === 'sheet') {
      const all = frames(clip, base);
      await save(out('sheet.png'), encodePng(joinHorizontal(all)));
      const meta = { clip: id, kind: clip.kind, frameWidth: all[0].width, frameHeight: all[0].height, frames: all.map((f) => ({ ms: f.ms })) };
      await save(out('sheet.json'), `${JSON.stringify(meta, null, 2)}\n`);
    } else if (format === 'gif') {
      await save(out('gif'), encodeGif(frames(clip, base, loops), { transparent: !base.background }));
    } else if (format === 'webp' || format === 'mp4') {
      const opts = format === 'mp4' ? { ...base, background: base.background || VIDEO_BG } : base;
      await encodeVideo(frames(clip, opts, loops), format, out(format));
      written.push(out(format));
    } else {
      throw new Error(`Unknown format: ${format} (use ${FORMATS.join(', ')})`);
    }
  }
  return written;
}

export function parseCli(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      format: { type: 'string', default: 'png,gif' },
      scale: { type: 'string', default: '16' },
      bg: { type: 'string' },
      tint: { type: 'string' },
      loops: { type: 'string', default: '1' },
      out: { type: 'string', default: path.join(tmpdir(), 'xenon-bit') },
      list: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const scale = Number(values.scale);
  if (!Number.isInteger(scale) || scale < 1 || scale > 64) throw new Error('--scale must be a whole number from 1 to 64');
  const loops = Number(values.loops);
  if (!Number.isInteger(loops) || loops < 1 || loops > 20) throw new Error('--loops must be a whole number from 1 to 20');
  if (values.bg) parseColor(values.bg);
  if (values.tint && !(values.tint in bit.MOOD_RGB) && !/^\d{1,3},\d{1,3},\d{1,3}$/.test(values.tint)) {
    throw new Error(`Unknown tint: ${values.tint}`);
  }
  const formats = values.format.split(',').map((f) => f.trim()).filter(Boolean);
  for (const f of formats) if (!FORMATS.includes(f)) throw new Error(`Unknown format: ${f}`);
  let ids = positionals.length ? positionals : bit.clips.map((c) => c.id);
  for (const id of ids) if (!bit.clip(id)) throw new Error(`Unknown clip: ${id} (see --list)`);
  if (values.kind) ids = ids.filter((id) => bit.clip(id).kind === values.kind);
  return { ids, formats, scale, loops, background: values.bg || null, tint: values.tint, outDir: values.out, list: values.list, help: values.help };
}

async function main() {
  const o = parseCli(process.argv.slice(2));
  if (o.help) return console.log(USAGE);
  if (o.list) {
    for (const c of bit.clips) console.log(`${c.id.padEnd(14)} ${c.kind.padEnd(7)} ${(bit.duration(c) / 1000).toFixed(1)} s${c.rare ? '  rare' : ''}`);
    return;
  }
  await mkdir(o.outDir, { recursive: true });
  let count = 0;
  for (const id of o.ids) count += (await exportClip(id, o)).length;
  console.log(`${count} files in ${o.outDir}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
