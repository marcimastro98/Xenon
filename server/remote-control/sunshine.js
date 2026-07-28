'use strict';

const https = require('node:https');
const defaultRunner = require('./runner');

const fs = require('node:fs');

// Where Sunshine's own binary lives, per platform. It is needed for exactly one
// thing — `--creds`, which has no HTTP equivalent — so a machine where none of
// these exist can still do everything else through the API.
const EXE_CANDIDATES = {
  win32: ['C:\\Program Files\\Sunshine\\sunshine.exe'],
  linux: ['/usr/bin/sunshine', '/usr/local/bin/sunshine'],
  // Homebrew's prefix differs between Apple Silicon and Intel, and neither is a
  // safe default for the other.
  darwin: ['/opt/homebrew/bin/sunshine', '/usr/local/bin/sunshine'],
};
const EXE = EXE_CANDIDATES.win32[0];

// The Flathub build has no binary on PATH — it is reached through flatpak, which
// is why the launcher is a {file, args} pair rather than a path everywhere.
const FLATPAK_ID = 'dev.lizardbyte.app.Sunshine';

function exeCandidates(platform) {
  return EXE_CANDIDATES[platform] || EXE_CANDIDATES.linux;
}
// 127.0.0.1 esplicito (non "localhost"): su Windows Node puo' risolvere localhost
// come IPv6 ::1 mentre Sunshine ascolta su IPv4, causando ECONNREFUSED.
const BASE = 'https://127.0.0.1:47990/api';

