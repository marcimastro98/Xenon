// What the engine answers about game mode and the performance screen.

const fpsMonitor = require('../fps-monitor.js');
const gameDetect = require('../gamedetect.js');
const perfScreen = require('../perf-screen.js');
const { readBody } = require('../http/read-body.js');
const { broadcastSSE } = require('../http/sse-clients.js');
const { widgetSnapshot: widgetGameSessions } = require('../game-sessions.js');
const { gameSessionsEnabled } = require('./game-sessions-switch.js');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { PRESENTMON_URL, PRESENTMON_SHA256 } = require('./presentmon-download.js');

const SERVER_DIR = path.join(__dirname, '..');

/** @type {Record<string, (req: any, res: any, context: any, engine?: any) => Promise<void>>} */
const branches = {
  'GET /api/gamemode/status': async (_req, _res, { json, err500 }) => {
    // Game mode runs off foreground full-screen detection (no PresentMon needed).
    // PresentMon is reported only so Settings can offer the optional FPS-readout
    // install button. The foreground field is a live diagnostic for false positives.
    //
    // fpsBackend names WHICH reader is behind that flag, because the two are not
    // interchangeable: PresentMon is a download Xenon can perform, MangoHud is a
    // package the user installs and then has to launch the game with. Settings
    // has to offer a button for one and an explanation for the other, and it
    // cannot tell them apart from an availability boolean alone.
    try {
      json({
        presentMonAvailable: fpsMonitor.isAvailable(),
        fpsBackend: fpsMonitor.backend || null,
        fpsAvailable: fpsMonitor.isAvailable(),
        gaming: gameDetect.isGaming(),
        gameRunning: gameDetect.isGameRunning(),
        gameProcess: gameDetect.getGameProcess(),
        activity: gameDetect.getActivity(),
        foreground: gameDetect.getGamingWindow(),
        diag: (typeof gameDetect.getGameDiag === 'function') ? gameDetect.getGameDiag() : null,
        fps: fpsMonitor.getGamingProcess(),
      });
    } catch (e) { err500(e.message); }
  },

  'POST /api/performance/screen': async (req, res, { json }) => {
    // "Widgets only": the hidden driver page runs Performance Mode and the
    // on-screen alerts window shows it; they talk through here (perf-screen.js).
    // This PC only (remote-access.js), and CSRF-guarded.
    let ev = null;
    try { ev = perfScreen.screenEvent(JSON.parse(await readBody(req) || '{}')); } catch (e) { ev = null; }
    if (!ev) { res.writeHead(400); res.end('Invalid event'); return; }
    broadcastSSE('perf_screen', ev);
    json({ ok: true });
  },

  'GET /perf': async (_req, _res, { json }, { _perfStream }) => {
    // Read-only seed for the Game performance tile (SSE 'perf' pushes the rest).
    json(_perfStream.snapshot());
  },

  'GET /perf/sessions': async (_req, _res, { json, urlObj }, { _gameSessions }) => {
    // Read-only: the games played and how they ran, for an SDK widget granted
    // `gameSessions` (js/custom-widget.js loader). Names and numbers, no paths.
    const limit = Number(urlObj.searchParams.get('limit')) || 20;
    json(widgetGameSessions(_gameSessions, { enabled: gameSessionsEnabled(), limit }));
  },

  'POST /api/gamemode/install-presentmon': async (_req, _res, { json, err500 }) => {
    // One-click download of the classic single-binary PresentMon CLI (the same
    // pinned v1.10.0 asset install.ps1 fetches), placed in server/presentmon/.
    // The server runs this exe elevated for an ETW session, so the bytes are held
    // to a pinned SHA-256 before they take the name fpsmon.js launches: the file
    // lands as .download, is hashed, and only a match is moved into place.
    try {
      // PresentMon is a Windows ETW tool: there is no build to fetch anywhere
      // else, and the download itself is written in PowerShell. Refusing by name
      // beats letting the client discover it through a spawn failure.
      if (process.platform !== 'win32') { json({ ok: false, error: 'unsupported_platform' }); }
      else if (fpsMonitor.isAvailable()) { json({ ok: true, alreadyInstalled: true }); }
      else {
        const ps = [
          "$ErrorActionPreference='Stop';",
          "$dir=$env:PM_DIR; $exe=Join-Path $dir 'PresentMon.exe'; $part=\"$exe.download\";",
          "if(-not(Test-Path $dir)){New-Item -ItemType Directory -Path $dir -Force | Out-Null};",
          '[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;',
          "Invoke-WebRequest -Uri $env:PM_URL -OutFile $part -Headers @{'User-Agent'='XenonEdgeHub'} -TimeoutSec 120 -UseBasicParsing;",
          "if(-not(Test-Path $part)){throw 'download did not produce PresentMon.exe'};",
          "$got=(Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash;",
          "if($got -ne $env:PM_SHA){Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; throw \"checksum mismatch (expected $env:PM_SHA, got $got)\"};",
          "Move-Item -LiteralPath $part -Destination $exe -Force",
        ].join(' ');
        await new Promise((resolve, reject) =>
          execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
            { windowsHide: true, timeout: 180000, env: { ...process.env, PM_DIR: path.join(SERVER_DIR, 'presentmon'), PM_URL: PRESENTMON_URL, PM_SHA: PRESENTMON_SHA256 } },
            (psErr) => psErr ? reject(psErr) : resolve()
          )
        );
        try { fpsMonitor.reload(); } catch { /* monitor will retry on its own */ }
        json({ ok: true, installed: true });
      }
    } catch (e) {
      err500('PresentMon non installato: ' + (e && e.message ? e.message : 'download fallito'));
    }
  },
};

module.exports = { branches };
