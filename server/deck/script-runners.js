// Which program runs a user script on macOS and Linux, by file extension.

// The interpreter a user script runs under, by extension. The Windows set lives
// in deck-actions.ps1; this is its POSIX twin, and it must cover exactly the
// extensions actions/registry.js accepts off Windows — an extension the gate
// lets through and this table has no entry for would be a key that validates
// and then fails, which is the worst of both. AppleScript is the one darwin-only
// pair: there is no osascript to hand it to anywhere else.
const POSIX_SCRIPT_RUNNERS = {
  '.sh': ['/bin/sh'],
  '.command': ['/bin/sh'],
  '.zsh': ['/bin/zsh'],
  '.bash': ['/bin/bash'],
  '.py': ['/usr/bin/env', 'python3'],
  '.pyw': ['/usr/bin/env', 'python3'],
  '.js': ['/usr/bin/env', 'node'],
  '.cjs': ['/usr/bin/env', 'node'],
  '.mjs': ['/usr/bin/env', 'node'],
  '.rb': ['/usr/bin/env', 'ruby'],
  '.pl': ['/usr/bin/env', 'perl'],
  '.php': ['/usr/bin/env', 'php'],
  '.lua': ['/usr/bin/env', 'lua'],
  '.r': ['/usr/bin/env', 'Rscript'],
  '.jar': ['/usr/bin/env', 'java', '-jar'],
  ...(process.platform === 'darwin' ? {
    '.scpt': ['/usr/bin/osascript'],
    '.applescript': ['/usr/bin/osascript'],
  } : {}),
};

module.exports = { POSIX_SCRIPT_RUNNERS };
