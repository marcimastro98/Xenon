// Asks a throwaway copy of the engine whether POST /settings keeps its rules: what a save
// may not touch (the keys the engine or a widget owns, the secrets, the usage history),
// what a paired device may not change (PC Control, app favourites, a widget's permissions),
// the number each save gets, the word every open dashboard is sent, and that a save is
// refused when the stored settings cannot be read. One rule more is about the other save of
// the Settings pages, the app keys of the streaming accounts. Each rule is one real request, sent
// from this computer or as a paired device, and the settings file read before and after.
//
// The engine runs in a rig (engine-rig.mjs): its own data, home and temp folders, this
// computer only, no connection to anywhere else. Every value it is given is invented.
//
//   node tools/ci/settings-save-check.mjs [--list] [--json] [log file]     XENON_PORT picks the port (default 3046)
//
// The log file gets what the engine printed and what the check found: on a runner nobody
// can look at, it is the only way to see why a rule was not kept.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStream, rigPort, startRig } from './engine-rig.mjs';
import { pairDevice } from './paired-device.mjs';
import { DEVICE_RULES } from './settings-save-rules-device.mjs';
import { PC_RULES, same, show } from './settings-save-rules.mjs';
import { SECRET_MARK, seedSettings } from './settings-save-seed.mjs';

const CRASH = /Uncaught|Unhandled|TypeError|ReferenceError|SyntaxError|Cannot find module|FATAL|EADDRINUSE/;
const SETTLED_READS = 6;
const SETTLE_LIMIT_MS = 30_000;
const POLL_MS = 400;

// Invented app keys: no service knows them.
const APP_KEYS = { twitchClientId: 'rig-twitch-id', youtubeClientId: 'rig-youtube-id', youtubeClientSecret: 'rig-secret-youtube',
  discordClientId: '100000000000000001', discordClientSecret: 'rig-secret-discord', spotifyClientId: 'rig-spotify-id' };
const otherOffset = (now) => (now === 500 ? 700 : 500);
const leak = (door) => async ({ doors }) => {
  const seen = await doors[door].ask('GET', '/settings');
  if (seen?.status !== 200 || !seen.json?.settings) return `the settings could not be read (${seen?.status ?? 'no answer'})`;
  return seen.text.includes(SECRET_MARK) ? `a secret is in the answer, near "${seen.text.slice(Math.max(0, seen.text.indexOf(SECRET_MARK) - 40), seen.text.indexOf(SECRET_MARK) + 12)}"` : '';
};

// The rules that are not one save judged by the store before and after.
export const READ_RULES = [
  { rule: 'the settings a dashboard on this computer reads hold no secret', kind: 'guard', run: leak('pc') },
  { rule: 'the settings a paired device reads hold no secret', kind: 'guard', run: leak('device') },
  { rule: 'every open dashboard is told a save, with its number', kind: 'guard',
    run: async ({ doors, stream }) => {
      const mirror = (await doors.pc.ask('GET', '/settings'))?.json?.settings;
      if (!mirror) return 'the settings could not be read';
      const answer = await doors.pc.ask('POST', '/settings', { settings: { ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) } });
      if (answer?.status !== 200) return `the save answered ${answer?.status ?? 'nothing'}`;
      const told = await stream.waitFor((event) => event.name === 'settings' && event.data?.rev === answer.json.rev);
      return told ? '' : `no settings event with number ${answer.json.rev} arrived`;
    } },
];

export const LAST_RULES = [
  { rule: 'when the stored settings cannot be read, a save is refused and nothing is written', kind: 'guard',
    run: async ({ rig, doors }) => {
      const mirror = (await doors.pc.ask('GET', '/settings'))?.json?.settings;
      if (!mirror) return 'the settings could not be read';
      const good = rig.storedText();
      const broken = `${good.slice(0, Math.floor(good.length / 2))}`;
      rig.writeStore(broken);
      const answer = await doors.pc.ask('POST', '/settings', { settings: { ...mirror, lyricsOffsetMs: otherOffset(mirror.lyricsOffsetMs) } });
      const left = rig.storedText();
      rig.writeStore(good);
      if (left !== broken) return 'the save wrote over the settings it could not read';
      return answer?.status === 500 ? '' : `the save answered ${answer?.status ?? 'nothing'}`;
    } },
  // The other save of the Settings pages: the app keys of Twitch, YouTube, Spotify and Discord, kept in a file of
  // their own. The engine makes the four accounts where it loads and again after this save: both must give the same.
  // No account has a sign-in here, so nothing is contacted, the Discord app on this computer included. Last, because
  // it starts the engine again: the stream and the paired device of the rules above do not outlive that.
  { rule: 'app keys saved in Settings → Streaming count at once, and the same after the engine starts again', kind: 'saved',
    run: async ({ rig, doors }) => {
      const accounts = async () => {
        const said = [];
        for (const name of ['twitch', 'youtube', 'spotify', 'discord']) said.push((await doors.pc.ask('GET', `/stream/${name}/status`))?.json ?? null);
        return said;
      };
      const before = await accounts();
      if (before.some((account) => account?.configured !== false)) return `an account had app keys before any were saved, or did not answer: nothing was proven (${show(before)})`;
      const saved = await doors.pc.ask('POST', '/stream/config', APP_KEYS);
      if (saved?.status !== 200) return `the save of the keys answered ${saved?.status ?? 'nothing'}`;
      const after = await accounts();
      if (after.some((account) => account?.configured !== true || account.connected !== false)) return `after the save not every account says it has keys and no sign-in: ${show(after)}`;
      if (!await rig.restart()) return 'the engine did not start again';
      const again = await accounts();
      return same(after, again) ? '' : `after a restart the accounts say ${show(again)}, after the save they said ${show(after)}`;
    } },
];

