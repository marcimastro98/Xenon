'use strict';

const crypto = require('node:crypto');
const { createInstaller } = require('./installer');
const { createTailscale } = require('./tailscale');
const { createSunshine } = require('./sunshine');
const { buildState } = require('./state');
const { createService } = require('./service');
const { createScreens } = require('./screens');

/**
 * Crea l'orchestratore del controllo remoto. `getSettings`/`saveSettings` sono
 * callback verso lo storage settings del server, per persistere user/credenziali.
 * `saveSettings` puo essere async.
 *
 * `deps` e' opzionale e serve esclusivamente per i test: permette di iniettare
 * implementazioni fake al posto di installer/tailscale/sunshine reali senza
 * modificare il comportamento in produzione.
 *
 * @param {{ getSettings: Function, saveSettings: Function, deps?: Object }} options
 */
function createRemoteControl({ getSettings, saveSettings, deps = {} } = {}) {
  if (typeof getSettings !== 'function' || typeof saveSettings !== 'function') {
    throw new TypeError('createRemoteControl: getSettings and saveSettings are required');
  }

  const installer = deps.installer || createInstaller({});
  const tailscale = deps.tailscale || createTailscale({});
  // Factory per un client Sunshine con le credenziali correnti (iniettabile per i test).
  const makeSunshine = deps.makeSunshine || ((credentials) => createSunshine({ credentials }));
  // Tempi di attesa per la verifica post-configurazione (override nei test per velocita').
  const verifyTimeoutMs = Number.isFinite(deps.verifyTimeoutMs) ? deps.verifyTimeoutMs : 15000;
  const verifyIntervalMs = Number.isFinite(deps.verifyIntervalMs) ? deps.verifyIntervalMs : 1000;

  const service = deps.service || createService({});
  const screens = deps.screens || createScreens({
    getSelected: () => ((getSettings() || {}).remoteControl || {}).selectedScreen || '',
    // probe reale collegato nel task di verifica live
  });

  async function waitForResponding(client) {
    const deadline = Date.now() + verifyTimeoutMs;
    // Almeno un tentativo anche se il timeout e' 0.
    do {
      if (await client.isResponding()) return true;
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, verifyIntervalMs));
    } while (Date.now() < deadline);
    return false;
  }

  function currentCreds() {
    const rc = (getSettings() || {}).remoteControl || {};
    if (rc.sunshineUser && rc.sunshinePass) {
      return { user: rc.sunshineUser, pass: rc.sunshinePass };
    }
    return null;
  }

  function sunshineClient() {
    return makeSunshine(currentCreds());
  }

  async function status() {
    const selectedScreen = ((getSettings() || {}).remoteControl || {}).selectedScreen || '';
    return buildState({ installer, tailscale, sunshine: sunshineClient(), service, selectedScreen });
  }

  async function installTool(name) {
    await installer.install(name);
    return installer.isInstalled(name); // verifica reale dopo l'install elevata
  }

  async function configureSunshine() {
    const user = 'xenonedge';
    const pass = crypto.randomBytes(18).toString('base64url');
    // Istanza senza credenziali: setCredentials va tramite CLI (sunshine.exe --creds),
    // non richiede autenticazione HTTP preesistente.
    // Imposta le credenziali e riavvia il servizio in un'unica operazione elevata
    // (un solo UAC). L'elevazione e' obbligatoria: senza admin --creds non scrive
    // la config protetta di Sunshine e il servizio resta senza credenziali.
    const sun = makeSunshine(null);
    const launched = await sun.configureElevated(user, pass);
    if (!launched) {
      // UAC rifiutato o lancio fallito: il servizio non e' stato toccato, non persistiamo.
      throw new Error('Configurazione Sunshine annullata: serve l\'autorizzazione amministratore (UAC).');
    }
    // Verifica PRIMA di persistere: il polling controlla che l'API risponda con
    // le nuove credenziali. Se fallisce NON sovrascriviamo settings.json, cosi'
    // una riconfigurazione non riuscita non distrugge credenziali gia' funzionanti.
    const verifier = makeSunshine({ user, pass });
    const ok = await waitForResponding(verifier);
    if (!ok) {
      throw new Error('Configurazione Sunshine non riuscita: le credenziali non sono state applicate. Riprova e accetta il prompt UAC.');
    }
    // Verificate: ora persistile (segreto, mai loggato).
    const settings = getSettings() || {};
    settings.remoteControl = {
      ...(settings.remoteControl || {}),
      sunshineUser: user,
      sunshinePass: pass,
    };
    await saveSettings(settings);
    return true;
  }

  async function startTailscaleLogin() {
    return tailscale.startLogin();
  }

  async function sendPin(pin) {
    return sunshineClient().sendPin(pin);
  }

  async function killSwitch() {
    return sunshineClient().unpairAll();
  }

  async function enable() {
    const settings = getSettings() || {};
    settings.remoteControl = { ...(settings.remoteControl || {}), enabled: true };
    await saveSettings(settings);
  }

  async function disable() {
    const settings = getSettings() || {};
    settings.remoteControl = { ...(settings.remoteControl || {}), enabled: false };
    await saveSettings(settings);
  }

  function persistScreen(id) {
    const settings = getSettings() || {};
    settings.remoteControl = { ...(settings.remoteControl || {}), selectedScreen: String(id) };
    return saveSettings(settings);
  }

  async function closeSession() { return sunshineClient().closeSession(); }
  async function blockAccess() { return service.stop(); }
  async function unblockAccess() { return service.start(); }
  async function listScreens() { return screens.list(); }

  async function setScreen(id) {
    const ok = await sunshineClient().setScreen(id);
    if (ok) await persistScreen(id);
    return ok;
  }

  async function cycleScreen() {
    const id = await screens.nextId();
    if (!id) return '';
    const ok = await sunshineClient().setScreen(id);
    if (ok) { await persistScreen(id); return id; }
    return '';
  }

  return {
    status, installTool, configureSunshine, startTailscaleLogin,
    sendPin, killSwitch, enable, disable,
    closeSession, blockAccess, unblockAccess, listScreens, setScreen, cycleScreen,
    isWingetAvailable: installer.isWingetAvailable,
  };
}

module.exports = { createRemoteControl };
