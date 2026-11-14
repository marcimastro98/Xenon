'use strict';
// Says how loudly a tool call of Claude Code must be asked about: destructive commands,
// publishing, the network, files outside the project, and prompts Claude Code wrote itself.

const path = require('node:path');
const { str } = require('./bridge-clamp.js');

const DESTRUCTIVE_TOOLS = new Set(['Bash', 'Write', 'Edit', 'NotebookEdit', 'KillShell']);
const DESTRUCTIVE_RE = /\b(rm\s+-[rf]|rmdir|del\s+\/|format\s|mkfs|dd\s+if=|git\s+(reset\s+--hard|clean\s+-[a-z]*f|push\s+.*--force)|drop\s+(table|database)|truncate\s+table|shutdown|Remove-Item)/i;

// Is this "user" text actually the harness talking? Claude Code delivers task
// notifications, system reminders, skill preambles and command output through
// the same user-turn channel a person types into, so both the live bridge and
// the transcript reader have to tell them apart. ONE definition, used by both
// (claude-usage.js requires it) — two copies would drift and the drift shows up
// as internal plumbing rendered on the user's dashboard.
const INJECTED_RE = /^(Base directory for this skill\b|Caveat:|The user (opened|selected)|This session is)/;
function isInjectedPrompt(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  // Anything opening as a tag or a bracketed marker: <task-notification>,
  // <system-reminder>, <command-name>, [Request interrupted…].
  if (s.charAt(0) === '<' || s.charAt(0) === '[') return true;
  return INJECTED_RE.test(s);
}

function isDestructive(toolName, detail) {
  if (!DESTRUCTIVE_TOOLS.has(str(toolName, 60))) return false;
  return DESTRUCTIVE_RE.test(String(detail || ''));
}

// What a pending request would reach, in the few words the card can show next
// to the command. With auto mode on (the default since August 2026) routine
// calls never reach a person, so the ones that do are the unusual ones, and the
// raw command alone does not say what makes them unusual. Every code here is
// derived from the tool and its argument only, and errs toward saying MORE:
//   irreversible  deletes, force-pushes, resets, drops (the same test that
//                 escalates the card to full screen)
//   publish       sends work somewhere others see it (git push, npm publish…)
//   network       reaches another machine
//   outside       a file path that is not inside the session's folder
//   readonly      reads only (Read, Glob, Grep): said, so calm is visible too
const PUBLISH_RE = /\b(git\s+push|npm\s+publish|pnpm\s+publish|yarn\s+publish|gh\s+(release|pr\s+(create|merge))|docker\s+push|cargo\s+publish|twine\s+upload)\b/i;
const NETWORK_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ssh|scp|rsync|ftp|sftp|nc|telnet)\b|https?:\/\//i;
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit']);
function isInside(file, cwd) {
  if (!file || !cwd) return true;                     // nothing to compare: say nothing
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, '');
  const win = process.platform === 'win32';
  const f = win ? norm(file).toLowerCase() : norm(file);
  const c = win ? norm(cwd).toLowerCase() : norm(cwd);
  return f === c || f.startsWith(c + path.sep);
}
function describeRisk(toolName, detail, cwd) {
  const tool = str(toolName, 60);
  const d = String(detail || '');
  const out = [];
  if (isDestructive(tool, d)) out.push('irreversible');
  if (tool === 'Bash' && PUBLISH_RE.test(d)) out.push('publish');
  if (tool === 'WebFetch' || tool === 'WebSearch' || (tool === 'Bash' && NETWORK_RE.test(d) && out.indexOf('publish') === -1)) out.push('network');
  if (FILE_TOOLS.has(tool) && path.isAbsolute(d) && !isInside(d, cwd)) out.push('outside');
  if (!out.length && (tool === 'Read' || tool === 'Glob' || tool === 'Grep')) out.push('readonly');
  return out;
}

module.exports = {
  DESTRUCTIVE_TOOLS, DESTRUCTIVE_RE, INJECTED_RE, isInjectedPrompt, isDestructive, PUBLISH_RE,
  NETWORK_RE, FILE_TOOLS, isInside, describeRisk,
};
