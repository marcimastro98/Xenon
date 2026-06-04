'use strict';

const https = require('node:https');
const defaultRunner = require('./runner');

const EXE = 'C:\\Program Files\\Sunshine\\sunshine.exe';
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
  exe = EXE,
  base = BASE,
  credentials = null,
  fetchImpl = httpsFetch,
} = {}) {
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
    const q = (s) => String(s).replace(/'/g, "''");
    const inner =
      `& '${q(exe)}' --creds '${q(user)}' '${q(pass)}'; ` +
      `Restart-Service -Name '${q(serviceName)}' -Force`;
    const encoded = Buffer.from(inner, 'utf16le').toString('base64');
    const r = await runner.runElevated('powershell', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded,
    ]);
    return r.code === 0;
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

  return { configureElevated, isResponding, sendPin, listClients, unpairAll, getConfig, setScreen, closeSession };
}

module.exports = { createSunshine, SUNSHINE_EXE: EXE, SUNSHINE_API_BASE: BASE };
