// Pure helpers of the dev install (cli.mjs): where the installed engine lives,
// what to refuse, and how to read the applier's answer. No I/O here, so the
// rules are tested in server/test/dev-install.test.mjs.
import path from 'node:path';

export const TASK_NAME = 'Xenon Edge Widget';
const LAUNCHER = 'start-hidden.vbs';

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const decode = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (e) => XML_ENTITIES[e]);

/**
 * The install root the engine task starts, from its XML: the task runs
 * `wscript "<root>\server\start-hidden.vbs"`. '' when the task is not that.
 */
export function installRootFromTaskXml(xml) {
  const m = /<Exec>[\s\S]*?<Arguments>([^<]*)<\/Arguments>/.exec(String(xml || ''));
  if (!m) return '';
  const arg = decode(m[1]).trim().replace(/^"(.*)"$/, '$1');
  const win = path.win32;
  if (!win.isAbsolute(arg) || win.basename(arg).toLowerCase() !== LAUNCHER) return '';
  const serverDir = win.dirname(arg);
  if (win.basename(serverDir).toLowerCase() !== 'server') return '';
  return win.dirname(serverDir);
}

/** Why this root must not be written, or '' when it may. */
export function refuseRoot(root, repoRoot, exists) {
  if (!root) return 'no installed engine found (no "' + TASK_NAME + '" task pointing at start-hidden.vbs)';
  const win = path.win32;
  const norm = (p) => win.resolve(p).toLowerCase();
  if (norm(root) === norm(repoRoot)) return 'the task runs this checkout itself; nothing to install';
  if (exists(win.join(root, '.git'))) return 'the installed engine is a git checkout; update it with git instead';
  if (!exists(win.join(root, 'server', 'update-apply.ps1'))) return 'the install has no update-apply.ps1';
  if (!exists(win.join(root, 'server', 'data'))) return 'the install has no server\\data folder';
  return '';
}

/** staged.json as the server's prepare step leaves it: the applier reads `version`. */
export function stagedJson(version, ref, commit) {
  return JSON.stringify({ version, source: 'dev-install', ref, commit, at: new Date().toISOString() }, null, 2);
}

/**
 * The applier's outcome once it is newer than the one seen before the start:
 * { done: false } while waiting, else { done: true, ok, detail }.
 */
export function readOutcome(beforeText, nowText) {
  if (!nowText || nowText === beforeText) return { done: false };
  let r;
  try { r = JSON.parse(String(nowText).replace(/^﻿/, '')); } catch { return { done: false }; }
  if (!r || typeof r !== 'object') return { done: false };
  if (r.ok === true) return { done: true, ok: true, detail: (r.from || '?') + ' -> ' + (r.to || '?') };
  const why = [r.reason, r.detail].filter(Boolean).join(': ') || 'failed';
  const back = r.rolledBack === true ? ' (previous version restored)' : ' (rollback NOT confirmed)';
  return { done: true, ok: false, detail: why + back + ', see server\\data\\update\\update.log' };
}
