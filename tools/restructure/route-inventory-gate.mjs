// The gate class of one route: may a paired device ask it (the real remotePathAllowed of
// server/paired/remote-access.js, handed CSRF_MUTATION_PATHS as server.js hands it at
// boot), does the cross-site guard of handleRequest cover it, may it answer as JSONP.
// The guard's two inline rules (isSdkSensitive, isPackMutation) are read from their line;
// a line written any other way stops the inventory.

import { createRequire } from 'node:module';
import path from 'node:path';

import { setOfTexts } from './routes-list.mjs';

const GUARD = '  if ((CSRF_MUTATION_PATHS.has(reqPath) || isSdkSensitive || isPackMutation) &&';
const SDK_LINE = /^ {2}const isSdkSensitive = (.+);$/m;
const PACK_LINE = /^ {2}const isPackMutation = req\.method === '([A-Z]+)' && \((.+)\);$/m;

/** @param {string} written `a || b || ...` @returns {{ exact: string[], prefix: string[] }} */
export function addressRules(written) {
  const exact = [];
  const prefix = [];
  for (const part of written.split(' || ')) {
    const same = /^reqPath === '(\/[^']*)'$/.exec(part);
    const begins = /^reqPath\.startsWith\('(\/[^']*)'\)$/.exec(part);
    if (same) exact.push(same[1]);
    else if (begins) prefix.push(begins[1]);
    else throw new Error(`a rule of the cross-site guard the inventory cannot read: ${part}`);
  }
  return { exact, prefix };
}

/**
 * @param {string} engine server.js @param {any} parser @param {string} root the repo folder whose gate is loaded
 * @returns the lists and rules the classes are worked out from, and the gate's module
 */
export function readGate(engine, parser, root) {
  if (!engine.includes(`\n${GUARD}\n`)) throw new Error('the cross-site guard of handleRequest is not written as the inventory reads it');
  const sdk = SDK_LINE.exec(engine);
  const pack = PACK_LINE.exec(engine);
  if (!sdk || !pack) throw new Error('isSdkSensitive or isPackMutation is not written as the inventory reads it');
  const require = createRequire(path.join(root, 'server', 'paired', 'remote-access.js'));
  const remote = require('./remote-access.js');
  const refused = require('./refused-paths.js');
  const csrf = setOfTexts(engine, parser, 'CSRF_MUTATION_PATHS');
  remote.useGetMutators(new Set(csrf));
  return { remote, refused, csrf: new Set(csrf), jsonp: new Set(setOfTexts(engine, parser, 'JSONP_PATHS')),
    sdk: addressRules(sdk[1]), pack: { method: pack[1], ...addressRules(pack[2]) } };
}

/** @returns {string} what the paired-device door says for one address, with the list that decides when it refuses */
function door(gate, address, method) {
  const { remote, refused, csrf } = gate;
  if (remote.PRE_AUTH.some(([at, asked]) => at === address && asked === method)) return 'yes, before pairing';
  if (remote.remotePathAllowed(address, method)) {
    return (method === 'GET' || method === 'HEAD') && csrf.has(address) ? 'yes (GET_READ_EXCEPTIONS)' : 'yes';
  }
  if (refused.REMOTE_DENY.has(address)) return 'no: REMOTE_DENY';
  if (refused.REMOTE_ADMIN.has(address)) return 'no: REMOTE_ADMIN';
  if (refused.REMOTE_DENY_PREFIXES.some((begins) => address.startsWith(begins))) return 'no: REMOTE_DENY_PREFIXES';
  if (address.startsWith(remote.WIDGET_ASSET_PREFIX)) return 'no: the asset tree answers GET only';
  if (csrf.has(address)) return 'no: a GET that changes something';
  return 'no';
}

/**
 * @param {ReturnType<typeof readGate>} gate @param {{ method: string, path: string }} route
 * @returns {{ paired: string, guard: string, jsonp: boolean, under: string[] }} `under`: for an address that is a
 *   beginning, the listed addresses under it the door or the guard answers differently from the beginning itself
 */
export function classOf(gate, { method, path: address }) {
  const begins = address.endsWith('*') ? address.slice(0, -1) : null;
  const at = begins ?? address;
  const methods = method === '*' ? ['GET', 'POST'] : [method];
  const verdict = (where) => {
    const said = [...new Set(methods.map((one) => door(gate, where, one)))];
    return said.length === 1 ? said[0] : methods.map((one) => `${one}: ${door(gate, where, one)}`).join('; ');
  };
  // A beginning is covered by a rule that is a beginning too; a whole address by any rule that names it.
  const guardOf = (where, whole) => {
    if (whole && gate.csrf.has(where)) return 'CSRF_MUTATION_PATHS';
    if ((whole && gate.sdk.exact.includes(where)) || gate.sdk.prefix.some((rule) => where.startsWith(rule))) return 'isSdkSensitive';
    if ((method === gate.pack.method || method === '*') && gate.pack.prefix.some((rule) => where.startsWith(rule))) return 'isPackMutation';
    return '';
  };
  if (method === 'WS') return { paired: 'no: sockets take the loopback door only', guard: '', jsonp: false, under: [] };
  // A preflight is answered for any address before the guard and the routes; the door lets it through anywhere.
  if (method === 'OPTIONS' && address === '*') return { paired: door(gate, '/', 'OPTIONS'), guard: '', jsonp: false, under: [] };
  const paired = verdict(at);
  const guard = guardOf(at, !begins);
  const under = [];
  if (begins) {
    const listed = new Set([...gate.csrf, ...gate.refused.REMOTE_DENY, ...gate.refused.REMOTE_ADMIN, ...gate.sdk.exact]);
    for (const one of [...listed].filter((entry) => entry.startsWith(begins) && entry !== begins).sort()) {
      const own = verdict(one);
      const ownGuard = guardOf(one, true);
      if (own !== paired || ownGuard !== guard) under.push(`${one} (${[own, ownGuard].filter(Boolean).join(', ')})`);
    }
  }
  return { paired, guard, jsonp: !begins && gate.jsonp.has(at) && (method === 'GET' || method === '*'), under };
}
