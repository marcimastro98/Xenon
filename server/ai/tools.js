// What the assistant does when asked to close an app: one program by its exact name, never
// Windows' own or Xenon (ai-pc-apps.js decides).

const aiPcApps = require('../ai-pc-apps.js');
const { psEscape } = require('../ps-quote.js');
const { execFile } = require('node:child_process');

/** @type {Record<string, (context: any) => Promise<any>>} */
const branches = {
  'close_application': async ({ fnArgs }) => {
      let fnResult;
      const rawTarget = String(fnArgs.target || '').trim();
      if (!rawTarget) { fnResult = { error: 'target mancante' }; }
      else {
        // Map friendly names → common process names (without .exe)
        const CLOSE_MAP = {
          'spotify': 'spotify', 'chrome': 'chrome', 'google chrome': 'chrome',
          'firefox': 'firefox', 'edge': 'msedge', 'microsoft edge': 'msedge',
          'notepad': 'notepad', 'vlc': 'vlc', 'discord': 'discord',
          'steam': 'steam', 'obs': 'obs64', 'obs studio': 'obs64',
          'word': 'winword', 'excel': 'excel', 'powerpoint': 'powerpnt',
          'teams': 'teams', 'zoom': 'zoom', 'slack': 'slack',
          'whatsapp': 'whatsapp',
        };
        // One process by its exact name: no wildcards (a target of "*" used to
        // close everything), never Windows' own processes or Xenon (ai-pc-apps.js).
        const allowed = aiPcApps.closeTarget(rawTarget, CLOSE_MAP);
        const procName = allowed.ok ? allowed.name : '';
        const psEsc = psEscape(procName);
        const ps = `$p=Get-Process -Name '${psEsc}' -EA SilentlyContinue; if($p){$p|Stop-Process -Force;exit 0}else{exit 1}`;
        if (!allowed.ok) {
          fnResult = { error: `not allowed (${allowed.error}): name one app by its process name, e.g. "spotify". System processes and Xenon cannot be closed this way.` };
        } else {
          try {
            await new Promise((resolve, reject) =>
              execFile('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', ps],
                { windowsHide: true, timeout: 10000 },
                (err) => {
                  if (!err) resolve();
                  else if (err.code === 1) reject(new Error(`"${rawTarget}" not found or already closed`));
                  else reject(err);
                }
              )
            );
            fnResult = { ok: true, closed: rawTarget };
          } catch (closeErr) {
            fnResult = { error: closeErr.message };
          }
        }
      }
      return fnResult;
  },
};

module.exports = { branches };
