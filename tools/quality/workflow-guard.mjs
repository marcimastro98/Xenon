// What the GitHub workflows must keep true, read from their text.
//
// A workflow runs with a token and, in some jobs, with signing secrets, and nobody
// rereads all of them on every change. These rules are the ones that go wrong
// silently: an action taken by a tag someone else can move, a checkout that leaves
// its token on disk, a trigger that runs a fork's code with this repo's rights, a
// release trigger added back after it was removed for racing the publish.
//
// Read as text on purpose: no YAML parser to install, and the workflows are written
// in one plain style (two-space indent, one key per line) that the first test pins.
//
// Pure functions; server/test/workflow-guard.test.mjs runs them on the real files.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const WORKFLOW_DIR = '.github/workflows';

// The workflows written to the strict rules: least privilege, no secrets, a time
// limit on every job, nothing allowed to fail quietly.
export const STRICT = ['ci.yml', 'security.yml'];

// The two that may start from a published release, and why. A third one is the
// mistake CLAUDE.md names: building assets after the publish raced the publish.
export const RELEASE_TRIGGER_ALLOWED = {
  'discord-announce.yml': 'tells Discord about a release, builds nothing',
  'release.yml': 'the safety net for a release published without its staged assets',
};

const PINNED = /^(?:[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?)@[0-9a-f]{40}\s+#\s*\S+/;

/**
 * @param {string} root repo root
 * @returns {{ name: string, text: string }[]}
 */
export function listWorkflows(root) {
  const dir = path.join(root, WORKFLOW_DIR);
  return readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()
    .map((name) => ({ name, text: readFileSync(path.join(dir, name), 'utf8') }));
}

/**
 * The lines that are not blank and not only a comment, with their indent.
 * @param {string} text
 * @returns {{ n: number, indent: number, text: string }[]}
 */
export function codeLines(text) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    const body = line.trim();
    if (!body || body.startsWith('#')) return;
    out.push({ n: i + 1, indent: line.length - line.trimStart().length, text: body });
  });
  return out;
}

/** The lines under a top-level key, up to the next top-level key. */
function topBlock(lines, key) {
  const start = lines.findIndex((l) => l.indent === 0 && new RegExp(`^['"]?${key}['"]?:`).test(l.text));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.indent === 0);
  return { head: lines[start], body: end < 0 ? rest : rest.slice(0, end) };
}

/**
 * The events a workflow starts on.
 * @param {string} text
 * @returns {string[]}
 */