// Sunshine usa un certificato self-signed locale: la verifica TLS va disattivata.
// IMPORTANTE: il `fetch` globale di Node (undici) IGNORA l'opzione `agent`, quindi
// rejectUnauthorized:false non verrebbe applicato e OGNI richiesta fallirebbe con
// errore TLS sul cert self-signed. Usiamo il modulo `https` direttamente, che
// onora rejectUnauthorized. Accettabile solo su loopback (il traffico resta locale).
function httpsFetch(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { reject(e); return; }
    const req = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
      rejectUnauthorized: false,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        const status = res.statusCode || 0;
        resolve({
          ok: status >= 200 && status < 300,
          status,
          json: async () => { try { return JSON.parse(data); } catch { return {}; } },
          text: async () => data,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function isLocalhost(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function createSunshine({
  runner = defaultRunner,
  exe = null,
  base = BASE,
  credentials = null,
  fetchImpl = httpsFetch,
  platform = process.platform,
  exists = null,
} = {}) {
  const fileExists = exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const isWin = platform === 'win32';

  /**
   * How to run Sunshine's CLI here: `{ file, args }`, or null if it cannot be
   * found. An explicit `exe` is the caller's answer and is not second-guessed.
   */
  let launcherCache;
  async function launcher() {
    if (launcherCache !== undefined) return launcherCache;
    if (exe) { launcherCache = { file: exe, args: [] }; return launcherCache; }
    for (const p of exeCandidates(platform)) {
      if (fileExists(p)) { launcherCache = { file: p, args: [] }; return launcherCache; }
    }
    // Flathub build: no binary on PATH, reached through flatpak instead.
    if (!isWin) {
      const r = await runner.run('flatpak', ['info', FLATPAK_ID]).catch(() => null);
      if (r && r.code === 0) {
        launcherCache = { file: 'flatpak', args: ['run', `--command=sunshine`, FLATPAK_ID] };
        return launcherCache;
      }
    }
    launcherCache = null;
    return null;
  }

  // Guardia: l'agent self-signed non deve mai essere usato per URL non-localhost.
  // Se base viene sovrascritto con un host remoto il chiamante deve fornire
  // anche un fetchImpl personalizzato con TLS corretto.
  if (!isLocalhost(base)) {
    throw new Error(
      `createSunshine: base URL "${base}" non è localhost. ` +
      'Usa un fetchImpl con TLS verificato per host remoti.'
    );
  }
  // Imposta le credenziali Sunshine E riavvia il servizio in UN'UNICA operazione
  // ELEVATA (un solo prompt UAC). L'elevazione e' obbligatoria: `sunshine.exe
  // --creds` non-elevato non riesce a scrivere la config protetta in Program
  // Files (esce 0 ma non persiste) e il servizio resta senza le credenziali,
  // facendo fallire ogni chiamata API con 401. Il riavvio le rende attive.
  // Si usa -EncodedCommand (base64 UTF-16LE) per evitare problemi di quoting
  // attraverso il doppio livello Start-Process -> powershell.
  // Ritorna true se il processo elevato e' stato avviato (UAC accettato): la
  // conferma reale che le credenziali funzionino spetta al chiamante (auth check).
  async function configureElevated(user, pass, serviceName = 'SunshineService') {
    if (!isWin) return configurePosix(user, pass);
    const l = await launcher();
    const q = (s) => String(s).replace(/'/g, "''");
    const inner =
      `& '${q((l && l.file) || EXE)}' --creds '${q(user)}' '${q(pass)}'; ` +
      `Restart-Service -Name '${q(serviceName)}' -Force`;
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    const r = await runner.runElevated('powershell', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
    ]);
    return r.code === 0;
  }

  /**
   * The same job off Windows, and NOT elevated — which is the whole difference.
   *
   * On Windows Sunshine is a system service whose configuration lives under
   * Program Files, so `--creds` must run as administrator or it exits 0 without
   * persisting anything. On Linux and macOS Sunshine is the USER's: the config
   * is under ~/.config/sunshine and the unit is a `systemctl --user` one. There
   * is nothing to elevate for, so asking for a password here would be theatre —
   * and the restart is the user's own service manager, not the system's.
   */
  async function configurePosix(user, pass) {
    const l = await launcher();
    if (!l) return false;
    const r = await runner.run(l.file, [...l.args, '--creds', String(user), String(pass)],
      { timeoutMs: 60 * 1000 });
    if (r.code !== 0) return false;
    // Credentials are read at startup, so they do not take effect until it
    // restarts. A failure here is not fatal: the caller verifies by asking the
    // API whether the new credentials work.
    await restartUserService().catch(() => null);
    return true;
  }

  async function restartUserService() {
    if (platform === 'darwin') return runner.run('brew', ['services', 'restart', 'sunshine']);
    return runner.run('systemctl', ['--user', 'restart', 'sunshine']);
  }

  function authHeaders() {
    if (!credentials) throw new Error('Credenziali Sunshine non impostate');
    return {
      Authorization: basicAuth(credentials.user, credentials.pass),
      'Content-Type': 'application/json',
    };
  }

  async function call(path, { method = 'GET', body } = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: authHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  async function isResponding() {
    try {
      const res = await call('/config');
      return !!(res && res.ok);
    } catch {
      return false;
    }
  }

  // L'API /api/pin di Sunshine richiede SIA `pin` SIA `name` (etichetta del
  // dispositivo abbinato). Ritorna { ok, status } cosi' il chiamante puo'
  // distinguere un rifiuto reale (es. 401 auth) da un PIN sbagliato.
  async function sendPin(pin, name = 'XenonEdge') {
    const res = await call('/pin', {
      method: 'POST',
      body: { pin: String(pin), name: String(name || 'XenonEdge') },
    });
    return { ok: !!(res && res.ok), status: res ? res.status : 0 };
  }

  async function listClients() {
    const res = await call('/clients/list');
    if (!res || !res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.named_certs) ? data.named_certs : [];
  }

  async function unpairAll() {
    const res = await call('/clients/unpair-all', { method: 'POST', body: {} });
    return !!(res && res.ok);
  }

  async function getConfig() {
    const res = await call('/config');
    if (!res || !res.ok) return {};
    return res.json();
  }

  // Sunshine sceglie il monitor catturato tramite il campo output_name in /api/config.
  // POST /api/config RISALVA l'intera configurazione (come fa la web UI): inviare
  // solo output_name verrebbe rifiutato / sovrascriverebbe il resto. Quindi leggo
  // la config attuale, fondo output_name e rispedisco tutto (read-modify-write).
  async function setScreen(outputName) {
    const current = await getConfig();
    const merged = {
      ...(current && typeof current === 'object' ? current : {}),
      output_name: String(outputName),
    };
    const res = await call('/config', { method: 'POST', body: merged });
    return !!(res && res.ok);
  }

  async function closeSession() {
    const res = await call('/apps/close', { method: 'POST', body: {} });
    return !!(res && res.ok);
  }

  return {
    configureElevated, isResponding, sendPin, listClients, unpairAll,
    getConfig, setScreen, closeSession, launcher,
  };
}

module.exports = {
  createSunshine, SUNSHINE_EXE: EXE, SUNSHINE_API_BASE: BASE,
  EXE_CANDIDATES, exeCandidates, FLATPAK_ID,
};
