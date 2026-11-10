// Each sweep over a checkout: reads the files, hands them to the pure finders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listRepoFiles, readFolderTexts, readTextFiles } from './files.mjs';
import { findDeadCode } from './functions.mjs';
import { classifyKeys, committedKeys, definedKeys, I18N_FILE, loadTables, removeKeys, sha256, writeIfUnchanged } from './i18n.mjs';
import { classifyMedia, mediaUnder, namesInRevisions, releaseTags, SHIPPED_PATHS } from './media.mjs';
import { imageMetadata, isVendored, machineName, scanText } from './personal.mjs';

function readRepo(root) {
  const files = listRepoFiles(root);
  return { files, ...readTextFiles(root, files) };
}

// `tags`: also read every release tag (on by default, see media.mjs).
export function sweepMedia(root, { dirs = ['docs/images'], revs = [], tags = true, also = [] } = {}) {
  const { files, texts } = readRepo(root);
  const media = mediaUnder(files, dirs);
  const names = [...new Set(media.map((rel) => path.posix.basename(rel)))];
  const revNames = new Set([
    ...namesInRevisions(root, revs, names),
    ...(tags ? namesInRevisions(root, releaseTags(root), names, SHIPPED_PATHS) : []),
  ]);
  const extraTexts = new Map();
  for (const dir of also) for (const [rel, text] of readFolderTexts(path.resolve(root, dir))) extraTexts.set(`${dir}:${rel}`, text);
  return { scanned: media.length, ...classifyMedia({ media, texts, revNames, extraTexts }) };
}

export function sweepFunctions(root, { dirs = [] } = {}) {
  return findDeadCode(readRepo(root).texts, { dirs });
}

// `skip`: key prefixes left alone by --remove (an area another session is
// rewiring right now).
export function sweepI18n(root, { remove = false, skip = [] } = {}) {
  const { texts } = readRepo(root);
  const file = path.join(root, I18N_FILE);
  const raw = fs.readFileSync(file);
  const source = raw.toString('utf8');
  const result = classifyKeys({ keys: definedKeys(loadTables(source)), texts });
  if (!remove) return result;
  const committed = committedKeys(root);
  const unused = result.unused.map((u) => u.key);
  const skipped = (key) => skip.some((prefix) => key.startsWith(prefix));
  const removable = unused.filter((key) => committed.has(key) && !skipped(key));
  result.keptNew = unused.filter((key) => !committed.has(key));
  result.keptSkipped = unused.filter((key) => committed.has(key) && skipped(key));
  if (!removable.length) return { ...result, removed: [] };
  const { source: next } = removeKeys(source, removable);
  writeIfUnchanged(file, sha256(raw), next);
  return { ...result, removed: removable };
}

export function sweepPersonal(root, { words = [], user = os.userInfo().username, machine = machineName(os.hostname()) } = {}) {
  const { files, texts, skipped } = readRepo(root);
  const findings = [];
  for (const [rel, text] of texts) {
    if (isVendored(rel)) continue;
    for (const f of scanText(rel, text, { words, user, machine })) findings.push({ file: rel, ...f });
  }
  for (const rel of files) {
    if (!/\.(jpe?g|png|webp)$/i.test(rel)) continue;
    const meta = imageMetadata(rel, fs.readFileSync(path.join(root, rel)));
    if (meta) findings.push({ file: rel, line: 0, kind: 'image-metadata', value: meta });
  }
  for (const rel of skipped) findings.push({ file: rel, line: 0, kind: 'not-read', value: 'text file over 16 MB' });
  return findings;
}
