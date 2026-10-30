'use strict';

// The dry-run report of the AI preset builder (ai-presets.js): what the app's
// own import normalizers DROP or CHANGE in what the model wrote, plus the hard
// failures that stop a code from being built at all. Compact on purpose: it goes
// back to the model as a tool result, so it is capped and every value is cut.

const MAX_ENTRIES = 40;
const VALUE_MAX = 60;
const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

function createReport() {
  return { entries: [], more: 0, errors: [] };
}

function shortValue(value) {
  if (value === undefined) return undefined;
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  return text.length > VALUE_MAX ? text.slice(0, VALUE_MAX - 1) + '…' : text;
}

// One dropped/changed entry. `why` is a short, fixable reason when the check
// knows one; `now` is left out for a drop.
function note(report, entry) {
  if (report.entries.length >= MAX_ENTRIES) { report.more++; return; }
  const out = { path: entry.path, issue: entry.issue, was: shortValue(entry.was) };
  if (entry.issue === 'changed') out.now = shortValue(entry.now);
  if (entry.why) out.why = entry.why;
  report.entries.push(out);
}

// A hard failure: the code is not built while any is present.
function fail(report, path, error, hint) {
  const out = { path, error };
  if (hint) out.hint = hint;
  report.errors.push(out);
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => (Array.isArray(v) ? v.length === 0 : isObject(v) && Object.keys(v).length === 0);

function canonHex(v) {
  const m = typeof v === 'string' && v.trim().match(HEX_RE);
  if (!m) return null;
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? h.split('').map((c) => c + c).join('') : h);
}

// Equal for the purposes of the report: the same colour in another spelling, or
// the same number written as a string, is not a change the user would notice.
function sameValue(a, b) {
  if (a === b) return true;
  const ha = canonHex(a);
  if (ha && ha === canonHex(b)) return true;
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && Number(a) === b) return true;
  return false;
}

function samePrimitiveIn(list, value) {
  return list.some((item) => sameValue(value, item));
}

// Walk what the model wrote (`input`) against what the normalizer kept
// (`output`) and note every difference. Only the input's own fields are looked
// at: defaults the normalizer adds are not news. `why(path, was, now)` may name
// a reason for a given path.
function diffValue(input, output, path, report, why) {
  if (input === undefined || input === null) return;
  const reason = (now) => (why ? why(path, input, now) : '');
  if (output === undefined || output === null) {
    if (!isEmpty(input)) note(report, { path, issue: 'dropped', was: input, why: reason(output) });
    return;
  }
  if (Array.isArray(input)) {
    if (!Array.isArray(output)) { note(report, { path, issue: 'changed', was: input, now: output, why: reason(output) }); return; }
    const primitive = input.every((v) => v === null || typeof v !== 'object');
    input.forEach((item, i) => {
      if (!primitive) { diffValue(item, output[i], path + '[' + i + ']', report, why); return; }
      if (item !== null && !samePrimitiveIn(output, item)) {
        note(report, { path: path + '[' + i + ']', issue: 'dropped', was: item, why: why ? why(path + '[' + i + ']', item, undefined) : '' });
      }
    });
    return;
  }
  if (isObject(input)) {
    if (!isObject(output)) { note(report, { path, issue: 'changed', was: input, now: output, why: reason(output) }); return; }
    for (const key of Object.keys(input)) diffValue(input[key], output[key], path ? path + '.' + key : key, report, why);
    return;
  }
  if (!sameValue(input, output)) note(report, { path, issue: 'changed', was: input, now: output, why: reason(output) });
}

// The report as the model sees it: counts first, entries only when present.
function summarize(report) {
  const dropped = report.entries.filter((e) => e.issue === 'dropped').length;
  const changed = report.entries.length - dropped;
  const out = { dropped, changed };
  if (report.entries.length) out.entries = report.entries;
  if (report.more) out.more = report.more;
  if (report.errors.length) out.errors = report.errors;
  return out;
}

module.exports = { MAX_ENTRIES, createReport, note, fail, diffValue, summarize, isObject, canonHex };
