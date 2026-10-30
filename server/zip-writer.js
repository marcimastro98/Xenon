'use strict';
// A plain .zip written with node's own fs and zlib, for the bug report package
// (bug-report.js): every system opens it without anything installed. Text is
// deflated; pictures and videos are already compressed, so they are stored.
// Files are streamed (a 4K clip never sits in memory), the CRC is computed on
// the way and each local header is patched in place once its sizes are known,
// so no data descriptors (some unzippers mishandle them on stored entries).
// Written as <out>.part, renamed when complete: a failed write leaves no zip.
// No Zip64: the caller keeps the whole package under MAX_TOTAL.

const fs = require('fs');
const zlib = require('zlib');
const { promisify } = require('util');

const deflateRaw = promisify(zlib.deflateRaw);
const MAX_TOTAL = 0xfffffff0; // under 4 GB, the classic format's limit
const STORED_EXT = /\.(png|jpe?g|gif|webp|mp4|webm|mkv|mov|zip|7z|gz|dmp)$/i;

// zlib.crc32 arrived in node 20.15 / 22.2; the engines field allows 18.15.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Fallback(buf, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev = 0) => zlib.crc32(buf, prev) : crc32Fallback;

// MS-DOS date and time, local, two-second steps (the format's own).
function dosTime(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// A name inside the zip: forward slashes, no drive, no "..", no leading slash.
function safeName(name) {
  const parts = String(name || '').replace(/\\/g, '/').split('/')
    .filter(p => p && p !== '.' && p !== '..' && !/[:*?"<>|\x00-\x1f]/.test(p));
  return parts.join('/').slice(0, 240);
}

function localHeader(nameBuf, method, dt, crc, size, csize) {
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);           // version needed
  h.writeUInt16LE(0x0800, 6);       // UTF-8 names
  h.writeUInt16LE(method, 8);
  h.writeUInt16LE(dt.time, 10);
  h.writeUInt16LE(dt.date, 12);
  h.writeUInt32LE(crc >>> 0, 14);
  h.writeUInt32LE(csize >>> 0, 18);
  h.writeUInt32LE(size >>> 0, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28);
  return Buffer.concat([h, nameBuf]);
}

function centralHeader(e) {
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);           // made by
  h.writeUInt16LE(20, 6);           // version needed
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.dt.time, 12);
  h.writeUInt16LE(e.dt.date, 14);
  h.writeUInt32LE(e.crc >>> 0, 16);
  h.writeUInt32LE(e.csize >>> 0, 20);
  h.writeUInt32LE(e.size >>> 0, 24);
  h.writeUInt16LE(e.nameBuf.length, 28);
  h.writeUInt32LE(e.offset >>> 0, 42);
  return Buffer.concat([h, e.nameBuf]);
}

function endRecord(count, cdSize, cdOffset) {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(0x06054b50, 0);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdSize >>> 0, 12);
  h.writeUInt32LE(cdOffset >>> 0, 16);
  return h;
}

// entries: [{ name, data: Buffer|string }] or [{ name, file, start?, mtime? }];
// `start` skips the head of a file (a big log keeps its newest part).
// Resolves { bytes, count }; rejects with err.code 'too_big' past MAX_TOTAL.
async function writeZip(out, entries, { maxTotal = MAX_TOTAL } = {}) {
  const part = out + '.part';
  const fh = await fs.promises.open(part, 'w');
  let pos = 0;
  const done = [];
  const put = async (buf, at) => {
    await fh.write(buf, 0, buf.length, at == null ? pos : at);
    if (at == null) pos += buf.length;
  };
  const guard = (n) => {
    if (pos + n > maxTotal) throw Object.assign(new Error('zip too big'), { code: 'too_big' });
  };
  try {
    const seen = new Set();
    for (const entry of entries || []) {
      const name = safeName(entry && entry.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const nameBuf = Buffer.from(name, 'utf8');
      const offset = pos;
      if (entry.file) {
        const st = await fs.promises.stat(entry.file);
        const dt = dosTime(entry.mtime || st.mtime);
        const store = STORED_EXT.test(name);
        const method = store ? 0 : 8;
        const from = Number.isInteger(entry.start) && entry.start > 0 ? Math.min(entry.start, st.size) : 0;
        guard(30 + nameBuf.length + st.size - from);
        await put(localHeader(nameBuf, method, dt, 0, 0, 0));
        let crc = 0;
        let size = 0;
        const start = pos;
        const source = fs.createReadStream(entry.file, { start: from });
        const pipe = store ? source : source.pipe(zlib.createDeflateRaw());
        // The CRC is of the original bytes, so it reads the source, not the deflated pipe.
        if (!store) source.on('data', (chunk) => { crc = crc32(chunk, crc); size += chunk.length; });
        try {
          for await (const chunk of pipe) {
            if (store) { crc = crc32(chunk, crc); size += chunk.length; }
            guard(chunk.length);
            await put(chunk);
          }
        } finally {
          source.destroy();
        }
        const csize = pos - start;
        await put(localHeader(nameBuf, method, dt, crc, size, csize), offset);
        done.push({ nameBuf, method, dt, crc, size, csize, offset });
      } else {
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data == null ? '' : entry.data), 'utf8');
        const dt = dosTime(entry.mtime);
        const packed = await deflateRaw(raw);
        const store = packed.length >= raw.length;
        const body = store ? raw : packed;
        const crc = crc32(raw);
        guard(30 + nameBuf.length + body.length);
        await put(localHeader(nameBuf, store ? 0 : 8, dt, crc, raw.length, body.length));
        await put(body);
        done.push({ nameBuf, method: store ? 0 : 8, dt, crc, size: raw.length, csize: body.length, offset });
      }
    }
    const cdOffset = pos;
    for (const e of done) await put(centralHeader(e));
    await put(endRecord(done.length, pos - cdOffset, cdOffset));
    await fh.close();
    await fs.promises.rename(part, out);
    return { bytes: pos, count: done.length };
  } catch (err) {
    await fh.close().catch(() => {});
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { writeZip, safeName, dosTime, crc32, crc32Fallback, MAX_TOTAL };
