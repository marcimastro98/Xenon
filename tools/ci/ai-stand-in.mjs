// A model server that is not one: it listens on this computer only, speaks the two addresses an
// OpenAI-compatible server has (/v1/models, /v1/chat/completions) and answers what the check
// asked it to answer. It never offers a tool call, so the engine that talks to it runs no tool.
//
// It keeps a short note of each chat it was asked (how many messages, which kinds of pictures and
// sound and how long, whether tools were offered), not the texts: what an engine writes to a model
// describes the computer it runs on, and that stays out of every log.

import http from 'node:http';

export const MODEL = 'rig-model';
export const REPLY = 'rig answer 4242';
// Without the words a server uses to refuse tools: the engine would ask again without them.
export const FAILURE = 'the rig model broke';

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * What the check needs to know of one chat request. Pure, so it is tested.
 * @param {any} body the parsed JSON of a /v1/chat/completions request, or null
 * @returns {{ model: string, messages: number, system: boolean, tools: number, media: { mime: string, length: number }[], asks: (marker: string) => boolean }}
 *   `media`: every picture or sound sent as a data address, with the length of its base64 text;
 *   `asks` says whether a text of the person holds the marker, without handing the texts out
 */
export function chatNote(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const partsOf = (message) => (Array.isArray(message?.content) ? message.content : []);
  const media = messages.flatMap(partsOf).map((part) => DATA_URL.exec(String(part?.image_url?.url ?? ''))).filter(Boolean)
    .map((match) => ({ mime: match[1], length: match[2].length }));
  const userTexts = messages.filter((message) => message?.role === 'user')
    .flatMap((message) => (typeof message.content === 'string' ? [message.content] : partsOf(message).map((part) => String(part?.text ?? ''))));
  return {
    model: String(body?.model ?? ''), messages: messages.length, system: messages.some((message) => message?.role === 'system'),
    tools: Array.isArray(body?.tools) ? body.tools.length : 0, media, asks: (marker) => userTexts.some((text) => text.includes(marker)),
  };
}

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) });
  res.end(text);
};

/**
 * @returns {Promise<{ port: number, url: string, chats: ReturnType<typeof chatNote>[], keys: string[], dropped: () => number,
 *   answer: (mode: 'reply' | 'fail' | 'hold') => void, close: () => Promise<void> }>}
 *   `answer` picks what the next chats get: the reply, an error of the server, or nothing until the asker hangs up;
 *   `keys` is the Authorization header of each chat; `dropped` counts the chats whose asker hung up before an answer
 */
export function startStandIn() {
  let mode = 'reply';
  let dropped = 0;
  const chats = [];
  const keys = [];
  const held = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') { send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] }); return; }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { send(res, 404, { error: { message: 'not here' } }); return; }
      let body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* not JSON: noted as an empty chat */ }
      chats.push(chatNote(body));
      keys.push(String(req.headers.authorization ?? ''));
      if (mode === 'fail') { send(res, 500, { error: { message: FAILURE } }); return; }
      if (mode === 'hold') {
        held.add(res);
        res.on('close', () => { if (!res.writableEnded) dropped += 1; held.delete(res); });
        return;
      }
      send(res, 200, { id: 'rig-reply', object: 'chat.completion', model: MODEL,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: REPLY } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
      resolve({
        port, url: `http://127.0.0.1:${port}`, chats, keys, dropped: () => dropped,
        answer: (next) => { mode = next; },
        close: () => new Promise((done) => {
          for (const res of held) res.destroy();
          server.close(() => done());
          server.closeAllConnections();
        }),
      });
    });
  });
}
