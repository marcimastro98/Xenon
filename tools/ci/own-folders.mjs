// A throwaway engine started by a check must not write where the installed app lives:
// its log (the app's own folder under the user's local data), the links it repairs in the
// user's home, its temp files. This gives it a home and a temp folder of its own.

import { mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Makes `<folder>/home` and `<folder>/temp` and returns the environment that sends an engine there.
 * @param {string} folder a folder the check owns and removes when it ends
 * @returns {Record<string, string>} variables to lay over `process.env`
 */
export function ownFolders(folder) {
  const home = path.join(folder, 'home');
  const temp = path.join(folder, 'temp');
  for (const made of [home, temp]) mkdirSync(made, { recursive: true });
  return { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: temp, TMP: temp, TMPDIR: temp };
}
