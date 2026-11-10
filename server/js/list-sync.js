'use strict';
// Saving the Tasks list and the calendar one edit at a time.
//
// These used to be saved whole: the tile posted the list it held. A screen with
// an older list then deleted what a phone, another screen or the assistant had
// added since, and a screen whose first load failed posted an almost empty
// list over the real one. Now each tap sends only the edit (add, change,
// delete, see server/list-ops.js); the server applies it to the list it really
// has and answers with the result.
//
// Edits leave in the order they were made, one at a time. One that cannot reach
// the PC (offline, the server restarting) is retried with a growing pause for as
// long as the page is open, and after a few failures the screen says so once.
// An edit the server refuses for good (a 4xx) is dropped and the caller reloads
// the list, so the screen never keeps showing something that was not saved.
(function (root) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_WARN_AFTER = 3;

  function warnOnce() {
    try {
      if (typeof root.showHubToast === 'function' && typeof root.t === 'function') {
        root.showHubToast('Xenon', root.t('list_save_retry_title'), root.t('list_save_retry'));
      }
    } catch { /* a toast must never stop a save */ }
  }

  /**
   * @param url      the list's route ('/tasks', '/events')
   * @param listKey  the answer's list field ('tasks', 'events')
   * @param onList   (list | null, answer) after the last edit in flight is answered;
   *                 null means it was refused and the caller should reload
   * @param fetchFn  for tests
   * @param delay    (attempt) => ms before a retry, for tests
   */
  function create({ url, listKey, onList, fetchFn, delay, warn }) {
    const doFetch = fetchFn || ((...a) => root.fetch(...a));
    const wait = delay || ((attempt) => Math.min(800 * Math.pow(2, attempt), 10000));
    const sayRetrying = warn || warnOnce;
    let queue = Promise.resolve();
    let pending = 0;
    let warned = false;

    async function post(op) {
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(op),
          });
          let data = null;
          try { data = await res.json(); } catch { /* not JSON: treated as a failure below */ }
          if (res.ok && data && Array.isArray(data[listKey])) { warned = false; return data; }
          const s = res.status;
          if (s >= 400 && s < 500 && s !== 408 && s !== 429) return null;
        } catch { /* no answer at all: retry */ }
        if (attempt + 1 === RETRY_WARN_AFTER && !warned) { warned = true; sayRetrying(); }
        await sleep(wait(attempt));
      }
    }

    function send(op) {
      pending += 1;
      const run = queue.then(() => post(op)).then((data) => {
        pending -= 1;
        const list = data ? data[listKey] : null;
        // Only the answer to the last edit is shown: an earlier answer does not
        // hold the edits still on their way and would briefly undo them. The
        // whole answer goes along, for its `seq`.
        if (pending === 0 && typeof onList === 'function') onList(list, data);
        return list;
      });
      queue = run.catch(() => {});
      return run;
    }

    return { send, busy: () => pending > 0 };
  }

  const api = { create };
  root.ListSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
