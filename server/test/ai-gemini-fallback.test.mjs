import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { engineSource } from './engine-source.mjs';
const require = createRequire(import.meta.url);
const { isMissingModel, withFallbackModel, tryOtherModels } = require('../ai-gemini.js');

const CLOSED = 'This model models/gemini-2.5-pro is no longer available to new users. Please update your code.';

test('a model Google closed or retired is told apart from any other failure', () => {
  assert.equal(isMissingModel(new Error(CLOSED)), true);
  assert.equal(isMissingModel(new Error('models/x is not found for API version v1beta')), true);
  assert.equal(isMissingModel(new Error('timeout')), false);
  assert.equal(isMissingModel(new Error('voice_blocked')), false);
  assert.equal(isMissingModel(new Error('API key not valid')), false);
  assert.equal(isMissingModel(null), false);
});

test('a closed model hands the request to the next one', async () => {
  const tried = [];
  const run = async (id) => { tried.push(id); if (id === 'closed') throw new Error(CLOSED); return 'answer'; };
  assert.equal(await withFallbackModel('closed', () => ['closed', 'open', 'spare'], run), 'answer');
  assert.deepEqual(tried, ['closed', 'open'], 'the model that failed is skipped, and one retry is enough');
});

test('a model that works never looks for another', async () => {
  const alternatives = () => { throw new Error('should not be asked'); };
  assert.equal(await withFallbackModel('open', alternatives, async () => 'answer'), 'answer');
});

test('any other failure stays the real error', async () => {
  const tried = [];
  const run = async (id) => { tried.push(id); throw new Error('voice_blocked'); };
  await assert.rejects(withFallbackModel('open', () => ['spare'], run), /voice_blocked/);
  assert.deepEqual(tried, ['open']);
});

test('with nowhere to go the closed model is what the user hears about', async () => {
  const run = async () => { throw new Error(CLOSED); };
  await assert.rejects(withFallbackModel('closed', () => ['closed', null], run), /no longer available/);
});

test('every one-shot Gemini call can leave a closed model, as the chat does', () => {
  const S = engineSource();
  assert.equal((S.match(/_withGeminiModel\(model, apiKey, \(/g) || []).length, 4, 'one-shot, transcription, web search, JSON');
  assert.equal((S.match(/\bwithThinking\(/g) || []).length, 2, 'the chat, and the shared helper');
});

test('a thinking model has as long to transcribe as the chat has to answer', () => {
  const S = engineSource();
  const start = S.indexOf('function _transcribeAudioOnce(');
  assert.match(S.slice(start, start + 2600), /req\.setTimeout\(STT_GEMINI_TIMEOUT_MS,/);
  assert.match(S, /const STT_GEMINI_TIMEOUT_MS = 30000;/);
});

const BUSY = new Error('This model is currently experiencing high demand.');
const isBusy = (e) => /high demand/.test(e.message);

test('with every Flash model overloaded the chat reaches Flash-Lite', async () => {
  const asked = [];
  const out = await tryOtherModels(['flash', 'flash-lite'], async (id) => {
    asked.push(id);
    if (id === 'flash') throw BUSY;
    return 'answer from ' + id;
  }, BUSY, isBusy);
  assert.equal(out, 'answer from flash-lite');
  assert.deepEqual(asked, ['flash', 'flash-lite']);
});

test('the same model is never asked twice, and a missing entry is skipped', async () => {
  const asked = [];
  await assert.rejects(tryOtherModels(['a', null, 'a'], async (id) => { asked.push(id); throw BUSY; }, BUSY, isBusy), /high demand/);
  assert.deepEqual(asked, ['a']);
});

test('a failure that is not about the model stops the search at once', async () => {
  const asked = [];
  const badKey = new Error('API key not valid');
  await assert.rejects(tryOtherModels(['a', 'b'], async (id) => { asked.push(id); throw badKey; }, BUSY, isBusy), /API key not valid/);
  assert.deepEqual(asked, ['a']);
});

test('with nothing else to try the first error comes back', async () => {
  await assert.rejects(tryOtherModels([], async () => 'never', BUSY, isBusy), /high demand/);
});
