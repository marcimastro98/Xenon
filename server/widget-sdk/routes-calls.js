// What the engine does for a widget while it runs: an answer from the assistant, a web address
// fetched for it, the values it saves and its secrets.

const { readBody } = require('../http/read-body.js');
const { sdkFeatureEnabled, sdkGrantsFor } = require('./grants.js');
const { hub } = require('../settings/current.js');
const sdkWidgets = require('../sdk-widgets.js');
const sdkStore = require('../sdk-store.js');
const { sdkSecretsLoad, sdkStoreLoad, sdkStoreSave, sdkSecretsSave } = require('./store-files.js');
const { sdkFetchGateAcquire, sdkStoreGateOk } = require('./request-gates.js');
const sdkProxy = require('../sdk-proxy.js');
const { broadcastSSE } = require('../http/sse-clients.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /sdk/ai': async (req, _res, { json }, { sdkAi, sdkPackagesCached }) => {
    // A widget's question to the AI the user set for Bit (sdk-ai.js), sent by
    // the dashboard host for a frame it bridged. Needs the `ai` grant (which safe
    // mode and a suspend empty) AND the manifest asking for it, and runs under
    // the user's daily number per widget. In CSRF_MUTATION_PATHS: it spends.
    try {
      const body = JSON.parse(await readBody(req, 64 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      if (!sdkFeatureEnabled() || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(pkgId) || !sdkGrantsFor(pkgId).ai) { json({ ok: false, error: 'not_allowed' }); return; }
      const pkg = (await sdkPackagesCached()).packages.find(p => p.id === pkgId);
      if (!pkg || pkg.ai !== true) { json({ ok: false, error: 'not_allowed' }); return; }
      json(await sdkAi.ask(pkgId, body, hub.settings.sdkAiDailyCap));
    } catch (e) {
      json({ ok: false, error: e instanceof SyntaxError ? 'bad_json' : (e && e.code === 'PAYLOAD_TOO_LARGE' ? 'too_long' : 'failed') });
    }
  },

  'POST /sdk/fetch': async (req, _res, { json, err500 }, { sdkPackagesCached }) => {
    // Host-mediated network for SDK widgets. The sandboxed iframe has NO network
    // (CSP connect-src 'none' — never weakened); instead the dashboard host
    // relays a widget's request here after checking the user's host grants, and
    // this handler re-validates everything against the package's DECLARED host
    // allowlist (manifest = authority): http(s) only, loopback/link-local
    // unreachable even via DNS rebinding (sdk-proxy guarded lookup), plain http
    // only to private-network targets, headers rebuilt from an allowlist, no
    // redirect following, bounded request/response bodies. NEVER a JSONP
    // candidate.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      const body = JSON.parse(await readBody(req, 512 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      const grants = sdkGrantsFor(pkgId);
      // Addresses the user typed into the manifest's declared userHosts slots.
      // resolveUserHosts re-validates every stored value against the manifest's
      // own rules, so this can only ever widen the allowlist to hosts the
      // manifest could have declared itself.
      const filled = sdkWidgets.resolveUserHosts(pkg, grants.userHosts);
      const v = sdkWidgets.validateProxyRequest(pkg, body, filled.hosts);
      if (!v.ok) { json({ ok: false, error: v.error, limit: sdkWidgets.limitFor(v.error) }); return; }
      // Server-side consent: the manifest is the authority for WHICH hosts are
      // reachable, but the user's per-package grant is the authority for whether
      // they approved this one. Enforce it here too, not only in the client bridge
      // — the route is reachable without a mounted widget frame. A filled slot IS
      // the user's consent (they typed that address), so it needs no second grant.
      let host = '';
      try { host = new URL(v.url).hostname.toLowerCase().replace(/\.$/, ''); } catch { /* v.url already validated */ }
      if (!grants.hosts.includes(host) && !filled.hosts.includes(host)) { json({ ok: false, error: 'host_not_granted' }); return; }
      // Secret injection: replace {{secret:NAME}} placeholders in the (already
      // validated) url/headers/body with the package's stored secrets, so the
      // real API key lives server-side and never rode through the sandboxed
      // frame. Gated on the package DECLARING and being GRANTED `secrets`;
      // resolveProxySecrets re-pins the host (a secret can't redirect the
      // request) and re-checks headers for CRLF.
      let outReq = v;
      if (pkg.secrets === true && grants.secrets) {
        const rs = sdkStore.resolveProxySecrets(v, sdkSecretsLoad(pkgId), pkg.hosts.concat(filled.hosts));
        if (!rs.ok) { json({ ok: false, error: rs.error }); return; }
        outReq = rs.req;
      }
      const release = sdkFetchGateAcquire(pkgId);
      if (!release) { json({ ok: false, error: 'rate_limited' }); return; }
      try {
        const r = await sdkProxy.proxyFetch({ ...outReq, maxBytes: sdkProxy.PROXY_MAX_FETCH_BYTES });
        const textual = sdkProxy.isTextualContentType(r.contentType);
        json({
          ok: true,
          status: r.status,
          contentType: r.contentType,
          location: r.location || undefined,
          encoding: textual ? 'utf8' : 'base64',
          body: textual ? r.buffer.toString('utf8') : r.buffer.toString('base64'),
        });
      } catch (e) {
        const msg = String((e && e.message) || 'fetch_failed');
        json({ ok: false, error: ['timeout', 'blocked_address', 'response_too_large'].includes(msg) ? msg : 'fetch_failed', limit: sdkWidgets.limitFor(msg) });
      } finally {
        release();
      }
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else err500(e.message);
    }
  },

  'POST /sdk/store': async (req, _res, { json }, { sdkPackagesCached }) => {
    // Persistent key/value store for a widget's own settings (followed teams,
    // chosen sources, a map's last view). Gated on the package DECLARING
    // `storage` and being GRANTED it; the namespace is the package id, or a
    // shared `storageGroup` so sibling widgets can share one store. Values
    // round-trip through JSON and are size/count-capped in sdk-store.js; writes
    // are change-driven. Data lives in DATA_DIR/widget-store (outside the package
    // folder, so updates/exports never touch it). NEVER a JSONP candidate.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      const body = JSON.parse(await readBody(req, 512 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      const grant = sdkGrantsFor(pkgId);
      if (pkg.storage !== true || !grant.storage) { json({ ok: false, error: 'not_granted' }); return; }
      // A shared group is opened only when it is the group the user approved.
      // Without this, an update (or a replacement under the same id) could
      // declare another widget set's group and read that set's stored data on
      // the strength of a "keep its own settings" approval.
      if (pkg.storageGroup && grant.storageGroup !== pkg.storageGroup) { json({ ok: false, error: 'not_granted' }); return; }
      const isWrite = body.op && ['set', 'delete', 'clear'].includes(body.op.op);
      if (isWrite && !sdkStoreGateOk(pkgId)) { json({ ok: false, error: 'rate_limited' }); return; }
      const ns = sdkStore.storeNamespace(pkg, grant.storageGroup);
      if (!ns) { json({ ok: false, error: 'bad_namespace' }); return; }
      const r = sdkStore.applyStoreOp(sdkStoreLoad(ns), body.op);
      if (!r.ok) { json({ ok: false, error: r.error }); return; }
      if (r.changed) {
        await sdkStoreSave(ns, r.store);
        // Tell OTHER surfaces so their mounted frames of this package (and any
        // storageGroup siblings sharing this namespace) re-mount and re-read the
        // store — the cross-surface "custom widget not 1:1 on the XENON" fix
        // (GitHub #109). The writer's own surface filters this out by origin.
        // Writes only (r.changed is never set by a read), so no spurious remounts.
        //
        // `quiet` writes are stored but NOT announced. The host sets it while a
        // package is settling after a sync re-mount, because a widget that saves
        // its own start-up state would otherwise echo the re-mount straight back
        // and the two surfaces would reload each other without end (the v4.6.1
        // regression). Persisting still matters: the data must be there for the
        // next read, it just isn't news to anyone.
        if (!body.quiet) {
          const pkgs = scan.packages.filter(p => sdkStore.storeNamespace(p, sdkGrantsFor(p.id).storageGroup) === ns).map(p => p.id);
          broadcastSSE('sdk_store', { ns, pkgs, origin: String(body.origin || '') });
        }
      }
      json({ ok: true, value: r.value, keys: r.keys });
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else json({ ok: false, error: (e && e.message) || 'bad_request' });
    }
  },

  'POST /sdk/secret': async (req, _res, { json }, { sdkPackagesCached }) => {
    // Write-only secret vault for API keys. The widget can SET/DELETE named
    // secrets and LIST their names or test existence (`has`), but a read NEVER
    // returns a value — secrets are consumed only by {{secret:NAME}} substitution
    // inside the fetch proxy, server-side, so a published package ships no keys
    // and the sandboxed frame never sees them. Gated on the package DECLARING and
    // being GRANTED `secrets`. Stored in DATA_DIR/widget-secrets. Never JSONP.
    try {
      if (!sdkFeatureEnabled()) { json({ ok: false, error: 'sdk_disabled' }); return; }
      const body = JSON.parse(await readBody(req, 32 * 1024) || '{}');
      const pkgId = String(body.pkg || '');
      const scan = await sdkPackagesCached();
      const pkg = scan.packages.find(p => p.id === pkgId);
      if (!pkg) { json({ ok: false, error: 'unknown_package' }); return; }
      if (pkg.secrets !== true || !sdkGrantsFor(pkgId).secrets) { json({ ok: false, error: 'not_granted' }); return; }
      const isWrite = body.op && ['set', 'delete'].includes(body.op.op);
      if (isWrite && !sdkStoreGateOk('sec:' + pkgId)) { json({ ok: false, error: 'rate_limited' }); return; }
      const r = sdkStore.applySecretOp(sdkSecretsLoad(pkgId), body.op);
      if (!r.ok) { json({ ok: false, error: r.error }); return; }
      if (r.changed) await sdkSecretsSave(pkgId, r.secrets);
      json({ ok: true, names: r.names, has: r.has });
    } catch (e) {
      if (e && e.code === 'PAYLOAD_TOO_LARGE') json({ ok: false, error: 'payload_too_large' });
      else json({ ok: false, error: (e && e.message) || 'bad_request' });
    }
  },
};

module.exports = { branches };
