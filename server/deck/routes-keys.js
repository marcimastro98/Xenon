// What the engine does for the keys of the Deck: a press, a shortcut step a dashboard takes,
// the Deck in a window of its own, a page shortcut pressed, an action run, and the Deck saved.

const { readBody } = require('../http/read-body.js');
const remoteActions = require('../remote-actions.js');
const { readDeckStore } = require('./store-read.js');
const { DECK_MAX_BYTES } = require('./limits.js');
const deckStore = require('../js/deck-store.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { normalizeDeckStore } = require('./store-normalize.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /deck/popup/open': async (req, _res, { json }, { openDeckPopupWindow }) => {
    // Open the Virtual Deck as an Edge app-mode window on the main PC (shared
    // helper — the AI's open_virtual_deck tool uses the same code path).
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      json(await openDeckPopupWindow(String(body.instance || ''), body.topmost !== false));
    } catch (e) { json({ ok: false, error: (e && e.message) || 'popup_failed' }); }
  },

  'POST /actions/run': async (req, _res, { json, err500, isRemote }, { deckRegistry }) => {
    try {
      const action = JSON.parse(await readBody(req) || '{}');
      // A paired phone runs free actions, and anything else only as a key the
      // user already built (remote-actions.js).
      if (isRemote) {
        const verdict = remoteActions.remoteMayRun(action, await readDeckStore());
        if (!verdict.ok) { json({ ok: false, error: verdict.error }); return; }
      }
      json(await deckRegistry.run(action));
    } catch (e) { err500(e.message); }
  },

  'POST /deck-config': async (req, res, { json, err500, isRemote }, { withDeckWrite, writeDeckStore }) => {
    try {
      const raw = await readBody(req);
      if (raw.length > DECK_MAX_BYTES) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Deck config too large' }));
        return;
      }
      const body = JSON.parse(raw);
      // One Deck write at a time (withDeckWrite): the AI edits keys too.
      await withDeckWrite(async () => {
        const current = await readDeckStore();

        // Current protocol: the client sends only the changes it actually made, as
        // precise ops ({ ops: [...] }). The server owns the store and assigns every
        // revision, so two clients' uncoordinated local counters can never fight —
        // a stale open dashboard simply has no ops to send and can't overwrite or
        // delete decks it never touched (the "edit reverted / second deck wiped
        // after a reboot" loss).
        if (Array.isArray(body.ops)) {
          const applied = deckStore.applyDeckOps(current, body.ops);
          if (!applied.changed) {
            json({ ok: true, rev: current.rev, savedAt: current.savedAt });
            return;
          }
          // A phone may rearrange and edit keys, but not add one that starts
          // a program, types or calls out (remote-actions.js).
          if (isRemote && remoteActions.introduces(current, applied.store)) {
            json({ ok: false, error: 'needs_pc' }); return;
          }
          applied.store.rev = current.rev + 1;
          const saved = await writeDeckStore(applied.store);
          // Nudge every other open dashboard to re-sync its decks right away.
          broadcastSSE('deck', { rev: saved.rev });
          json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
          return;
        }

        // LEGACY whole-blob push (a client still running the previous deck.js, or an
        // old queued beacon). Made strictly ADDITIVE: it can RESTORE an instance the
        // server is missing entirely, but it never overwrites one the server already
        // has. The server is authoritative — its decks got there via precise ops from
        // up-to-date clients — so a stale dashboard can no longer revert a key edit by
        // racing its beacon after a reboot (the reported "my button reverted" loss).
        const incoming = normalizeDeckStore(body);
        const applied = deckStore.applyLegacyBlob(current, incoming);
        if (!applied.changed) {
          json({ ok: true, rev: current.rev, savedAt: current.savedAt });
          return;
        }
        if (isRemote && remoteActions.introduces(current, applied.store)) {
          json({ ok: false, error: 'needs_pc' }); return;
        }
        applied.store.rev = current.rev + 1;   // revs are server-assigned — never adopt a client counter
        const saved = await writeDeckStore(applied.store);
        broadcastSSE('deck', { rev: saved.rev });
        json({ ok: true, rev: saved.rev, savedAt: saved.savedAt });
      });
    } catch (e) { err500(e.message); }
  },

  'GET /deck/press': async (_req, _res, { json, urlObj }, { deckPress }) => {
    json(await deckPress.read(urlObj.searchParams.get('id')));
  },

  'POST /deck/press': async (req, _res, { json }, { deckPress }) => {
    // Only a layer page's real press lands here: same origin, never a phone, never
    // a widget (connect-src 'none'), and no capability reaches it. `accept` is the
    // person agreeing to what the key does now, the fingerprint they were shown.
    try {
      const body = JSON.parse(await readBody(req, 1024) || '{}');
      json(typeof body.accept === 'string' ? await deckPress.accept(body.id, body.accept) : await deckPress.press(body.id));
    } catch { json({ ok: false, error: 'failed' }); }
  },

  'POST /deck/shortcut-claim': async (req, _res, { json }, { deckShortcutRunner }) => {
    // A dashboard on this PC takes a Deck shortcut's step that only a dashboard
    // can do; the first claim wins (deck-shortcut-runner.js). In
    // CSRF_MUTATION_PATHS, denied to paired devices in remote-access.js.
    try {
      const body = JSON.parse(await readBody(req, 4 * 1024) || '{}');
      json({ ok: deckShortcutRunner.claim(body && body.nonce) });
    } catch { json({ ok: false }); }
  },

  'POST /pages/hotkey-press': async (_req, _res, { json, err500, urlObj }, { routeHotkeyIndex }) => {
    // The Linux page shortcuts' other end, one URL per slot: the desktop runs a
    // command and `?i=` says which shortcut ran it. Read off urlObj, because
    // reqPath is the pathname alone and carries no query. It is routed through
    // the same binding table the helper path uses, so an index that no longer
    // exists (settings saved between the press and here) simply does nothing.
    try {
      const at = Number.parseInt(urlObj.searchParams.get('i'), 10);
      if (Number.isInteger(at)) routeHotkeyIndex(at);
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
