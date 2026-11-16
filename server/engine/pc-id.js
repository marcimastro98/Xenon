'use strict';
// The id a rating ticket is tied to: a hash of the machine's own id. Unlike the
// install id it survives reinstalling Xenon, or a new vote would be one reinstall
// away. The raw value never leaves this file, and a scope label keeps the hash from
// matching anything else derived from the same machine.
//
// Windows reads the registry here; macOS and Linux go through the collector seam.
// A machine with no readable id falls back to the install id: it can still vote,
// and only loses the reinstall protection.

const crypto = require('crypto');
const { execFile } = require('child_process');

const SCOPE = 'xenon-rating-pc-v1';
const READ_TIMEOUT_MS = 4000;
const GUID_RE = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{16,64})/;

function parseMachineGuid(text) {
  const m = GUID_RE.exec(String(text || ''));
  return m ? m[1].toLowerCase() : '';
}

function windowsMachineId() {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { timeout: READ_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(err ? '' : parseMachineGuid(stdout)));
  });
}

const hashed = (raw) => crypto.createHash('sha256').update(`${SCOPE}|${raw}`).digest('hex');

// `collectors` is the seam (null on Windows); `fallback` gives the install id.
function createPcId({ collectors, fallback }) {
  let value = null;
  return async function pcId() {
    if (value) return value;
    let raw = '';
    try { raw = collectors ? await collectors.machineId() : await windowsMachineId(); } catch { raw = ''; }
    value = hashed(raw || `install|${await fallback()}`);
    return value;
  };
}

module.exports = { createPcId, parseMachineGuid };
