// What the assistant does when asked to open an app, a site or a document, to lock the PC, or
// to run a command on it: a command is only proposed here, and runs after the user approves it
// on the screen.

// biome-ignore-all lint/style/useConst: every function here is a piece of one long function, word for word, so the answer is declared on one line and set on another even where it is set only once.

const { lockWorkstation } = require('../system/lock-workstation.js');
const aiPcApps = require('../ai-pc-apps.js');
const remoteActions = require('../remote-actions.js');
const { openOnThisPc } = require('./open-on-this-pc.js');
const { issuePcAction } = require('./pc-actions.js');

/** @type {Record<string, (context: any, engine?: any) => Promise<any>>} */
const branches = {
  'lock_pc': async () => {
      let fnResult;
      await lockWorkstation();
      fnResult = { ok: true };
      return fnResult;
  },

  'open_application': async ({ fnArgs, phoneRefusal, remote }, { hub, readDeckStore }) => {
      let fnResult;
      const rawTarget = String(fnArgs.target || '').trim();
      if (!rawTarget) { fnResult = { error: 'target mancante' }; }
      else {
        // Some apps are more reliably opened via their registered URI protocol
        // than via App Paths name lookup (e.g. Steam doesn't always resolve by
        // name). Use canonical deep links that actually open a window — a bare
        // "steam://" invokes the handler but opens nothing visible.
        const PROTOCOL_MAP = {
          'steam': 'steam://open/main', 'steam client': 'steam://open/main',
          'discord': 'discord://',
          'whatsapp': 'whatsapp://',
          'slack': 'slack://',
          'zoom': 'zoommtg://',
          'epic': 'com.epicgames.launcher://apps',
          'epic games': 'com.epicgames.launcher://apps',
        };
        // An app by name, a website, or a file that does not run code when it
        // opens; never a network path, a special link or a script (ai-pc-apps.js).
        const allowed = aiPcApps.openTarget(rawTarget, PROTOCOL_MAP);
        // From a paired phone, what /windows/launch allows and nothing else: a
        // file sent from the phone could otherwise be started right after it lands.
        if (remote && !remoteActions.remoteMayLaunch(rawTarget, hub.settings && hub.settings.appFavorites, await readDeckStore())) {
          fnResult = phoneRefusal('needs_pc');
        } else if (!allowed.ok) {
          fnResult = { error: `not allowed (${allowed.error}): this tool opens apps by name, websites and documents on this PC. Scripts, network paths and special links are refused; running commands needs PC Control, which asks the user first.` };
        } else {
        const opened = await openOnThisPc(allowed);
        if (opened.ok) fnResult = { ok: true, opened: rawTarget };
        else if (opened.error === 'not_on_this_system') fnResult = { error: `"${rawTarget}" is a Windows path and cannot be opened on this system` };
        else fnResult = { error: `"${rawTarget}" was not found or is not installed` };
        }
      }
      return fnResult;
  },

  'run_pc_command': async ({ fnArgs, clientActions }, { _pcControlEnabled }) => {
      let fnResult;
      // Consent-gated generic PC control. NEVER executes here — proposes a
      // command that runs only after the user approves the confirmation card.
      if (!_pcControlEnabled()) {
        fnResult = { error: 'pc_control_disabled', message: 'PC command control is off. Tell the user to enable "PC control" in Settings → Bit → Advanced AI features first.' };
      } else {
        const command = String(fnArgs.command || '').trim().slice(0, 2000);
        const purpose = String(fnArgs.description || fnArgs.purpose || '').trim().slice(0, 300);
        if (!command) { fnResult = { error: 'no_command' }; }
        else {
          const nonce = issuePcAction(command, purpose);
          clientActions.push({ action: 'confirm_pc_command', args: { nonce, command, description: purpose } });
          fnResult = { status: 'pending_confirmation', message: 'The command has NOT run yet: a confirmation card is shown to the user and it will run only if they approve. Do NOT claim it executed; tell the user to confirm on the card.' };
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
