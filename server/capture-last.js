'use strict';
// The last steps document and the last bug report package, remembered across
// restarts so "Open" / "Show" still find them (steps-recorder.js,
// bug-report.js). One small JSON in DATA_DIR, written atomically; the paths in
// it never leave this server. Each caller checks what it reads (a hand-edited
// or older file is only a hint) and that the file is still on disk.

const { writeFileAtomic } = require('./atomic-write.js');

function createCaptureLast({ file, readFile, write = writeFileAtomic }) {
  let cache = null;
  let chain = Promise.resolve();

  function all() {
    if (!cache) {
      cache = readFile(file)
        .then((text) => {
          const v = JSON.parse(String(text));
          return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
        })
        .catch(() => ({}));
    }
    return cache;
  }

  async function load(kind) {
    const v = (await all())[kind];
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  // Writes one after the other; a failed write leaves the memory copy, which
  // still serves "Open" until the next restart.
  function save(kind, value) {
    chain = chain.then(async () => {
      const v = await all();
      v[kind] = value;
      await write(file, JSON.stringify(v));
    }).catch(() => {});
    return chain;
  }

  // The { load, save } one recorder takes.
  const forKind = (kind) => ({ load: () => load(kind), save: (value) => save(kind, value) });

  return { load, save, forKind };
}

module.exports = { createCaptureLast };
