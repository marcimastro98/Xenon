// What the assistant does when asked to close an app: the Deck's closeApp action, nothing of its own.
// It closes the way the app's own X does (an app with unsaved work can still ask), on every system,
// and never Xenon or the system's own processes (actions/registry-app-window.js decides).

/** @type {Record<string, (context: any) => Promise<any>>} */
const branches = {
  'close_application': async ({ fnArgs, runAction }) => {
      let fnResult;
      const app = String(fnArgs.target || '').trim();
      if (!app) { fnResult = { error: 'target mancante' }; }
      else {
        const r = await runAction({ type: 'closeApp', app, mode: 'close' });
        fnResult = r?.ok ? { ok: true, closed: app } : { error: r?.error || 'close_failed' };
      }
      return fnResult;
  },
};

module.exports = { branches };
