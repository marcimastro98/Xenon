'use strict';
// Asks BlueZ and oFono over D-Bus with busctl on Linux, and reads values and object lists out
// of its JSON answers.

const { spawn } = require('node:child_process');

const CALL_TIMEOUT_MS = 25000;

// Run busctl and return its stdout. Never throws for a non-zero exit: the
// caller decides what a failure means, and D-Bus errors carry the reason on
// stderr, which is the part worth keeping.
function runBusctl(args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('busctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, error: 'busctl_missing', out: '', err: '' });
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already gone */ }
      finish({ ok: false, error: 'timeout', out, err });
    }, o.timeout || CALL_TIMEOUT_MS);
    timer.unref();

    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (c) => { if (out.length < 4 * 1024 * 1024) out += c; });
    proc.stderr.on('data', (c) => { if (err.length < 64 * 1024) err += c; });
    proc.on('error', () => { clearTimeout(timer); finish({ ok: false, error: 'busctl_missing', out, err }); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0, error: code === 0 ? '' : dbusErrorName(err), out, err });
    });
  });
}

// D-Bus errors come back as "org.bluez.obex.Error.Forbidden: ...". The short
// name is what a user-facing message can be built from; the rest is noise.
function dbusErrorName(stderr) {
  const m = /((?:[A-Za-z][\w-]*\.)+[A-Za-z][\w-]*)\s*:/.exec(String(stderr || ''));
  if (!m) return 'dbus_failed';
  const parts = m[1].split('.');
  return parts[parts.length - 1].toLowerCase() || 'dbus_failed';
}

// Pull the payload out of `busctl --json=short` output.
//
// Deliberately tolerant. busctl has rendered its results in more than one shape
// across systemd versions, and a transport that only understands one of them
// breaks on a distro nobody tested. Anything unrecognised falls back to reading
// the first quoted token out of the plain (non-JSON) rendering, which is the
// form busctl prints without --json at all.
function dbusValue(stdout) {
  const text = String(stdout == null ? '' : stdout).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      if ('data' in parsed) {
        const d = parsed.data;
        return Array.isArray(d) && d.length === 1 ? d[0] : d;
      }
      return parsed;
    }
    return parsed;
  } catch { /* not JSON — fall through to the plain rendering */ }
  const quoted = /"([^"]*)"/.exec(text);
  if (quoted) return quoted[1];
  const bare = text.split(/\s+/);
  return bare.length > 1 ? bare.slice(1).join(' ') : text;
}

// The connected device that carries a phonebook. Addresses come back from the
// object tree, so the MAC we hand to obexd is one BlueZ gave us rather than one
// assembled here.
function parseManagedObjects(json) {
  const devices = [];
  let tree;
  try { tree = typeof json === 'string' ? JSON.parse(json) : json; } catch { return devices; }
  const root = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || {};
  for (const [objPath, ifaces] of Object.entries(root)) {
    const dev = ifaces && ifaces['org.bluez.Device1'];
    if (!dev) continue;
    const val = (k) => (dev[k] && 'data' in dev[k] ? dev[k].data : undefined);
    const uuids = val('UUIDs');
    devices.push({
      path: objPath,
      address: String(val('Address') || ''),
      name: String(val('Alias') || val('Name') || ''),
      connected: val('Connected') === true,
      uuids: Array.isArray(uuids) ? uuids.map(String) : [],
    });
  }
  return devices;
}

// The `a(oa{sv})` rows busctl returns for ListMessages and GetModems alike.
function dbusRows(stdout) {
  let tree;
  try { tree = JSON.parse(String(stdout || '')); } catch { return []; }
  const rows = (tree && tree.data && Array.isArray(tree.data) ? tree.data[0] : tree) || [];
  return Array.isArray(rows) ? rows : [];
}

// The first object path in a busctl result, wherever in the shape it sits.
function firstObjectPath(stdout) {
  const value = dbusValue(stdout);
  if (typeof value === 'string' && value.startsWith('/')) return value;
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === 'string' && v.startsWith('/')) return v;
  }
  const m = /"(\/[^"]*)"/.exec(String(stdout || ''));
  return m ? m[1] : '';
}

module.exports = {
  CALL_TIMEOUT_MS, runBusctl, dbusErrorName, dbusValue, parseManagedObjects, dbusRows,
  firstObjectPath,
};
