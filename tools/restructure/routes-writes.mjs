// The requests of the route check that write something (routes-writes.json).
//
// A plain GET route can be asked blindly; a route that writes cannot, so these are
// picked by hand, each with what it touches, and asked one at a time in the order
// of the list: what one writes, a later one reads back. The same list is asked of
// the engine before a move and of the one after it, and the answers compared like
// every other answer of the check.

import { keyOf } from './branches-kinds.mjs';

/**
 * @param {{ test: string }[]} branches the chain of the request handler
 * @param {{ method: string, path: string, body?: unknown, raw?: string, why?: string }[]} writes the list, in order
 * @returns {{ ask: { label: string, method: string, path: string, headers: Record<string, string>, body?: string }[], stale: string[], unexplained: string[] }}
 *   the requests to make, numbered by their place in the list; the entries that name no route of the handler
 *   ("this address, asked with this method"); and the ones that do not say what they touch
 */
export function writeRequests(branches, writes) {
  const routes = new Set(branches.map((branch) => keyOf(branch.test)).filter(Boolean));
  const ask = [];
  const stale = [];
  const unexplained = [];
  writes.forEach((entry, at) => {
    const key = `${entry.method} ${entry.path}`;
    if (!routes.has(key)) { stale.push(key); return; }
    if (typeof entry.why !== 'string' || entry.why.length < 12) unexplained.push(key);
    const body = typeof entry.raw === 'string' ? entry.raw : entry.body === undefined ? undefined : JSON.stringify(entry.body);
    ask.push({ label: `write ${String(at + 1).padStart(2, '0')}: ${key}`, method: entry.method, path: entry.path,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body }) });
  });
  return { ask, stale, unexplained };
}
