'use strict';
// Command-line entry for install.ps1: download the native app installer and
// keep it only if it matches the signed release list (native-installer.js, the
// same check the dashboard's one-tap install uses).
//
//   node native-installer-cli.js <destDir>
//
// Prints one line of JSON: {"ok":true,"path":"...","sha256":"..."} or
// {"ok":false,"error":"..."}. Exit code 0 when verified, 1 otherwise. The
// script that runs the installer hashes the file again right before starting
// it, so a file swapped after this check is still refused.

const { createNativeInstallerFetch } = require('./native-installer');

async function main(argv) {
  const destDir = argv[2];
  if (!destDir) return { ok: false, error: 'no_dest' };
  return createNativeInstallerFetch({ destDir }).fetchVerified();
}

if (require.main === module) {
  main(process.argv)
    .catch(() => ({ ok: false, error: 'download_failed' }))
    .then((r) => {
      process.stdout.write(JSON.stringify(r) + '\n');
      process.exitCode = r && r.ok ? 0 : 1;
    });
}

module.exports = { main };
