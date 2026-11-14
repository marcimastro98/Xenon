'use strict';
// Turns a tool call of Codex into what the tile shows: a one-line summary, the files a patch
// touches, and how loudly it must be asked about.

const path = require('node:path');
const { describeRisk, isDestructive } = require('../claude-bridge.js');

const MAX_STR = 220;
const MAX_DETAIL = 800;
const MAX_FILES = 12;

function str(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]+/g, ' ').trim();
  if (!s) return '';
  const cap = max || MAX_STR;
  return s.length > cap ? s.slice(0, cap - 1) + '…' : s;
}
function firstLine(v, max) {
  return str(String(v || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '', max);
}

// ── what a request is about ──────────────────────────────────────────────────
// apply_patch arrives as the patch text itself. Its file headers are the part
// a person needs to decide: which files, and whether any is deleted.
function parsePatch(text) {
  const files = [];
  let added = 0, removed = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
    if (m) { if (files.length < MAX_FILES) files.push({ verb: m[1].toLowerCase(), path: m[2].trim() }); continue; }
    const mv = /^\*\*\* Move to: (.+)$/.exec(line);
    if (mv && files.length) { files[files.length - 1].verb = 'move'; files[files.length - 1].to = mv[1].trim(); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) removed++;
  }
  return { files, added, removed };
}
function shown(p, cwd) {
  if (!p) return '';
  const abs = path.isAbsolute(p) || !cwd ? p : path.resolve(cwd, p);
  if (cwd) {
    const rel = path.relative(cwd, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return str(rel, 200);
  }
  return str(abs, 200);
}

function allArgs(i) {
  const lines = [];
  for (const k of Object.keys(i)) {
    const v = i[k];
    if (v == null || v === '') continue;
    lines.push(k + ': ' + (typeof v === 'string' ? v.trim() : JSON.stringify(v)));
  }
  return lines.join('\n');
}

// Would the card show everything that is being approved? When it would cut
// the text (an 800 character `echo` followed by `; curl … | sh`), the
// decision goes back to Codex's own prompt, which shows it all.
function fitsOnCard(tool, input) {
  const t = String(tool || '');
  const i = input && typeof input === 'object' ? input : {};
  const len = (v) => (typeof v === 'string' ? v.trim().length : 0);
  if (t === 'Bash') return len(i.command) <= MAX_DETAIL;
  if (t === 'apply_patch') return true;                 // drawn as its files and line counts
  if (t === 'write_stdin') return len(i.chars) <= 200;
  if (/^mcp__/.test(t)) return allArgs(i).length <= 300;
  if (t === 'request_permissions' || t === 'spawn_agent') return true;  // a reason or a task, nothing that runs
  let raw = '';
  try { raw = JSON.stringify(i); } catch { return false; }
  return raw.length <= 300;
}

// { kind, text, note, files?, added?, removed?, server?, name? }
function describeCodexTool(tool, input, cwd) {
  const t = str(tool, 80);
  const i = input && typeof input === 'object' ? input : {};
  if (t === 'Bash') return { kind: 'command', text: str(i.command, MAX_DETAIL), note: str(i.description, 160) };
  if (t === 'apply_patch') {
    const p = parsePatch(i.command);
    return {
      kind: 'patch', text: '', note: '',
      files: p.files.map((f) => Object.assign({ verb: f.verb, path: shown(f.path, cwd) }, f.to ? { to: shown(f.to, cwd) } : {})),
      added: p.added, removed: p.removed,
    };
  }
  if (t === 'write_stdin') return { kind: 'stdin', text: str(i.chars, 200), note: '' };
  if (t === 'request_permissions') return { kind: 'permissions', text: str(i.reason, 300), note: '' };
  if (t === 'spawn_agent') return { kind: 'agent', text: str(i.message || i.prompt || i.task, 300), note: '' };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(t);
  if (mcp) {
    // Every argument, not the first string: its order is the model's, and a
    // harmless first field could sit in front of the one that matters.
    return { kind: 'mcp', server: str(mcp[1], 60), name: str(mcp[2], 80), text: str(allArgs(i), 300), note: '' };
  }
  let raw = '';
  try { raw = JSON.stringify(i); } catch { raw = ''; }
  return { kind: 'other', text: str(raw === '{}' ? '' : raw, 300), note: '' };
}

// The risk line describes; it never decides (same rule as the Claude card).
// Codes: the Claude vocabulary plus `widen` (the request asks for more
// sandbox access than the session has).
function codexRisks(tool, input, cwd) {
  const t = str(tool, 80);
  const i = input && typeof input === 'object' ? input : {};
  const out = new Set();
  if (t === 'Bash') {
    for (const r of describeRisk('Bash', String(i.command || ''), cwd)) out.add(r);
    if (/^network-access\b/i.test(String(i.description || ''))) { out.add('network'); out.delete('readonly'); }
  } else if (t === 'apply_patch') {
    const p = parsePatch(i.command);
    for (const f of p.files) {
      if (f.verb === 'delete') out.add('irreversible');
      for (const target of [f.path, f.to]) {
        if (!target) continue;
        const abs = path.isAbsolute(target) || !cwd ? target : path.resolve(cwd, target);
        for (const r of describeRisk('Edit', abs, cwd)) out.add(r);
      }
    }
  } else if (t === 'request_permissions') {
    out.add('widen');
  }
  return Array.from(out);
}
function irreversible(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (tool === 'Bash') return isDestructive('Bash', String(i.command || ''));
  if (tool === 'apply_patch') return parsePatch(i.command).files.some((f) => f.verb === 'delete');
  return false;
}

module.exports = {
  MAX_STR, MAX_DETAIL, MAX_FILES, str, firstLine, parsePatch, shown, allArgs, fitsOnCard,
  describeCodexTool, codexRisks, irreversible,
};
