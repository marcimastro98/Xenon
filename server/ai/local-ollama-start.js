'use strict';
// Finds the Ollama program on this PC, starts it, and switches its start at login on or off.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile, spawn } = require('node:child_process');
const { _ollamaReachable } = require('./local-ollama-calls.js');

// Locate the Ollama executable. Checks the platform's default install locations.
// Returns the full path or null.
function findOllamaExe() {
  const candidates = [];
  if (process.platform === 'darwin') {
    // Both install shapes: the Ollama.app download (which keeps its CLI inside
    // the bundle and usually symlinks it into /usr/local/bin) and `brew install
    // ollama`. Absolute paths, because a LaunchAgent's PATH has neither prefix.
    candidates.push(
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
      path.join(os.homedir(), 'Applications/Ollama.app/Contents/Resources/ollama'),
    );
  } else {
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'Ollama', 'ollama.exe'));
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

// Start the Ollama server (`ollama serve`) detached, then poll until the HTTP API
// answers. Resolves { ok, running }. If already running, resolves immediately.
async function startOllama(baseUrl, timeoutMs = 12000) {
  if (await _ollamaReachable(baseUrl)) return { ok: true, running: true };
  const exe = findOllamaExe();
  if (!exe) return { ok: false, running: false, error: 'ollama_not_installed' };
  try {
    const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (e) {
    return { ok: false, running: false, error: e.message };
  }
  // Poll for readiness (Ollama takes a moment to bind the port).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 600));
    if (await _ollamaReachable(baseUrl)) return { ok: true, running: true };
  }
  return { ok: false, running: false, error: 'ollama_start_timeout' };
}

// Read/write a per-user "run Ollama at login" entry in the registry Run key.
// Uses reg.exe so no extra dependency is needed. Value name: XenonEdgeOllama.
const _OLLAMA_RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const _OLLAMA_RUN_VALUE = 'XenonEdgeOllama';

// macOS twin of the Run key: a per-user LaunchAgent, deliberately separate from
// the backend's own (com.marcimastro98.xenon.backend) so that turning this
// toggle off can never unregister Xenon itself.
const _OLLAMA_AGENT_LABEL = 'com.marcimastro98.xenon.ollama';
function _ollamaAgentPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${_OLLAMA_AGENT_LABEL}.plist`);
}

// Windows (Run key) and macOS (LaunchAgent); on Linux Ollama's own installer sets up the service.
function ollamaAutostartSupported() {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function getOllamaAutostart() {
  if (!ollamaAutostartSupported()) return Promise.resolve(false);
  if (process.platform === 'darwin') {
    return Promise.resolve(fs.existsSync(_ollamaAgentPlistPath()));
  }
  return new Promise((resolve) => {
    execFile('reg', ['query', _OLLAMA_RUN_KEY, '/v', _OLLAMA_RUN_VALUE], { windowsHide: true },
      (err, stdout) => resolve(!err && /XenonEdgeOllama/i.test(String(stdout))));
  });
}

// Write/remove the macOS LaunchAgent that runs `ollama serve` at login. The
// plist is generated from an absolute exe path we resolved ourselves, so no
// user-controlled text reaches the XML.
async function _setOllamaAutostartDarwin(enabled) {
  const plist = _ollamaAgentPlistPath();
  const domain = `gui/${process.getuid ? process.getuid() : 0}`;
  const launchctl = (args) => new Promise((resolve) => {
    execFile('launchctl', args, { timeout: 10000 }, () => resolve());
  });

  if (!enabled) {
    await launchctl(['bootout', `${domain}/${_OLLAMA_AGENT_LABEL}`]);
    try { await fs.promises.unlink(plist); } catch { /* already gone */ }
    return { ok: true };
  }

  const exe = findOllamaExe();
  if (!exe) return { ok: false, error: 'ollama_not_installed' };
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${_OLLAMA_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${exe}</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
  try {
    await fs.promises.mkdir(path.dirname(plist), { recursive: true });
    await fs.promises.writeFile(plist, body, 'utf8');
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // bootout first so re-enabling reloads a changed exe path instead of keeping
  // the definition launchd already has.
  await launchctl(['bootout', `${domain}/${_OLLAMA_AGENT_LABEL}`]);
  await launchctl(['bootstrap', domain, plist]);
  return { ok: true };
}

function setOllamaAutostart(enabled) {
  if (!ollamaAutostartSupported()) return Promise.resolve({ ok: false, error: 'unsupported' });
  if (process.platform === 'darwin') return _setOllamaAutostartDarwin(enabled);
  return new Promise((resolve) => {
    if (enabled) {
      // Prefer the GUI app (it starts the tray + server); fall back to `serve`.
      const exe = findOllamaExe();
      if (!exe) return resolve({ ok: false, error: 'ollama_not_installed' });
      const appExe = path.join(path.dirname(exe), 'ollama app.exe');
      const target = fs.existsSync(appExe) ? `"${appExe}"` : `"${exe}" serve`;
      execFile('reg', ['add', _OLLAMA_RUN_KEY, '/v', _OLLAMA_RUN_VALUE, '/t', 'REG_SZ', '/d', target, '/f'],
        { windowsHide: true }, (err) => resolve({ ok: !err, error: err && err.message }));
    } else {
      execFile('reg', ['delete', _OLLAMA_RUN_KEY, '/v', _OLLAMA_RUN_VALUE, '/f'],
        { windowsHide: true }, () => resolve({ ok: true })); // ignore "not found"
    }
  });
}


module.exports = {
  findOllamaExe, startOllama, _OLLAMA_RUN_KEY, _OLLAMA_RUN_VALUE, _OLLAMA_AGENT_LABEL,
  _ollamaAgentPlistPath, ollamaAutostartSupported, getOllamaAutostart, _setOllamaAutostartDarwin,
  setOllamaAutostart,
};
