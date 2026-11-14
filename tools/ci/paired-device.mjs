// Pairs an invented device with a throwaway engine (engine-rig.mjs) and sends requests as
// that device, the way a phone on the same network does: paired access switched on from
// this computer, a pairing code asked from this computer, the code redeemed through the
// paired-device door, and from then on the cookie the engine handed out.
//
// A request reaches the paired-device door, not the door of this computer, when its Host
// names one of the computer's network addresses. The rig's engine listens on this
// computer only, so the request is still made to 127.0.0.1: nothing is opened to the network.

/**
 * The headers a paired device's browser sends. Pure, so it is tested.
 * @param {string} host the address and port the device opened, `192.0.2.7:3041`
 * @param {string} [cookie] the pairing cookie, `name=value`
 * @returns {Record<string, string>}
 */
export function deviceHeaders(host, cookie) {
  return { Host: host, Origin: `http://${host}`, ...(cookie ? { Cookie: cookie } : {}) };
}

/** @param {string | string[] | undefined} setCookie @returns {string} the `name=value` of the first cookie, or '' */
export function cookiePair(setCookie) {
  const first = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  return String(first || '').split(';')[0].trim();
}

/**
 * @param {{ ask: Function }} rig @param {string} [name] an invented device name
 * @returns {Promise<{ ok: true, host: string, name: string, ask: Function, stranger: Function } | { ok: false, why: string }>}
 */
export async function pairDevice(rig, name = 'Test Phone') {
  const enabled = await rig.ask('POST', '/api/remote-access/enable', { value: true });
  if (enabled?.status !== 200 || enabled.json?.enabled !== true) return { ok: false, why: `paired access could not be switched on (${enabled?.status ?? 'no answer'})` };
  const pairing = await rig.ask('POST', '/api/remote-access/pair', {});
  if (pairing?.json?.ok !== true) return { ok: false, why: `no pairing code: ${pairing?.json?.error ?? pairing?.status ?? 'no answer'}` };
  const host = `${pairing.json.addresses[0]}:${pairing.json.port}`;
  const redeemed = await rig.ask('POST', '/api/remote-access/redeem', { code: pairing.json.code, name }, deviceHeaders(host));
  const cookie = cookiePair(redeemed?.headers?.['set-cookie']);
  if (redeemed?.status !== 200 || !cookie) return { ok: false, why: `the code was not taken (${redeemed?.status ?? 'no answer'})` };
  return {
    ok: true, host, name,
    /** A request as the paired device. */
    ask: (method, pathname, body, headers = {}) => rig.ask(method, pathname, body, { ...deviceHeaders(host, cookie), ...headers }),
    /** The same request from a device on the network that was never paired. */
    stranger: (method, pathname, body) => rig.ask(method, pathname, body, deviceHeaders(host)),
  };
}
