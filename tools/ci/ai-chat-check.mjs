// Asks a throwaway copy of the engine whether POST /api/ai, the route every chat turn goes through,
// keeps its rules: what it refuses before any model is asked, what it lets reach the model of the
// pictures and sound a turn carries, how it answers when the model server fails, and that the stop
// button ends a waiting turn. Each rule is one real request.
//
// The engine runs in a rig (engine-rig.mjs): its own data, home and temp folders, this computer
// only, no connection to anywhere else. The model is a stand-in on 127.0.0.1 (ai-stand-in.mjs),
// reached as "a server the person runs on this PC" (provider `localapi`). It never offers a tool
// call, so no tool of the engine runs: nothing here opens a program, writes a file or changes a
// setting. Every value is invented.
//
//   node tools/ci/ai-chat-check.mjs [--list] [--json] [log file]     XENON_PORT picks the port (default 3046)
//
// The log file gets what the engine printed and what the check found, never what was written to the model.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAILURE, MODEL, REPLY, startStandIn } from './ai-stand-in.mjs';
import { rigPort, startRig } from './engine-rig.mjs';
import { checkReport, crashLines } from './settings-save-check.mjs';
import { SECRET_MARK } from './settings-save-seed.mjs';

const MB = 1024 * 1024;
const WAIT_MS = 30_000;
const POLL_MS = 50;
const KEY = `${SECRET_MARK}localApiKey`;
const TURN = 'rig-turn-00000000000001';
const PNG = 'image/png';
const WAV = 'audio/wav';

const user = (text) => ({ role: 'user', parts: [{ text }] });
const turn = (text, more = {}) => ({ provider: 'localapi', lang: 'en', messages: [user(text)], ...more });
const until = async (test, limitMs = WAIT_MS) => {
  const end = Date.now() + limitMs;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return test();
};
const within = (promise, limitMs = WAIT_MS) => {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), limitMs); });
  // The clock is put away with the answer: left running it would keep the check alive for its whole limit.
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};
const shown = (answer) => (answer === 'late' ? 'no answer in time' : answer ? `${answer.status} ${String(answer.text).slice(0, 120)}` : 'no answer');

/** The settings the rig starts with: the model server is the stand-in, with a key and with eyes. Pure, so it is tested. */
export function chatSeed(standInUrl) {
  return { language: 'en', localApiUrl: standInUrl, localApiModel: MODEL, localApiVision: true, localApiKey: KEY };
}

/**
 * The rules, in the order they are asked. `ask` gives '' when the rule is kept, or what was seen instead.
 * `guard`: what the route must not do; `keeps`: what it must.
 * @type {{ rule: string, kind: 'guard' | 'keeps', ask: (context: { rig: any, model: Awaited<ReturnType<typeof startStandIn>> }) => Promise<string> }[]}
 */
