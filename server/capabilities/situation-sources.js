'use strict';
// Rules for the situations engine (situations.js) that do not live on a placed
// widget or page: a pump screen's moments ("when I play, the game face"). Each
// source hands its rules, so the engine reads the facts they need and nothing
// else, and hears every settled reading back.
//
// A source is { rules: () => when[], onFacts: (facts) => void }. Required by its
// feature at load, never discovered.

const sources = new Set();

/** @param {{ rules: () => any[], onFacts: (facts: any) => void }} source @returns {() => void} */
function addSource(source) {
  sources.add(source);
  return () => { sources.delete(source); };
}

function rules() {
  const out = [];
  for (const s of sources) {
    try { out.push(...s.rules()); } catch { /* a broken source asks for nothing */ }
  }
  return out;
}

function tell(facts) {
  for (const s of sources) {
    try { s.onFacts(facts); } catch { /* one source never stops the others */ }
  }
}

module.exports = { addSource, rules, tell };
