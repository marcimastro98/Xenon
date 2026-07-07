import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ai = require('../ai-local.js');

test('voiceForLang maps known languages', () => {
  assert.equal(ai.voiceForLang('it'), 'it-IT-ElsaNeural');
  assert.equal(ai.voiceForLang('en'), 'en-US-AriaNeural');
  assert.equal(ai.voiceForLang('ja'), 'ja-JP-NanamiNeural');
});

test('voiceForLang normalizes 2-letter prefix and casing', () => {
  assert.equal(ai.voiceForLang('IT'), 'it-IT-ElsaNeural');
  assert.equal(ai.voiceForLang('en-US'), 'en-US-AriaNeural');
});

test('voiceForLang falls back for unknown language', () => {
  assert.equal(ai.voiceForLang('xx'), 'it-IT-ElsaNeural');
  assert.equal(ai.voiceForLang(''), 'it-IT-ElsaNeural');
  assert.equal(ai.voiceForLang(undefined), 'it-IT-ElsaNeural');
});

test('sanitizeProvider only allows gemini/ollama, defaults gemini', () => {
  assert.equal(ai.sanitizeProvider('ollama'), 'ollama');
  assert.equal(ai.sanitizeProvider('gemini'), 'gemini');
  assert.equal(ai.sanitizeProvider('evil'), 'gemini');
  assert.equal(ai.sanitizeProvider(''), 'gemini');
  assert.equal(ai.sanitizeProvider(undefined), 'gemini');
});

test('sanitizeModel accepts whitelist and valid custom names', () => {
  assert.equal(ai.sanitizeModel('auto'), 'auto');
  assert.equal(ai.sanitizeModel('qwen2.5:7b'), 'qwen2.5:7b');
  assert.equal(ai.sanitizeModel('deepseek-r1:8b'), 'deepseek-r1:8b'); // custom ok
  assert.equal(ai.sanitizeModel('mistral_small.v2'), 'mistral_small.v2');
});

test('sanitizeModel rejects bad input and over-long strings', () => {
  assert.equal(ai.sanitizeModel('bad name with spaces'), 'auto');
  assert.equal(ai.sanitizeModel('rm -rf /'), 'auto');
  assert.equal(ai.sanitizeModel('a'.repeat(80)), 'auto');
  assert.equal(ai.sanitizeModel(''), 'auto');
  assert.equal(ai.sanitizeModel(undefined), 'auto');
});

