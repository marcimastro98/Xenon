// The parts of the shape check (ui-shape-check.mjs) that read no page: what a plan must
// say, how a request is written down, and where two recordings first differ.

const STEPS = {
  click: ['on'], clickEach: ['on'], fill: ['on', 'text'], keys: ['text'], press: ['key'], choose: ['on', 'value'], chooseEach: ['on'], wait: ['ms'], run: ['code'],
};
const DEPTH = 6;

/**
 * @param {any} plan `{ name, page, width, height, roots: [css], steps: [{ say, do, … }], skip?: [css], background?: [regex], replace?: [[regex, text]], quietMs?, settleMs?, seed?: {settings}, answers?: { [path]: { json } | { over } } }`
 * @returns {string[]} every reason the plan cannot be walked; none when it can
 */
export function planProblems(plan) {
  const problems = [];
  if (!plan || typeof plan !== 'object') return ['a plan is an object'];
  if (!/^[a-z][a-z0-9-]*$/.test(String(plan.name ?? ''))) problems.push('`name` is a short name in small letters, digits and dashes');
  if (!/^\/(?!\/)/.test(String(plan.page ?? ''))) problems.push('`page` is a path of the copy, from its first slash: the check opens nothing else');
  for (const side of ['width', 'height']) if (!(Number.isInteger(plan[side]) && plan[side] >= 200 && plan[side] <= 8000)) problems.push(`\`${side}\` is the window's ${side} in pixels`);
  if (!Array.isArray(plan.roots) || !plan.roots.length || plan.roots.some((root) => typeof root !== 'string' || !root.trim())) problems.push('`roots` names at least one element, each by a selector');
  if (!Array.isArray(plan.steps) || !plan.steps.length) problems.push('`steps` lists what the check does, in order');
  (Array.isArray(plan.steps) ? plan.steps : []).forEach((step, index) => {
    const where = `step ${index + 1}`;
    if (!step || typeof step.say !== 'string' || !step.say.trim()) { problems.push(`${where} says what it does, in \`say\``); return; }
    const needs = STEPS[step.do];
    if (!needs) { problems.push(`${where} (${step.say}): \`do\` is one of ${Object.keys(STEPS).join(', ')}`); return; }
    for (const key of needs) if (step[key] === undefined || step[key] === '') problems.push(`${where} (${step.say}): a ${step.do} needs \`${key}\``);
    if (step.roots !== undefined && !(Array.isArray(step.roots) && step.roots.length && step.roots.every((root) => typeof root === 'string' && root.trim()))) problems.push(`${where} (${step.say}): \`roots\` names the elements this step is read under, in place of the plan's`);
  });
  for (const key of ['skip', 'background']) if (plan[key] !== undefined && !(Array.isArray(plan[key]) && plan[key].every((entry) => typeof entry === 'string'))) problems.push(`\`${key}\` is a list of texts`);
  for (const pattern of [...(Array.isArray(plan.background) ? plan.background : []), ...(Array.isArray(plan.replace) ? plan.replace.map((pair) => pair?.[0]) : [])]) {
    try { new RegExp(pattern); } catch { problems.push(`"${pattern}" is not a pattern`); }
  }
  if (plan.seed !== undefined && !(plan.seed && typeof plan.seed === 'object' && !Array.isArray(plan.seed))) problems.push('`seed` is the settings the copy starts with, as an object');
  if (plan.answers !== undefined && !(plan.answers && typeof plan.answers === 'object' && !Array.isArray(plan.answers))) problems.push('`answers` gives, for a path of the copy, what the copy is made to say');
  for (const [asked, answer] of Object.entries(plan.answers && typeof plan.answers === 'object' ? plan.answers : {})) {
    if (!/^\/(?!\/)[^?#]*$/.test(asked)) problems.push(`an answer is for a path of the copy, from its first slash and without what is asked after it: "${asked}"`);
    if (!answer || typeof answer !== 'object' || ('json' in answer) === ('over' in answer)) problems.push(`the answer for ${asked} is { "json": … } (all of it, invented) or { "over": {…} } (laid over what the copy says)`);
    else if ('over' in answer && !(answer.over && typeof answer.over === 'object' && !Array.isArray(answer.over))) problems.push(`the \`over\` of ${asked} is an object`);
  }
  if (plan.replace !== undefined && !(Array.isArray(plan.replace) && plan.replace.every((pair) => Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string')))) problems.push('`replace` is a list of [pattern, text] pairs');
  return problems;
}

/**
 * The form of a value without what it holds: the keys of an object, what a list is made of, the kind of anything else.
 * @param {unknown} value @param {number} [depth] @returns {unknown}
 */
export function shapeOfValue(value, depth = 0) {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (depth >= DEPTH) return ['…'];
    return [...new Set(value.map((entry) => JSON.stringify(shapeOfValue(entry, depth + 1))))].sort().map((text) => JSON.parse(text));
  }
  if (typeof value === 'object') {
    if (depth >= DEPTH) return '{…}';
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shapeOfValue(value[key], depth + 1)]));
  }
  return typeof value;
}

/**
 * @param {string | null | undefined} body what a request sends @param {string} [type] its content type
 * @returns {string} the form of the body, never what it says
 */
export function bodyShape(body, type = '') {
  if (body === null || body === undefined || body === '') return '';
  if (/multipart\/form-data/i.test(type)) return 'form';
  try { return JSON.stringify(shapeOfValue(JSON.parse(body))); } catch { /* not JSON: its kind is all that is kept */ }
  return /x-www-form-urlencoded/i.test(type) ? `fields(${[...new URLSearchParams(body).keys()].sort().join(',')})` : 'text';
}

/**
 * @param {{ method: string, url: string, body?: string | null, type?: string }} request
 * @returns {string} the method, the path with the names of what it asks, and the form of the body
 */
export function requestLine({ method, url, body = null, type = '' }) {
  const address = new URL(url);
  const asked = [...new Set(address.searchParams.keys())].sort();
  return `${method} ${address.pathname}${asked.length ? `?${asked.join('&')}` : ''}${bodyShape(body, type) ? ` ${bodyShape(body, type)}` : ''}`;
}

/**
 * @param {unknown} under what the copy said @param {unknown} over what the plan lays on it
 * @returns {unknown} `under` with every key of `over` in its place; an object is laid key by key, anything else takes the place whole
 */
export function laidOver(under, over) {
  const plainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (!plainObject(under) || !plainObject(over)) return over;
  const out = { ...under };
  for (const [key, value] of Object.entries(over)) out[key] = laidOver(under[key], value);
  return out;
}

/** @param {any} plan @returns {(line: string) => string} a line with every `replace` of the plan applied */
export function replacerOf(plan) {
  const pairs = (plan.replace ?? []).map(([pattern, text]) => [new RegExp(pattern, 'g'), text]);
  return (line) => pairs.reduce((text, [pattern, by]) => text.replace(pattern, by), line);
}

const PARTS = ['shape', 'focus', 'requests', 'errors'];

/**
 * @param {any} before a recording @param {any} after another one of the same plan and engine
 * @returns {string | null} the first difference, as one or two lines a person can act on; null when they are the same
 */
export function firstDifference(before, after) {
  if (before.plan !== after.plan) return `the recordings are of two plans: ${before.plan} and ${after.plan}`;
  if (before.engine !== after.engine) return `the recordings are of two engines: ${before.engine} and ${after.engine}. Compare within one engine`;
  for (let index = 0; index < Math.max(before.steps.length, after.steps.length); index += 1) {
    const [was, now] = [before.steps[index], after.steps[index]];
    const where = `step ${index + 1} (${(was ?? now).say})`;
    if (!was || !now) return `${where}: ${was ? 'missing now' : 'new'}`;
    if (was.say !== now.say) return `step ${index + 1}: was "${was.say}", is "${now.say}"`;
    for (const part of PARTS) {
      const [a, b] = [was[part], now[part]].map((value) => (Array.isArray(value) ? value : [String(value)]));
      const at = a.findIndex((line, row) => line !== b[row]);
      const row = at >= 0 ? at : a.length < b.length ? a.length : -1;
      if (row < 0) continue;
      return `${where}: ${part}${a.length > 1 || b.length > 1 ? `, line ${row + 1}` : ''}\n  was: ${a[row] ?? '(nothing)'}\n  is:  ${b[row] ?? '(nothing)'}`;
    }
  }
  return null;
}
