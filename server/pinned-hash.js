'use strict';

// ── SHA-256 pin for third-party downloads Xenon unpacks and runs ──────────────
// Whisper.cpp, the uBOL ad-block extension and PresentMon come from other
// projects' GitHub releases, so there is no Xenon signature to check them
// against. What there can be is a pin: one exact release, one exact asset, and
// the SHA-256 of the bytes that were reviewed when the pin was set. A swapped
// or re-uploaded asset, a compromised upstream account or an intercepted
// download then fails the check instead of being executed (whisper-cli.exe and
// PresentMon.exe run as processes; the extension loads into the browser tile).
//
// The pin is the version AND the hash, bumped together. An empty hash means
// nobody has recorded one for that version yet: the download then goes ahead as
// before (TLS only), because refusing a feature outright over a missing constant
// would just push people to fetch the file by hand with no check at all. A
// configured hash is never optional: a mismatch deletes the file and throws.

const fs = require('fs');
const crypto = require('crypto');

function sha256File(file, fsImpl) {
  const f = fsImpl || fs;
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = f.createReadStream(file);
    rs.on('data', (c) => h.update(c));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

// Resolves when `file` matches `expectedHex` (case-insensitive) or no hash is
// configured. Otherwise removes the file and rejects with a message naming both
// digests, so a stale pin is obvious from the error the user reports.
async function checkPinnedSha256(file, expectedHex, label, fsImpl) {
  const f = fsImpl || fs;
  const expected = String(expectedHex || '').trim().toLowerCase();
  if (!expected) return { checked: false };
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    try { f.rmSync(file, { force: true }); } catch { /* ignore */ }
    throw new Error(`${label || 'download'}: the pinned SHA-256 is malformed`);
  }
  const got = await sha256File(file, f);
  if (got !== expected) {
    try { f.rmSync(file, { force: true }); } catch { /* ignore */ }
    throw new Error(`${label || 'download'}: checksum mismatch (expected ${expected}, got ${got})`);
  }
  return { checked: true };
}

module.exports = { sha256File, checkPinnedSha256 };