export function triggers(text) {
  const block = topBlock(codeLines(text), 'on');
  if (!block) return [];
  const inline = block.head.text.replace(/^['"]?on['"]?:/, '').replace(/#.*$/, '').trim();
  if (inline) return inline.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const first = block.body[0] ? block.body[0].indent : 0;
  return block.body.filter((l) => l.indent === first).map((l) => l.text.replace(/^-\s*/, '').split(':')[0].trim());
}

/**
 * @param {string} text
 * @returns {{ id: string, body: { n: number, indent: number, text: string }[] }[]}
 */
export function jobs(text) {
  const block = topBlock(codeLines(text), 'jobs');
  if (!block?.body.length) return [];
  const level = block.body[0].indent;
  const out = [];
  for (const line of block.body) {
    if (line.indent === level) out.push({ id: line.text.split(':')[0], body: [] });
    else if (out.length) out[out.length - 1].body.push(line);
  }
  return out;
}

/** Every `uses:` in a workflow, with the step lines that follow it. */
function usesSteps(text) {
  const lines = codeLines(text);
  const out = [];
  lines.forEach((line, i) => {
    const m = /^(-\s+)?uses:\s*(.+)$/.exec(line.text);
    if (!m) return;
    // The step's keys sit at the column of `uses`; its end is the next line left of that.
    const column = line.indent + (m[1] ? m[1].length : 0);
    const tail = [];
    for (const next of lines.slice(i + 1)) {
      if (next.indent < column) break;
      tail.push(next);
    }
    out.push({ n: line.n, ref: m[2].trim(), tail });
  });
  return out;
}

/**
 * The rules every workflow keeps.
 * @param {string} name file name
 * @param {string} text
 * @returns {string[]} one line per problem, [] when the workflow is fine
 */
export function workflowProblems(name, text) {
  const problems = [];
  const lines = codeLines(text);
  if (text.includes('\t')) problems.push(`${name}: a tab character (the checks read two-space indents)`);
  if (!topBlock(lines, 'permissions')) problems.push(`${name}: no top-level permissions, so the token gets the repo default`);

  for (const step of usesSteps(text)) {
    const local = step.ref.startsWith('./');
    if (!local && !PINNED.test(step.ref)) {
      problems.push(`${name}:${step.n}: "${step.ref}" is not pinned to a full commit with its version in a comment`);
    }
    if (/^actions\/checkout@/.test(step.ref) && !step.tail.some((l) => /^persist-credentials:\s*false\b/.test(l.text))) {
      problems.push(`${name}:${step.n}: checkout without persist-credentials: false leaves the token in .git/config`);
    }
  }

  const events = triggers(text);
  if (!events.length) problems.push(`${name}: no trigger found under "on:"`);
  if (lines.some((l) => l.text.includes('pull_request_target'))) {
    problems.push(`${name}: pull_request_target runs a fork's change with this repo's token and secrets`);
  }
  if (events.includes('release') && !RELEASE_TRIGGER_ALLOWED[name]) {
    problems.push(`${name}: starts on a release. Assets are built by release.yml before the publish, never after it`);
  }
  return problems;
}

/**
 * The extra rules of the workflows in STRICT.
 * @param {string} name
 * @param {string} text
 * @returns {string[]}
 */
export function strictProblems(name, text) {
  const problems = [];
  const lines = codeLines(text);
  const perms = topBlock(lines, 'permissions');
  const granted = perms ? perms.body.map((l) => l.text.replace(/\s*#.*$/, '')) : [];
  if (granted.join('|') !== 'contents: read') problems.push(`${name}: the default permissions must be exactly "contents: read"`);
  for (const l of lines) {
    const scope = /^([\w-]+):\s*write\b/.exec(l.text);
    if (scope && scope[1] !== 'security-events') problems.push(`${name}:${l.n}: write permission "${scope[1]}"`);
    if (/\bsecrets\s*\./.test(l.text) || /\bsecrets:\s*inherit\b/.test(l.text)) problems.push(`${name}:${l.n}: uses a secret`);
    if (/^(-\s+)?continue-on-error:/.test(l.text)) problems.push(`${name}:${l.n}: continue-on-error hides a failure`);
  }
  const concurrency = topBlock(lines, 'concurrency');
  if (!concurrency?.body.some((l) => /^cancel-in-progress:\s*true\b/.test(l.text))) {
    problems.push(`${name}: no concurrency group that cancels a superseded run`);
  }
  for (const job of jobs(text)) {
    const level = job.body.length ? job.body[0].indent : 0;
    if (!job.body.some((l) => l.indent === level && /^timeout-minutes:\s*\d+/.test(l.text))) {
      problems.push(`${name}: job "${job.id}" has no timeout-minutes`);
    }
  }
  return problems;
}

/**
 * The lowest Node major a package.json "engines" range accepts, and a test for any major.
 * @param {string} range such as ">=22.23.4 <23 || >=24.22.1 <25 || >=26.12.1"
 * @returns {{ lowest: number, accepts: (major: number) => boolean }}
 */
export function engineLines(range) {
  const spans = String(range).split('||').map((part) => {
    const from = />=\s*(\d+)/.exec(part);
    const to = /<\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(part);
    if (!from) throw new Error(`engines: cannot read "${part.trim()}"`);
    // "<23" shuts out all of 23; "<23.4.0" still lets some of 23 in.
    const open = to && (Number(to[2] || 0) > 0 || Number(to[3] || 0) > 0);
    return { from: Number(from[1]), below: to ? Number(to[1]) + (open ? 1 : 0) : Infinity };
  });
  return {
    lowest: Math.min(...spans.map((s) => s.from)),
    accepts: (major) => spans.some((s) => major >= s.from && major < s.below),
  };
}

/** The values of every `key: [a, b]` list in a workflow. */
function inlineLists(text, key) {
  return codeLines(text)
    .map((l) => new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`).exec(l.text))
    .filter(Boolean)
    .map((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * ci.yml is the only place macOS and Linux are ever run, so its shape is a rule.
 * @param {string} text ci.yml
 * @param {string} engines package.json "engines.node"
 * @returns {string[]}
 */
export function ciProblems(text, engines) {
  const problems = [];
  const events = triggers(text);
  for (const event of ['push', 'pull_request']) {
    if (!events.includes(event)) problems.push(`ci.yml: does not run on ${event}`);
  }
  const osLists = inlineLists(text, 'os');
  if (osLists.length < 2) problems.push('ci.yml: the tests and the native code each need an "os:" matrix');
  for (const list of osLists) {
    for (const os of ['windows-latest', 'macos-latest', 'ubuntu-latest']) {
      if (!list.includes(os)) problems.push(`ci.yml: an "os:" matrix leaves out ${os}`);
    }
  }
  const nodes = inlineLists(text, 'node').flat().map(Number);
  const lines = engineLines(engines);
  if (!nodes.length) problems.push('ci.yml: no "node:" matrix');
  for (const major of nodes) {
    if (!lines.accepts(major)) problems.push(`ci.yml: Node ${major} is outside "engines" (${engines})`);
  }
  if (nodes.length && Math.min(...nodes) !== lines.lowest) {
    problems.push(`ci.yml: the oldest Node "engines" accepts (${lines.lowest}) is not tested`);
  }
  for (const needed of ['npm ci', 'npm run quality:install', 'npm test', 'node tools/ci/boot-check.mjs', 'npm run doctor', 'npm run check:platform-apis']) {
    if (!codeLines(text).some((l) => l.text.includes(needed))) problems.push(`ci.yml: never runs "${needed}"`);
  }
  return problems;
}

const PATH_ARGS = [
  /\bnode\s+"?((?!-)[\w./-]+\.(?:mjs|cjs|js))/g,
  /--(?:manifest-path|package-path|file)\s+"?([\w./-]+)/g,
  /\bdotnet build\s+"?([\w./-]+)/g,
  /^((?:apps|tools|server|packages)\/[\w./-]+|[\w-]*package-lock\.json)$/g,
];

/**
 * Files, folders and npm scripts a workflow names that are not in the repo.
 * Only for workflows whose steps all run from the repo root.
 * @param {string} text
 * @param {string} root repo root
 * @param {Record<string, string>} scripts package.json "scripts"
 * @returns {string[]}
 */
export function missingTargets(text, root, scripts) {
  const missing = new Set();
  for (const line of codeLines(text)) {
    for (const pattern of PATH_ARGS) {
      for (const m of line.text.matchAll(pattern)) {
        if (!existsSync(path.join(root, m[1]))) missing.add(`${m[1]} (line ${line.n})`);
      }
    }
    for (const m of line.text.matchAll(/\bnpm run\s+([\w:-]+)/g)) {
      if (!scripts[m[1]]) missing.add(`npm script "${m[1]}" (line ${line.n})`);
    }
  }
  return [...missing];
}
