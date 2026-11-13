// What the engine answers about the widgets that are installed: the list, a permission the user
// grants, an install, and a package the user marks as their own.

const { readBody } = require('../http/read-body.js');
const contentInstalls = require('../js/content-installs.js');
const { hub } = require('../settings/current.js');
const sdkWidgets = require('../sdk-widgets.js');
const fs = require('node:fs');
const path = require('node:path');
const { SDK_WIDGETS_DIR } = require('./data-places.js');
const SdkDiagnostics = require('../js/sdk-diagnostics.js');
const LayersModel = require('../js/layers-model.js');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'POST /sdk/grant': async (req, res, { json, err500 }, { saveSdkGrant }) => {
    let body = null;
    try { body = JSON.parse(await readBody(req) || '{}'); } catch (e) { body = null; }
    try {
      const out = await saveSdkGrant(body);
      if (!out.ok) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out)); return; }
      json(out);
    } catch (e) { err500(e.message); }
  },

  'GET /sdk/widgets': async (_req, _res, { json }, { refreshSdkScan, widgetCatalogVersionOf, widgetExportable, widgetOptionsStore, widgetOriginOf }) => {
    // Installed third-party widget packages — validated manifests only (see
    // sdk-widgets.js normalizeManifest). Manifest text is untrusted → the client
    // renders it via textContent. NEVER a JSONP candidate. Always rescans (the
    // Rescan button) and refreshes the shared scan cache. Each package is a copy
    // decorated with origin + exportable (exports limited to the user's own creations).
    const scan = await refreshSdkScan();
    await widgetOptionsStore.load();
    const packages = scan.packages.map(p => ({
      ...p,
      origin: widgetOriginOf(p.id),
      exportable: widgetExportable(p.id),
      catalogVersion: widgetCatalogVersionOf(p.id),
      optionValues: widgetOptionsStore.valuesFor(p),
      edition: contentInstalls.editionOf((hub.settings || {}).contentInstalls, p.id),   // init.edition
    }));
    // `skipped` is how many installed packages this scan did not load because
    // MAX_PACKAGES was already reached. It travels with the list because a
    // shorter list is indistinguishable from a smaller library — which is
    // exactly how a widget came to be installed, working and unfindable.
    json({ ok: true, api: sdkWidgets.SDK_API_VERSION, limits: sdkWidgets.SDK_LIMITS, packages, invalid: scan.invalid, skipped: scan.skipped || 0 });
  },

  'POST /sdk/install': async (req, _res, { json }, { dropSdkGrant, installWidgetPayload, isCatalogUpdateOf, refreshSdkScan, sdkPackagesCached, trialVault, widgetExportable }) => {
    // Install a widget package shipped inside a shared bundle. The payload is
    // validated EXACTLY like a folder scan (manifest rebuilt via normalizeManifest,
    // every file path + extension re-checked, caps enforced) BEFORE a single byte
    // is written; then the files land in DATA_DIR/widgets/<id>/ and the scan
    // refreshes. Grants are NOT auto-issued here — the package renders nothing and
    // reaches no service until the user approves its permissions through the normal
    // grant flow, and the SDK master toggle still gates all runtime ingress.
    // `origin` rides OUTSIDE the validated payload shape (extra keys are ignored
    // by validateWidgetPayload): only 'creator' (the Widget Creator declaring the
    // user's own build) is honoured — anything else records as an import, so a
    // share-code install can never claim to be the user's own work. And even a
    // 'creator' claim can't relabel an id already recorded as an import
    // (mergeOrigin makes 'import' sticky), so replaying an imported payload with
    // origin:'creator' no longer launders it into an exportable "own" widget.
    const body = await readBody(req);
    let payload; try { payload = JSON.parse(body); } catch { payload = null; }
    // A package opened with the pass trial: the files are already in the vault,
    // the import flow only confirms which one to put in place.
    if (payload && payload.trialVault === true) {
      const r = await trialVault.accept(payload.id);
      if (r.ok) await refreshSdkScan();
      json(r);
      return;
    }
    const origin = (payload && payload.origin === 'creator') ? 'creator' : 'import';
    // Optional: the version of the catalog ENTRY this payload came from. Only the
    // caller knows it (the manifest carries its own, unrelated number), and it is
    // what makes 'is there an update' comparable — see recordWidgetOrigin.
    const catalogVersion = (payload && typeof payload.catalogVersion === 'string') ? payload.catalogVersion : '';
    // Writing over an installed id needs a reason (sdkWidgets.installOverwrite):
    // a share code must not inherit the grants of the widget it replaces.
    const v = sdkWidgets.validateWidgetPayload(payload);
    if (!v.ok) { json({ ok: false, error: v.reason }); return; }
    const scan = await sdkPackagesCached();
    const existing = scan.packages.find((p) => p.id === v.id) || null;
    const exists = !!existing || trialVault.has(v.id)
      || await fs.promises.access(path.join(SDK_WIDGETS_DIR, v.id)).then(() => true, () => false);
    const facts = {
      exists,
      origin,
      own: exists && widgetExportable(v.id),
      catalogUpdate: exists && origin === 'import' && await isCatalogUpdateOf(v.id, catalogVersion),
    };
    // The import review asks first, with nothing written: what the SERVER read in
    // the package (never the share code's own description of itself), and
    // whether it would replace a widget that is already here.
    if (payload.dryRun === true) {
      const m = v.manifest;
      const decided = sdkWidgets.installOverwrite({ ...facts, replace: false });
      json({
        ok: true, dryRun: true, id: v.id, name: m.name, version: m.version || '', surface: m.surface || 'tile',
        streams: m.streams, actions: m.actions, hosts: m.hosts, hooks: m.hooks,
        userHosts: Array.isArray(m.userHosts) ? m.userHosts.length : 0,
        storage: m.storage === true, secrets: m.secrets === true, ai: m.ai === true,
        exists, replaces: !decided.ok,
        existingName: existing ? String(existing.name || '') : '',
        existingVersion: existing ? String(existing.version || '') : '',
      });
      return;
    }
    const decided = sdkWidgets.installOverwrite({ ...facts, replace: payload.replace === true });
    if (!decided.ok) {
      json({ ok: false, error: decided.error, id: v.id, name: existing ? String(existing.name || '') : '' });
      return;
    }
    const r = await installWidgetPayload(payload, origin, catalogVersion);
    if (r.ok && decided.dropGrants) {
      await dropSdkGrant(v.id);
      r.replaced = true;
    }
    json(r);
  },

  'POST /sdk/claim': async (req, _res, { json }, { recordWidgetOrigin, sdkPackagesCached, widgetOriginOf }) => {
    // Mark an installed package as the user's OWN creation — a folder they built
    // by hand in server/data/widgets — which makes it exportable again. A
    // deliberate ownership assertion by the user; the install boundary is
    // untouched. Only an 'unknown'-origin package (no record yet) can be claimed:
    // never one recorded as an import or the bundled example. POST + JSON →
    // covered by the loopback Origin layer; NEVER a JSONP candidate.
    const body = await readBody(req);
    let id = '';
    try { id = String((JSON.parse(body || '{}') || {}).id || ''); } catch { id = ''; }
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) { json({ ok: false, error: 'bad_id' }); return; }
    const scan = await sdkPackagesCached();
    if (!scan.packages.some(p => p.id === id)) { json({ ok: false, error: 'not_found' }); return; }
    if (widgetOriginOf(id) !== 'unknown') { json({ ok: false, error: 'not_claimable' }); return; }
    await recordWidgetOrigin(id, 'local');
    json({ ok: true });
  },

  'GET /sdk/export/*': async (_req, _res, { json, reqPath }, { widgetExportable }) => {
    // Read an installed package's files as an embeddable payload for a bundle
    // export. Read-only; the files are already reachable via /sdk/widget/, so this
    // is no new exposure. readPackagePayload applies the same asset allowlist/caps.
    // Redistribution gate: only the user's OWN creations may leave as a share
    // code — packages that arrived via import/gallery (or the bundled example)
    // are refused here, server-side, regardless of what the client asks for.
    const id = decodeURIComponent(reqPath.slice('/sdk/export/'.length));
    if (!widgetExportable(id)) { json({ ok: false, error: 'not_exportable' }); return; }
    const payload = await sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id);
    if (!payload) { json({ ok: false, error: 'not_found' }); return; }
    json({ ok: true, payload });
  },

  'GET /sdk/check/*': async (_req, _res, { json, reqPath }) => {
    // Sandbox diagnostics for a widget's author: a static read of the package's
    // own HTML/JS/CSS naming what the sandbox will refuse (CDN scripts, inline
    // code, direct fetch, localStorage...). Read-only, and it answers kinds,
    // file names and hostnames only, for files /sdk/widget/ already serves.
    // readPackagePayload validates the id and applies the asset allowlist/caps.
    let id = '';
    try { id = decodeURIComponent(reqPath.slice('/sdk/check/'.length)); } catch { id = ''; }
    const payload = await sdkWidgets.readPackagePayload(SDK_WIDGETS_DIR, id);
    if (!payload) { json({ ok: false, error: 'not_found' }); return; }
    const files = payload.files
      .filter((f) => /\.(html?|m?js|css)$/i.test(f.path))
      .map((f) => ({ path: f.path, text: Buffer.from(f.data, 'base64').toString('utf8') }));
    json({ ok: true, issues: SdkDiagnostics.scanWidgetSource(files) });
  },

  'DELETE /sdk/widget/*': async (_req, res, { json, err500, reqPath }, { recordWidgetOrigin, refreshSdkScan, trialVault, updateLayersSetting }) => {
    // Remove one installed package (Settings → installed-packages manager).
    // DELETE + JSON → covered by the loopback Origin layer; the id is validated
    // against the package-id charset and the resolved dir prefix-checked before
    // anything is unlinked. Never GET, never a JSONP candidate.
    try {
      const id = decodeURIComponent(reqPath.slice('/sdk/widget/'.length));
      if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) { res.writeHead(400); res.end(); return; }
      const dir = path.join(SDK_WIDGETS_DIR, id);
      if (!dir.startsWith(SDK_WIDGETS_DIR + path.sep)) { res.writeHead(400); res.end(); return; }
      await fs.promises.rm(dir, { recursive: true, force: true });
      await recordWidgetOrigin(id, 'forget');   // drop the origin record with the files
      if (trialVault.has(id)) await trialVault.remove(id);
      refreshSdkScan();
      await updateLayersSetting((cur) => LayersModel.removePackage(cur, id));
      json({ ok: true });
    } catch (e) { err500(e.message); }
  },
};

module.exports = { branches };
