// The installer script (install.ps1) installs the native app silently (/S).
// It is held to the same check as the dashboard's one-tap install and every
// update: the signed release list first (native-installer.js), then the file's
// hash again right before it starts. PowerShell cannot run here, so the script
// is checked on its source; the Node side runs for real.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PS = readFileSync(new URL('../install.ps1', import.meta.url), 'utf8');
const cli = require('../native-installer-cli.js');

test('the command line answers without a folder, and never throws', async () => {
  assert.deepEqual(await cli.main(['node', 'x']), { ok: false, error: 'no_dest' });
});

test('install.ps1 runs only a verified installer', () => {
  const at = PS.indexOf("$verifier = Join-Path $PSScriptRoot 'native-installer-cli.js'");
  assert.ok(at > 0, 'the verifier is used');
  const block = PS.slice(at, PS.indexOf('return $true', at));
  assert.match(block, /if \(-not \$verified -or -not \$verified\.ok\)/);
  assert.match(block, /Get-FileHash -LiteralPath \$exe -Algorithm SHA256/, 'hashed again right before it starts');
  assert.ok(block.indexOf('Get-FileHash') < block.indexOf("Invoke-ProcessWithSpinner -FilePath $exe"), 'before it runs');
  assert.doesNotMatch(PS, /Invoke-DownloadWithSpinner -Uri \$asset\.browser_download_url/, 'no unverified download any more');
  assert.doesNotMatch(block, /2>\$null/, 'no stderr redirect that Stop would turn into an error on PowerShell 5.1');
});
