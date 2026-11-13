// What the assistant does when asked to find a file on the PC or to open one it found: it gets
// and gives back ids, never a path.

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'search_files': async ({ fnArgs }, { fileSearch }) => {
      let fnResult;
      // Local search — same pipeline as the Spotlight UI (parser + Windows
      // Search + crawler index + ranker). Read-only; results carry the opaque
      // ids open_search_result resolves, so the model never handles a path as
      // an actionable value.
      const q = String(fnArgs.query || '').trim().slice(0, 200);
      if (!q) { fnResult = { error: 'empty query' }; }
      else {
        const out = await fileSearch.search(q);
        fnResult = {
          windowsSearch: out.wds,
          results: out.results.slice(0, 12).map(r => ({
            id: r.id, name: r.name, folder: r.dir, size: r.size,
            modified: r.mtime ? new Date(r.mtime).toISOString() : '',
          })),
        };
        if (out.wds === 'unavailable' && !out.results.length) {
          fnResult.note = 'Windows Search service is disabled on this PC';
        }
      }
      return fnResult;
  },

  'open_search_result': async ({ fnArgs }, { fileSearch }) => {
      let fnResult;
      const rid = String(fnArgs.id || '').trim();
      if (!rid) { fnResult = { error: 'missing id' }; }
      else {
        const out = fnArgs.reveal === true ? await fileSearch.reveal(rid) : await fileSearch.open(rid);
        if (out.ok) fnResult = { ok: true };
        else fnResult = { error: out.error, revealable: out.revealable === true };
      }
      return fnResult;
  },
};

module.exports = { branches };