test('sanitizeOllamaUrl only allows localhost/127.0.0.1', () => {
  assert.equal(ai.sanitizeOllamaUrl('http://localhost:11434'), 'http://localhost:11434');
  assert.equal(ai.sanitizeOllamaUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(ai.sanitizeOllamaUrl('http://evil.com:11434'), 'http://localhost:11434');
  assert.equal(ai.sanitizeOllamaUrl('not a url'), 'http://localhost:11434');
  assert.equal(ai.sanitizeOllamaUrl(''), 'http://localhost:11434');
});

test('computeTier: incompatible when RAM<8 and VRAM<4', () => {
  const r = ai.computeTier({ ramGB: 6, vramGB: 2, cores: 4 });
  assert.equal(r.tier, 'incompatible');
  assert.equal(r.recommended, 'auto'); // nothing usable
});

test('computeTier: minimum -> qwen2.5:3b', () => {
  const a = ai.computeTier({ ramGB: 8, vramGB: 0, cores: 4 });
  assert.equal(a.tier, 'minimum');
  assert.equal(a.recommended, 'qwen2.5:3b');
  const b = ai.computeTier({ ramGB: 8, vramGB: 4, cores: 4 });
  assert.equal(b.tier, 'minimum');
});

test('computeTier: recommended -> qwen2.5:7b', () => {
  const a = ai.computeTier({ ramGB: 16, vramGB: 0, cores: 8 });
  assert.equal(a.tier, 'recommended');
  assert.equal(a.recommended, 'qwen2.5:7b');
  const b = ai.computeTier({ ramGB: 8, vramGB: 6, cores: 8 });
  assert.equal(b.tier, 'recommended');
});

test('computeTier: optimal only when VRAM>=12 (a tight 10GB card OOMs the 12B)', () => {
  const r = ai.computeTier({ ramGB: 32, vramGB: 12, cores: 16 });
  assert.equal(r.tier, 'optimal');
  assert.equal(r.recommended, 'gemma4:12b');
  // 10 GB is no longer "optimal" — it falls back to the safe 7B tier.
  const tight = ai.computeTier({ ramGB: 32, vramGB: 10, cores: 16 });
  assert.equal(tight.tier, 'recommended');
  assert.equal(tight.recommended, 'qwen2.5:7b');
});

test('modelSafety: fits VRAM -> ok (gpu)', () => {
  const r = ai.modelSafety('qwen2.5:7b', { vram: 8, ram: 16 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'gpu');
});

test('modelSafety: no VRAM but enough RAM -> ok (cpu)', () => {
  const r = ai.modelSafety('qwen2.5:7b', { vram: 0, ram: 16 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'cpu');
});

test('modelSafety: too big for both VRAM and RAM -> refused', () => {
  const r = ai.modelSafety('gemma4:12b', { vram: 8, ram: 16 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'insufficient');
  assert.match(r.reason, /gemma4:12b/);
});

test('modelSafety: unknown custom tag is allowed (tier gate still guards weak PCs)', () => {
  const r = ai.modelSafety('deepseek-r1:8b', { vram: 8, ram: 16 });
  assert.equal(r.ok, true);
  assert.equal(r.code, 'unknown');
});

test('geminiToolsToOpenAI converts names, descriptions and types', () => {
  const gemini = [
    { name: 'toggle_mic', description: 'Toggle mic', parameters: { type: 'OBJECT', properties: {} } },
    { name: 'set_volume', description: 'Set volume', parameters: {
      type: 'OBJECT',
      properties: { level: { type: 'NUMBER', description: 'Volume 0-100' } },
      required: ['level'],
    } },
  ];
  const out = ai.geminiToolsToOpenAI(gemini);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'toggle_mic');
  assert.deepEqual(out[0].function.parameters, { type: 'object', properties: {} });
  assert.equal(out[1].function.parameters.properties.level.type, 'number');
  assert.deepEqual(out[1].function.parameters.required, ['level']);
});

test('geminiToolsToOpenAI handles BOOLEAN and nested-free schemas', () => {
  const out = ai.geminiToolsToOpenAI([
    { name: 'complete_task', description: 'x', parameters: {
      type: 'OBJECT',
      properties: { id: { type: 'STRING' }, completed: { type: 'BOOLEAN' } },
      required: ['id'],
    } },
  ]);
  assert.equal(out[0].function.parameters.properties.id.type, 'string');
  assert.equal(out[0].function.parameters.properties.completed.type, 'boolean');
});

test('geminiHistoryToOpenAI maps roles and joins text parts', () => {
  const hist = [
    { role: 'user', parts: [{ text: 'ciao' }] },
    { role: 'model', parts: [{ text: 'salve' }] },
    { role: 'user', parts: [{ text: 'che' }, { text: 'ore' }] },
  ];
  const out = ai.geminiHistoryToOpenAI(hist);
  assert.deepEqual(out, [
    { role: 'user', content: 'ciao' },
    { role: 'assistant', content: 'salve' },
    { role: 'user', content: 'che ore' },
  ]);
});

test('geminiHistoryToOpenAI replaces inline images with a placeholder', () => {
  const out = ai.geminiHistoryToOpenAI([
    { role: 'user', parts: [{ text: 'guarda' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] },
  ]);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /guarda/);
  assert.match(out[0].content, /\[immagine\]/);
});

test('geminiHistoryToOpenAI skips empty messages', () => {
  const out = ai.geminiHistoryToOpenAI([{ role: 'user', parts: [] }, { role: 'user', parts: [{ text: 'x' }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'x');
});

test('parseOllamaResponse extracts plain text', () => {
  const r = ai.parseOllamaResponse({ choices: [{ message: { content: 'ciao', role: 'assistant' } }] });
  assert.equal(r.text, 'ciao');
  assert.equal(r.functionCall, null);
});

test('parseOllamaResponse extracts a tool call with parsed args', () => {
  const r = ai.parseOllamaResponse({ choices: [{ message: {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'c1', function: { name: 'set_volume', arguments: '{"level":80}' } }],
  } }] });
  assert.equal(r.functionCall.name, 'set_volume');
  assert.deepEqual(r.functionCall.args, { level: 80 });
});

test('parseOllamaResponse tolerates object arguments and bad JSON', () => {
  const obj = ai.parseOllamaResponse({ choices: [{ message: {
    tool_calls: [{ function: { name: 'x', arguments: { a: 1 } } }] } }] });
  assert.deepEqual(obj.functionCall.args, { a: 1 });
  const bad = ai.parseOllamaResponse({ choices: [{ message: {
    tool_calls: [{ function: { name: 'y', arguments: 'not json' } }] } }] });
  assert.deepEqual(bad.functionCall.args, {});
});

test('parseOllamaResponse handles empty/missing choices', () => {
  assert.equal(ai.parseOllamaResponse({}).text, '');
  assert.equal(ai.parseOllamaResponse({ choices: [] }).functionCall, null);
});

test('parseOllamaResponse extracts text from a multimodal content array', () => {
  // gemma4 in Ollama can return content as [{type:"text",text:"..."}] instead of a string.
  const r = ai.parseOllamaResponse({ choices: [{ message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'ciao ' }, { type: 'text', text: 'mondo' }],
  } }] });
  assert.equal(r.text, 'ciao mondo');
});

test('modelSupportsVision matches gemma4/llava and rejects text-only models', () => {
  assert.equal(ai.modelSupportsVision('gemma4:12b'), true);
  assert.equal(ai.modelSupportsVision('gemma4:12b-q4_0'), true);
  assert.equal(ai.modelSupportsVision('llava:13b'), true);
  assert.equal(ai.modelSupportsVision('qwen2.5:7b'), false);
  assert.equal(ai.modelSupportsVision('llama3.1:8b'), false);
  assert.equal(ai.modelSupportsVision('auto'), false);
});

test('geminiHistoryToNative puts images on a separate base64 array for vision models', () => {
  const hist = [{ role: 'user', parts: [
    { text: 'cosa vedi?' },
    { inlineData: { mimeType: 'image/png', data: 'AAAB' } },
  ] }];
  const out = ai.geminiHistoryToNative(hist, { supportsVision: true });
  assert.equal(out.length, 1);
  assert.equal(out[0].content, 'cosa vedi?');
  assert.deepEqual(out[0].images, ['AAAB']); // raw base64, no data: prefix
});

test('geminiHistoryToNative degrades images to a placeholder for text-only models', () => {
  const out = ai.geminiHistoryToNative(
    [{ role: 'user', parts: [{ text: 'guarda' }, { inlineData: { mimeType: 'image/png', data: 'x' } }] }],
    { supportsVision: false });
  assert.equal(out[0].images, undefined);
  assert.match(out[0].content, /\[immagine\]/);
});

test('parseOllamaNativeResponse reads resp.message and object tool args', () => {
  const text = ai.parseOllamaNativeResponse({ message: { role: 'assistant', content: 'salve' } });
  assert.equal(text.text, 'salve');
  assert.equal(text.functionCall, null);
  const call = ai.parseOllamaNativeResponse({ message: {
    role: 'assistant', content: '',
    tool_calls: [{ function: { name: 'set_volume', arguments: { level: 80 } } }],
  } });
  assert.equal(call.functionCall.name, 'set_volume');
  assert.deepEqual(call.functionCall.args, { level: 80 });
});

test('parseOllamaNativeResponse handles empty/missing message', () => {
  assert.equal(ai.parseOllamaNativeResponse({}).text, '');
  assert.equal(ai.parseOllamaNativeResponse({}).functionCall, null);
});

test('resolveModel returns the scan recommendation for auto', () => {
  assert.equal(ai.resolveModel('auto', { recommended: 'qwen2.5:7b' }), 'qwen2.5:7b');
  assert.equal(ai.resolveModel('auto', { recommended: 'qwen2.5:3b' }), 'qwen2.5:3b');
});

test('resolveModel falls back to qwen2.5:3b when scan missing for auto', () => {
  assert.equal(ai.resolveModel('auto', null), 'qwen2.5:3b');
  assert.equal(ai.resolveModel('auto', { recommended: 'auto' }), 'qwen2.5:3b');
});

test('resolveModel passes through explicit model', () => {
  assert.equal(ai.resolveModel('qwen2.5:7b', null), 'qwen2.5:7b');
  assert.equal(ai.resolveModel('deepseek-r1:8b', { recommended: 'qwen2.5:3b' }), 'deepseek-r1:8b');
});

test('_stripHtml removes tags and decodes common entities', () => {
  assert.equal(ai._stripHtml('<b>Ciao</b> &amp; benvenuto'), 'Ciao & benvenuto');
  assert.equal(ai._stripHtml('a &lt;b&gt; c &#x27;d&#39;'), "a <b> c 'd'");
  assert.equal(ai._stripHtml('  spazi    multipli\n\t'), 'spazi multipli');
  assert.equal(ai._stripHtml(undefined), '');
});

test('_ddgRealUrl decodes the uddg redirect parameter', () => {
  assert.equal(
    ai._ddgRealUrl('//duckduckgo.com/l/?uddg=https%3A%2F%2Fit.wikipedia.org%2Fwiki%2FRoma&rut=abc'),
    'https://it.wikipedia.org/wiki/Roma');
  // A direct https URL is passed through unchanged.
  assert.equal(ai._ddgRealUrl('https://example.com/page'), 'https://example.com/page');
});

test('_parseDdgHtml extracts titles, urls and snippets', () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Primo <b>risultato</b></a>
    <a class="result__snippet" href="x">Questo &egrave; uno snippet &amp; altro</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fb">Secondo</a>
    <a class="result__snippet" href="y">Altro snippet</a>`;
  const { sources, snippets } = ai._parseDdgHtml(html);
  assert.equal(sources.length, 2);
  assert.equal(sources[0].title, 'Primo risultato');
  assert.equal(sources[0].url, 'https://example.com/a');
  assert.equal(sources[1].url, 'https://example.org/b');
  assert.equal(snippets.length, 2);
  assert.match(snippets[0], /snippet & altro/);
});

test('_parseDdgHtml returns empty arrays for non-result HTML', () => {
  const { sources, snippets } = ai._parseDdgHtml('<html><body>no results here</body></html>');
  assert.deepEqual(sources, []);
  assert.deepEqual(snippets, []);
});

test('whisperPaths returns exe and model under server/whisper', () => {
  const p = ai.whisperPaths('/srv/app/server');
  assert.equal(p.dir, path.join('/srv/app/server', 'whisper'));
  assert.equal(p.exe, path.join('/srv/app/server', 'whisper', 'whisper-cli.exe'));
  assert.equal(p.model, path.join('/srv/app/server', 'whisper', 'ggml-small.bin'));
});
