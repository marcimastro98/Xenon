#!/usr/bin/env node
// Walks one surface of the app the way a plan says and writes down, after every step,
// the shape of what is on the page: so a function that builds a window can be cut into
// scripts and shown to build the same window as before.
//
//   node tools/restructure/ui-shape/ui-shape-check.mjs <plan.json> <folder> <port> --record <file> [--engine chromium|webkit] [--base <rev>]
//   node tools/restructure/ui-shape/ui-shape-check.mjs <plan.json> <folder> <port> --against <file> [--engine chromium|webkit] [--out <file>]
//
// It builds a throwaway copy of the engine in <folder> (tools/restructure/side-copy.mjs:
// own port, data, home and temp; `--base` takes `server/` as it was at a commit), writes
// the plan's `seed` as the settings it starts with, starts it, opens the plan's page in one hidden window and does the plan's steps: click, click
// each of a list, type invented text, press a key, choose from a list (one choice or each in turn), wait. After each step, once the page
// has been quiet, it records under the plan's roots every element with its tag, id,
// classes, attributes, texts, what its fields hold and how many listeners it was given;
// which element has the focus; every request the page sent since the step before (method,
// path, names asked, the form of the body: never what it says); and every error of the
// page. No picture is taken. A request that would leave the copy is refused before it is
// sent and written down. The plan's `answers` make the copy say an invented list for a path
// (`json`), or lay invented keys over what it says (`over`), so the branches that need a
// list are walked without a real service behind them. `--record` writes the recording; `--against` compares with one of
// the same engine and ends with 1 and the first difference. Port 3030 is refused.
//
// The plan is JSON (ui-shape-plan.mjs says what it must hold); the plans live in
// this folder. Playwright is not a dependency: it is borrowed like the page
// check does (the sibling xenon-maker checkout, or the folder XENON_PLAYWRIGHT names).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { REFUSED, engineFromArgs, startEngine } from '../browser-check-engine.mjs';
import { LOCALE, plainFor, serverOf, staysOnCopy } from '../browser-check-pages.mjs';
import { build, mustBeSideCopy, run, sidePort } from '../side-copy.mjs';
import { PAGE_NAME, initScript } from './ui-shape-page.mjs';
import { firstDifference, laidOver, planProblems, replacerOf, requestLine } from './ui-shape-plan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LOAD_MS = 60_000;
const STEP_MS = 10_000;
const QUIET_MS = 400;
const SETTLE_MAX_MS = 8000;
const RUN_MINUTES = 25;
// A connection the page keeps open is not a request that ends.
const STAYS_OPEN = new Set(['eventsource', 'websocket']);

function loadPlaywright() {
  const from = process.env.XENON_PLAYWRIGHT || path.resolve(REPO_ROOT, '..', 'xenon-maker', 'node_modules', 'playwright');
  return createRequire(import.meta.url)(from);
}

// Waits until the page has not changed for a while and every request it sent has ended.
async function settle(page, flying, quietMs) {
  const until = Date.now() + SETTLE_MAX_MS;
  // What a step set off may be drawn on the next frame: a page that last changed long ago is not quiet yet.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 50)))));
  for (;;) {
    const quiet = await page.evaluate((name) => window[name].quietFor(), PAGE_NAME);
    if ((quiet >= quietMs && flying.size === 0) || Date.now() > until) return;
    await page.waitForTimeout(Math.min(quietMs, 150));
  }
}

// A list of choices is set the way its own events tell the page, whether the page shows the
// list itself or draws its own over it (a drawn list is not opened: that is a click of the plan).
async function choose(target, value) {
  await target.waitFor({ state: 'attached', timeout: STEP_MS });
  await target.evaluate((select, wanted) => {
    if (![...select.options].some((option) => option.value === wanted)) throw new Error(`no choice "${wanted}" in this list`);
    select.value = wanted;
    for (const type of ['input', 'change']) select.dispatchEvent(new Event(type, { bubbles: true }));
  }, value);
}

// Answers a request of the page with what the plan invented for its path, or with what the copy says and the plan's keys laid over it.
async function answer(route, given) {
  if ('json' in given) return route.fulfill({ json: given.json });
  const real = await route.fetch();
  let said = null;
  try { said = await real.json(); } catch { /* the copy said no JSON: the plan's keys stand alone */ }
  return route.fulfill({ response: real, json: laidOver(said, given.over) });
}