export const CHAT_RULES = [
  { rule: 'a turn for Gemini with no key is refused before any model is asked (400 missing_key)', kind: 'guard', ask: async ({ rig, model }) => {
    const before = model.chats.length;
    const answer = await rig.ask('POST', '/api/ai', { ...turn('rig question 1'), provider: 'gemini' });
    if (answer?.status !== 400 || answer.json?.error !== 'missing_key') return shown(answer);
    return model.chats.length === before ? '' : 'the model server was asked all the same';
  } },
  { rule: 'a turn with no message is refused before any model is asked (400 no_messages)', kind: 'guard', ask: async ({ rig, model }) => {
    const before = model.chats.length;
    const answer = await rig.ask('POST', '/api/ai', { ...turn(''), messages: [] });
    if (answer?.status !== 400 || answer.json?.error !== 'no_messages') return shown(answer);
    return model.chats.length === before ? '' : 'the model server was asked all the same';
  } },
  { rule: 'a plain turn is answered with the text of the model, asked once at the server of the settings, with its key', kind: 'keeps', ask: async ({ rig, model }) => {
    const before = model.chats.length;
    model.answer('reply');
    const answer = await rig.ask('POST', '/api/ai', turn('rig question 7131'));
    if (answer?.status !== 200 || answer.json?.text !== REPLY) return shown(answer);
    if (!Array.isArray(answer.json.clientActions) || answer.json.clientActions.length) return 'the answer carries something for the page to do, and no tool was asked for';
    if (model.chats.length !== before + 1) return `the model server was asked ${model.chats.length - before} times`;
    const chat = model.chats.at(-1);
    if (chat.model !== MODEL || !chat.system || !chat.asks('rig question 7131')) return 'the model was not asked with the model of the settings, the rules of the assistant and the words of the person';
    return model.keys.at(-1) === `Bearer ${KEY}` ? '' : 'the key of the settings did not go with the request';
  } },
  { rule: 'a request cannot name another model server: the address in the body is not used', kind: 'guard', ask: async ({ rig, model }) => {
    const before = model.chats.length;
    model.answer('reply');
    const answer = await rig.ask('POST', '/api/ai', turn('rig question 2', { localApiUrl: 'http://127.0.0.1:9', url: 'http://127.0.0.1:9', baseUrl: 'http://127.0.0.1:9' }));
    if (answer?.status !== 200 || answer.json?.text !== REPLY) return shown(answer);
    return model.chats.length === before + 1 ? '' : 'the stand-in of the settings was not the server asked';
  } },
  { rule: 'of the pictures only the first four count, only the allowed kinds, each cut at 8 MB; of the sound only the first clip', kind: 'guard', ask: async ({ rig, model }) => {
    const before = model.chats.length;
    model.answer('reply');
    const small = { mimeType: PNG, data: 'AAAA' };
    const imageParts = [{ mimeType: PNG, data: 'A'.repeat(8 * MB + 4096) }, { mimeType: 'image/svg+xml', data: 'AAAA' }, small, small, small, small];
    const audioParts = [{ mimeType: WAV, data: 'AAAAAAAA' }, { mimeType: WAV, data: 'AAAAAAAA' }];
    const answer = await rig.ask('POST', '/api/ai', turn('rig question 3', { imageParts, audioParts }));
    if (answer?.status !== 200 || model.chats.length !== before + 1) return shown(answer);
    const got = model.chats.at(-1).media.map((item) => `${item.mime} ${item.length}`);
    const want = [`${PNG} ${8 * MB}`, `${PNG} 4`, `${PNG} 4`, `${WAV} 8`];
    return JSON.stringify(got) === JSON.stringify(want) ? '' : `the model got ${JSON.stringify(got)}`;
  } },
  { rule: 'a body over 10 MB is not read: no model is asked, and the engine goes on answering', kind: 'guard', ask: async ({ rig, model }) => {
    const before = model.chats.length;
    const answer = await rig.ask('POST', '/api/ai', turn('rig question 4', { pad: 'A'.repeat(10 * MB + 4096) }));
    if (answer?.status === 200) return 'the turn was answered';
    if (model.chats.length !== before) return 'the model server was asked';
    return (await rig.ask('GET', '/version'))?.status === 200 ? '' : 'the engine stopped answering';
  } },
  { rule: 'a model server that fails is answered 502 with its reason and what was made so far, and the engine goes on', kind: 'keeps', ask: async ({ rig, model }) => {
    model.answer('fail');
    const answer = await rig.ask('POST', '/api/ai', turn('rig question 5'));
    model.answer('reply');
    if (answer?.status !== 502 || !/^localserver_/.test(String(answer.json?.error)) || !Array.isArray(answer.json?.clientActions)) return shown(answer);
    if (!String(answer.json.detail ?? '').includes(FAILURE)) return `the reason of the server is not in the answer (${String(answer.json.detail).slice(0, 80)})`;
    return (await rig.ask('POST', '/api/ai', turn('rig question 6')))?.json?.text === REPLY ? '' : 'the next turn was not answered';
  } },
  { rule: 'the stop button ends a turn that waits for the model: the request to the model is dropped and the turn answers as stopped', kind: 'keeps', ask: async ({ rig, model }) => {
    const [before, dropped] = [model.chats.length, model.dropped()];
    model.answer('hold');
    const waiting = rig.ask('POST', '/api/ai', turn('rig question 8', { turnId: TURN }));
    const asked = await until(() => model.chats.length > before);
    const running = asked ? await rig.ask('GET', `/api/ai/turn?id=${TURN}`) : null;
    const stop = asked ? await rig.ask('POST', '/api/ai/turn/stop', { id: TURN }) : null;
    const answer = await within(waiting);
    model.answer('reply');
    if (!asked) return 'the model server was never asked';
    if (stop?.json?.ok !== true) return `the stop was not taken (${shown(stop)})`;
    if (answer === 'late' || answer?.status !== 200 || answer.json?.stopped !== true || answer.json.text !== '') return shown(answer);
    if (!await until(() => model.dropped() === dropped + 1, 5000)) return 'the request to the model went on after the stop';
    if (running?.status !== 200) return `how far the turn got could not be asked (${shown(running)})`;
    return (await rig.ask('POST', '/api/ai/turn/stop', { id: 'rig-turn-nobody-0000001' }))?.json?.ok === false ? '' : 'a stop for a turn nobody started was taken';
  } },
];

async function main(argv) {
  const model = await startStandIn();
  const rig = await startRig({ port: rigPort(process.env.XENON_PORT), seed: chatSeed(model.url) });
  const results = [];
  const problems = [];
  try {
    if (!rig.up) throw new Error('the engine did not start');
    for (const { rule, kind, ask } of CHAT_RULES) {
      let problem;
      try { problem = await ask({ rig, model }); } catch (error) { problem = `the check itself failed: ${error.message}`; }
      results.push({ rule, kind, problem });
    }
    problems.push(...crashLines(rig.output()).map((line) => `crash line: ${line}`));
  } catch (error) {
    problems.push(error.message);
  } finally {
    await rig.stop();
    await model.close();
  }
  problems.push(...results.filter((result) => result.problem).map((result) => `${result.rule}: ${result.problem}`));
  const logFile = argv.find((arg) => !arg.startsWith('--'));
  if (logFile) writeFileSync(logFile, checkReport(rig.output(), results, problems));
  if (argv.includes('--json')) console.log(JSON.stringify({ rules: results, problems }, null, 1));
  else {
    if (argv.includes('--list')) for (const result of results) console.log(`${result.problem ? 'NOT KEPT' : 'kept    '}  ${result.rule}`);
    if (problems.length) console.log(problems.join('\n'));
    else console.log(`a chat turn keeps its ${results.length} rules on a real engine: ${results.filter((result) => result.kind === 'guard').length} things it must not do, ${results.filter((result) => result.kind === 'keeps').length} it must`);
  }
  process.exitCode = problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
