// What the assistant does when asked to look in the Store or to install something from it: the
// install only opens the usual review on the screen, where the user confirms.

const communityCatalog = require('../community-catalog.js');

/** @type {Record<string, (context: any) => Promise<any>>} */
const branches = {
  'marketplace_search': async ({ fnArgs }) => {
      let fnResult;
      const out = await communityCatalog.fetchVisibleCatalog(false);
      if (!out.ok) {
        fnResult = { ok: false, error: 'catalog_unreachable' };
      } else {
        const q = String(fnArgs.query || '').toLowerCase();
        const kind = String(fnArgs.kind || '');
        const list = out.entries
          .filter(e => (!kind || e.kind === kind))
          .filter(e => !q || [e.name, e.author, e.description, e.publisher && e.publisher.handle, ...(e.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q))
          .slice(0, 20)
          .map(e => ({ id: e.id, kind: e.kind, name: e.name, author: (e.publisher && e.publisher.handle) || e.author || '', version: e.version || '', description: e.description || '', locked: !!e.locked }));
        fnResult = { ok: true, results: list };
      }
      return fnResult;
  },

  'marketplace_install': async ({ fnArgs, clientActions }) => {
      let fnResult;
      // Resolve the entry's share code, then hand it to the CLIENT import flow:
      // the user always sees the normal per-kind review dialog — never a silent
      // apply, exactly like pasting the code by hand.
      const out = await communityCatalog.fetchVisibleCatalog(false);
      const entry = out.ok ? out.entries.find(e => e.id === String(fnArgs.id || '')) : null;
      if (!entry) {
        fnResult = { ok: false, error: 'not_found' };
      } else if (entry.locked) {
        fnResult = { ok: false, error: 'locked', hint: 'This entry is protected with access codes: the user needs one (usually a supporter perk) and can import it from the community gallery.' };
      } else {
        const code = entry.code ? { ok: true, code: entry.code } : await communityCatalog.fetchCode(entry.id);
        if (!code.ok) {
          fnResult = { ok: false, error: 'code_unreachable' };
        } else {
          clientActions.push({ action: 'marketplace_open_import', args: { code: code.code } });
          fnResult = { ok: true, note: 'The import review dialog is now open: the user confirms what gets applied/installed there.' };
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