// One step of the plan, done the way a person would: a real click, real keys.
async function act(page, step) {
  const target = step.on ? page.locator(step.on).nth(step.nth ?? 0) : null;
  // `moving`: the element is animated and never stands still, so it is clicked where it is.
  if (step.do === 'click') await target.click({ timeout: STEP_MS, force: step.moving === true });
  else if (step.do === 'fill') await target.fill(step.text, { timeout: STEP_MS });
  else if (step.do === 'choose') await choose(target, step.value);
  else if (step.do === 'keys') await page.keyboard.type(step.text);
  else if (step.do === 'press') await page.keyboard.press(step.key);
  else if (step.do === 'wait') await page.waitForTimeout(step.ms);
  else if (step.do === 'run') await page.evaluate(step.code);
}

// The single steps of an "each" step: a click for every element named, or every choice of every list named.
async function eachOf(page, step) {
  const count = await page.locator(step.on).count();
  if (step.do === 'clickEach') return Array.from({ length: count }, (_, nth) => ({ do: 'click', on: step.on, nth }));
  const each = [];
  for (let nth = 0; nth < count; nth += 1) {
    const values = await page.locator(step.on).nth(nth).evaluate((select) => [...select.options].map((option) => option.value));
    values.forEach((value, at) => { each.push({ do: 'choose', on: step.on, nth, value, say: `list ${nth + 1} of ${count}, choice ${at + 1} of ${values.length}` }); });
  }
  return each;
}

/**
 * Opens the plan's page on the copy and walks the plan. One window, closed whatever happens.
 * @param {any} browser @param {number} port @param {any} plan
 * @returns {Promise<{ say: string, shape: string[], focus: string, requests: string[], errors: string[] }[]>}
 */