/**
 * Asks one rule. `context`: `rig` (stored, storedText, writeStore), `doors` (pc, device, stranger: each `ask`), `stream`.
 * @returns {Promise<string>} what went wrong, or ''
 */
export async function askRule(rule, context) {
  if (rule.run) return rule.run(context);
  const { rig, doors } = context;
  const door = doors[rule.door ?? 'pc'];
  const beforeText = rig.storedText();
  const mirror = (await (rule.door === 'stranger' ? doors.pc : door).ask('GET', '/settings'))?.json?.settings;
  if (!mirror) return 'the settings could not be read';
  const before = JSON.parse(beforeText);
  if (rule.given && !same(rule.given(before), before)) return 'what the rules before this one leave stored is not there: nothing was proven';
  const sent = rule.send(structuredClone(mirror), before);
  const answer = await door.ask('POST', '/settings', { settings: sent }, rule.headers);
  if (!answer) return 'the save got no answer';
  if (rule.refused) {
    const untouched = rig.storedText() === beforeText;
    return answer.status === rule.refused && untouched ? '' : `the save answered ${answer.status}${untouched ? '' : ' and the stored settings changed'}`;
  }
  if (answer.status !== 200) return `the save answered ${answer.status}: ${answer.text.slice(0, 160)}`;
  return rule.verdict({ before, after: rig.stored(), answer, sent, mirror });
}

/** Asks the rules in order. @returns {Promise<{ rule: string, kind: string, problem: string }[]>} */
export async function askRules(rules, context) {
  const results = [];
  for (const rule of rules) {
    let problem = '';
    try { problem = await askRule(rule, context); } catch (error) { problem = `the check itself failed: ${error.message}`; }
    results.push({ rule: rule.rule, kind: rule.kind, problem });
  }
  return results;
}

// The engine stamps its usage days when the first dashboard connects: wait until the store has stopped changing.
async function settled(rig) {
  const until = Date.now() + SETTLE_LIMIT_MS;
  let last = null;
  let sameReads = 0;
  while (Date.now() < until && sameReads < SETTLED_READS) {
    const text = rig.storedText();
    sameReads = text === last ? sameReads + 1 : 0;
    last = text;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return sameReads >= SETTLED_READS;
}

/** The lines of an engine's output that mean it broke. Pure, so it is tested. */
export function crashLines(output) {
  return String(output || '').split('\n').filter((line) => CRASH.test(line)).map((line) => line.trim().slice(0, 300));
}

/** What the log file holds: where it ran, the engine's output, every rule and what went wrong. Pure, so it is tested. */
export function checkReport(output, results, problems) {
  const rules = results.map((result) => `${result.problem ? 'NOT KEPT' : 'kept    '}  ${result.rule}`);
  return [`Node ${process.version} on ${process.platform}`, output, `--- ${results.length} rules asked`, ...rules, '---', ...(problems.length ? problems : ['every rule kept']), ''].join('\n');
}

async function main(argv) {
  const rig = await startRig({ port: rigPort(process.env.XENON_PORT), seed: seedSettings });
  const results = [];
  const problems = [];
  let stream = null;
  try {
    if (!rig.up) throw new Error('the engine did not start');
    stream = openStream(rig.port);
    const device = await pairDevice(rig);
    if (!device.ok) throw new Error(`no device could be paired: ${device.why}`);
    if (!await settled(rig)) throw new Error('the stored settings kept changing with nobody saving');
    const context = { rig, stream, doors: { pc: { ask: rig.ask }, device: { ask: device.ask }, stranger: { ask: device.stranger } } };
    results.push(...await askRules([...READ_RULES, ...PC_RULES, ...DEVICE_RULES], context));
    problems.push(...crashLines(rig.output()).map((line) => `crash line: ${line}`));
    results.push(...await askRules(LAST_RULES, context));
  } catch (error) {
    problems.push(error.message);
  } finally {
    stream?.close();
    await rig.stop();
  }
  problems.push(...results.filter((result) => result.problem).map((result) => `${result.rule}: ${result.problem}`));
  const logFile = argv.find((arg) => !arg.startsWith('--'));
  if (logFile) writeFileSync(logFile, checkReport(rig.output(), results, problems));
  if (argv.includes('--json')) console.log(JSON.stringify({ rules: results, problems }, null, 1));
  else {
    if (argv.includes('--list')) for (const result of results) console.log(`${result.problem ? 'NOT KEPT' : 'kept    '}  ${result.rule}`);
    if (problems.length) console.log(problems.join('\n'));
    else console.log(`the settings save keeps its ${results.length} rules on a real engine: ${results.filter((result) => result.kind === 'guard').length} things a save must not do, ${results.filter((result) => result.kind === 'saved').length} it must`);
  }
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
