// The config the release passes to `tauri build --config`, so the package
// carries the engine. Tauri merges it as a JSON merge patch, which REPLACES
// the platform's `bundle.resources`: the bootstrap that file already lists is
// repeated here, or the build would drop it.
import { writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const BOOTSTRAP = {
  win32: 'windows/xenon-bootstrap.ps1',
  darwin: 'posix/xenon-bootstrap.sh',
  linux: 'posix/xenon-bootstrap.sh',
};

/** The overlay for `platform`, with the engine folder `engineDirName` (a sibling of the config). */
export function tauriOverlay(platform, engineDirName = 'engine') {
  const bootstrap = BOOTSTRAP[platform];
  if (!bootstrap) throw new Error(`no package for ${platform}`);
  return {
    $schema: 'https://schema.tauri.app/config/2',
    bundle: {
      resources: {
        [bootstrap]: bootstrap,
        // The shell resolves `engine/` from its resources (engine_install/mod.rs).
        [`${engineDirName}/`]: 'engine/',
      },
    },
  };
}

/** Writes `tauri.engine.conf.json` next to the engine folder; returns its path. */
export function writeTauriOverlay(engineDir, platform) {
  const path = join(dirname(engineDir), 'tauri.engine.conf.json');
  writeFileSync(path, JSON.stringify(tauriOverlay(platform, basename(engineDir)), null, 2) + '\n');
  return path;
}