export async function walk(browser, port, plan) {
  const context = await browser.newContext({ viewport: { width: plan.width, height: plan.height }, serviceWorkers: 'block', locale: LOCALE, reducedMotion: 'reduce' });
  try {
    const plain = plainFor(port);
    const replace = replacerOf(plan);
    const background = (plan.background ?? []).map((pattern) => new RegExp(pattern));
    const sent = [];
    const answers = plan.answers ?? {};
    const errors = [];
    const flying = new Set();
    await context.addInitScript(initScript());
    await context.route('**/*', (route) => {
      const request = route.request();
      const given = staysOnCopy(request.url(), port) && request.method() === 'GET' ? answers[new URL(request.url()).pathname] : null;
      if (given) return answer(route, given);
      if (staysOnCopy(request.url(), port)) return route.continue();
      sent.push(`REFUSED ${serverOf(request.url())}`);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.on('request', (request) => {
      if (!staysOnCopy(request.url(), port) || /^(?:data|blob|about):/.test(request.url())) return;
      const line = requestLine({ method: request.method(), url: request.url(), body: request.postData(), type: request.headers()['content-type'] ?? '' });
      if (background.some((pattern) => pattern.test(line))) return;
      sent.push(line);
      if (!STAYS_OPEN.has(request.resourceType())) flying.add(request);
    });
    for (const ended of ['requestfinished', 'requestfailed']) page.on(ended, (request) => { flying.delete(request); });
    page.on('pageerror', (error) => errors.push(`page error: ${plain(error.message)}`));
    page.on('console', (message) => { if (message.type() === 'error' && !REFUSED.test(message.text())) errors.push(`console error: ${plain(message.text())}`); });
    await page.goto(`http://127.0.0.1:${port}${plan.page}`, { waitUntil: 'load', timeout: LOAD_MS });
    await page.waitForTimeout(plan.settleMs ?? 2500);

    const steps = [];
    const record = async (say, roots = plan.roots) => {
      await settle(page, flying, plan.quietMs ?? QUIET_MS);
      const read = await page.evaluate(([name, asked]) => window[name].read(asked), [PAGE_NAME, { roots, skip: plan.skip ?? [] }]);
      steps.push({ say, shape: read.shape.map((line) => replace(plain(line))), focus: replace(read.focus),
        requests: [...new Set(sent.splice(0))].sort(), errors: [...new Set(errors.splice(0))].sort() });
    };
    await record('the page as it opens');
    // What a page asks for while it loads is the page check's to compare: a script cut out of another adds one request there.
    steps[0].requests = [];
    const doStep = async (step) => {
      if (step.do !== 'clickEach' && step.do !== 'chooseEach') { await act(page, step); await record(step.say, step.roots); return; }
      const each = await eachOf(page, step);
      if (!each.length) throw new Error(`nothing matches ${step.on}`);
      for (const [at, one] of each.entries()) {
        // What is not on show, or is switched off, cannot be clicked by a person: it is said, and the walk goes on.
        const target = page.locator(one.on).nth(one.nth);
        const shown = one.do !== 'click' || (await target.isVisible() && await target.isEnabled());
        if (shown) await act(page, one);
        await record(`${step.say}, ${one.say ?? `${at + 1} of ${each.length}`}${shown ? '' : ': cannot be clicked, left alone'}`, step.roots);
      }
    };
    for (const step of plan.steps) {
      try { await doStep(step); } catch (error) {
        // A step that cannot be done ends the walk; what was seen until then is kept, to find out why.
        steps.push({ say: step.say, stopped: plain(String(error.message).split(/\r?\n/)[0]), shape: [], focus: '', requests: [], errors: [] });
        break;
      }
    }
    return steps;
  } finally {
    await context.close();
  }
}

// Builds the copy, runs it, walks the plan on it and stops it: only what was started here.
async function recordOn(folder, port, plan, engineName, baseRev) {
  console.log(await build(folder, port, baseRev));
  // The settings the copy starts with, when the plan gives some: invented, and written before its first start.
  if (plan.seed) {
    const data = path.join(path.resolve(folder), 'server', 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(path.join(data, 'settings.json'), JSON.stringify(plan.seed));
  }
  const running = run(folder, port, RUN_MINUTES);
  running.catch(() => { /* told below, once the walk has ended */ });
  let steps = null;
  try {
    await mustBeSideCopy(port);
    const engine = await startEngine(loadPlaywright(), engineName);
    try { steps = await walk(engine.browser, port, plan); } finally { await engine.close(); }
  } finally {
    writeFileSync(path.join(path.resolve(folder), 'stop'), '');
  }
  if (await running) throw new Error('the copy ended by itself: see server.log in its folder');
  return { plan: plan.name, engine: engineName, steps };
}

async function main(argv) {
  const { engine, rest } = engineFromArgs(argv);
  const flag = (name) => { const at = rest.indexOf(name); return at === -1 ? null : rest.splice(at, 2)[1] ?? ''; };
  const [recordTo, against, out, base] = ['--record', '--against', '--out', '--base'].map(flag);
  const [planFile, folder, portArg] = rest;
  if (!planFile || !folder || !portArg || Boolean(recordTo) === Boolean(against)) {
    console.error(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(5, 7).map((line) => line.replace(/^\/\/ ?/, '')).join('\n'));
    return 2;
  }
  const plan = JSON.parse(readFileSync(planFile, 'utf8'));
  const problems = planProblems(plan);
  if (problems.length) { console.error(`${planFile} cannot be walked:\n  ${problems.join('\n  ')}`); return 2; }
  const recording = await recordOn(folder, sidePort(portArg), plan, engine, base ?? undefined);
  const stopped = recording.steps.find((step) => step.stopped);
  const said = recording.steps.reduce((sum, step) => sum + step.shape.length, 0);
  if (recordTo || out) writeFileSync(path.resolve(recordTo || out), `${JSON.stringify(recording, null, 1)}\n`);
  if (stopped) { console.error(`${plan.name} in ${engine} stopped at step ${recording.steps.length} (${stopped.say}): ${stopped.stopped}`); return 1; }
  if (recordTo) { console.log(`Recorded ${plan.name} in ${engine}: ${recording.steps.length} steps, ${said} lines of shape.`); return 0; }
  const difference = firstDifference(JSON.parse(readFileSync(against, 'utf8')), recording);
  if (difference) { console.error(`${plan.name} in ${engine} is not the same as ${against}:\n${difference}`); return 1; }
  console.log(`${plan.name} in ${engine}: the same as ${against} (${recording.steps.length} steps, ${said} lines of shape).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) { console.error(`ui-shape-check: ${error.message}`); process.exitCode = 1; }
}
