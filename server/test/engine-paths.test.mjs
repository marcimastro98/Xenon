// The engine finds its scripts, its data folder and its companion programs from
// the folder it sits in. These lines live in small modules one folder below
// server/ now: each has to point at the same place as when it was a line of
// server.js. The user's data stays in server/data, which is never served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

// module -> name -> place, written from the repo root; `true` marks a file that ships in the repo.
const PLACES = {
  'engine/paths.js': {
    DATA_DIR: ['server/data'],
    HELPER_EXE: [`server/helper/${exe('xenon-helper')}`],
    MCP_BRIDGE_PATH: ['packages/mcp/bin/xenon-mcp.js', true],
  },
  'system/script-paths.js': {
    CPU_TEMP_SCRIPT: ['server/cpu-temp.ps1', true],
    ENABLE_SENSORS_SCRIPT: ['server/enable-sensors.ps1', true],
    GPU_SCRIPT: ['server/gpu.ps1', true],
    NETWORK_SCRIPT: ['server/network.ps1', true],
    DISK_IO_SCRIPT: ['server/disk-io.ps1', true],
    SENSORS_SCRIPT: ['server/sensors.ps1', true],
    IDLE_SCRIPT: ['server/idle.ps1', true],
    PWSH_WORKER_SCRIPT: ['server/pwsh-worker.ps1', true],
  },
  'performance/script-paths.js': {
    PERFORMANCE_SCRIPT: ['server/performance.ps1', true],
    PROCESSES_SCRIPT: ['server/processes.ps1', true],
    PERF_PRIORITY_SCRIPT: ['server/perf-priority.ps1', true],
  },
  'deck/script-paths.js': {
    DECK_ACTIONS_SCRIPT: ['server/deck-actions.ps1', true],
    DECK_HOTKEY_SCRIPT: ['server/deck-hotkey.ps1', true],
    DECK_WINDOW_SCRIPT: ['server/deck-window.ps1', true],
    DECK_POPUP_TOP_SCRIPT: ['server/deck-popup-top.ps1', true],
  },
  'media/script-paths.js': {
    MEDIA_SCRIPT: ['server/media.ps1', true],
    MEDIA_KEY_SCRIPT: ['server/media-key.ps1', true],
    MEDIAREMOTE_DIR: ['server/mediaremote'],
  },
  'audio/svv-path.js': { SVV: ['server/soundvolumeview-x64/SoundVolumeView.exe', true] },
  'windows-tiles/script-paths.js': { WINDOWS_SCRIPT: ['server/windows.ps1', true] },
  'lights/script-paths.js': { ICUE_SHARPEN_SCRIPT: ['server/icue-sharpen.ps1', true] },
  'vitals/script-paths.js': { VITALS_NAG_SCRIPT: ['server/vitals-nag.ps1', true] },
  'screens/capture-exe.js': { CAPTURE_EXE: [`server/capture/${exe('xenon-capture')}`] },
  'install/launcher-paths.js': { OPEN_DASHBOARD_VBS: ['server/open-dashboard.vbs', true] },
  'updates/whats-new-file.js': { WHATSNEW_FILE: ['server/whatsnew.json', true] },
};

test('every place the engine looks for next to itself is where it was', () => {
  for (const [file, places] of Object.entries(PLACES)) {
    const made = require(path.join(REPO, 'server', file));
    assert.deepEqual(Object.keys(made).sort(), Object.keys(places).sort(), `${file} gives these names and no other`);
    for (const [name, [place, ships]] of Object.entries(places)) {
      assert.equal(made[name], path.join(REPO, ...place.split('/')), `${name} from ${file}`);
      if (ships) assert.ok(existsSync(made[name]), `${place} is in the repo`);
    }
  }
});

test("the user's data stays in server/data, straight under the engine's folder", () => {
  const { DATA_DIR } = require(path.join(REPO, 'server', 'engine', 'paths.js'));
  assert.equal(path.relative(path.join(REPO, 'server'), DATA_DIR), 'data');
});
