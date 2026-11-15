'use strict';
// Bit votes on a Store entry the user named. A vote is final, so this only finds
// the entry and checks it can be voted: what Bit gets back goes on a confirmation
// card (ai-deck-run.js holds it by nonce) and the vote runs when the user approves.
// It is no Deck action on purpose: a key or a widget must never be able to vote.

const { ownedEntries } = require('./rating-votes.js');

const WHY = new Set(['breaks', 'slow', 'dislike', 'useless']);
const LOW_STARS = 3;
const TYPE = 'storeRate';
const CHOICES_MAX = 20;

const nameOf = (tx) => String(tx.name || tx.sourceId);

// Exact name first, then a name containing what was said.
function findEntries(owned, said) {
  const want = String(said || '').trim().toLowerCase();
  if (!want) return [];
  const all = [...owned.values()];
  const exact = all.filter((tx) => nameOf(tx).toLowerCase() === want);
  return exact.length ? exact : all.filter((tx) => nameOf(tx).toLowerCase().includes(want));
}

// What a state other than open means, in words Bit can pass on.
function refusal(state) {
  if (state.state === 'wait') return { ok: false, error: 'too_soon', ripeAt: state.ripeAt, hint: 'It can be voted three days after install: tell the user when.' };
  if (state.state === 'voted') return { ok: false, error: 'already_voted', stars: state.stars, hint: 'A vote is final and cannot be changed.' };
  if (state.state === 'used') return { ok: false, error: 'already_voted', hint: 'This PC already gave its vote. A vote is final.' };
  if (state.state === 'off') return { ok: false, error: 'count_off', hint: 'Voting needs the anonymous install count, in Settings.' };
  if (state.state === 'locked') return { ok: false, error: 'locked', hint: 'It must be unlocked on this PC first.' };
  return { ok: false, error: 'not_installed', hint: 'Only something installed from the Store can be voted.' };
}

// args: { name, stars, why }. Returns the action for the card, or what to tell the user.
async function plan(args, { settings, stateOf }) {
  const stars = Number(args && args.stars);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { ok: false, error: 'bad_stars', hint: 'Ask how many stars, from 1 to 5.' };
  const owned = ownedEntries(settings() || {});
  const hits = findEntries(owned, args.name);
  if (!hits.length) return { ok: false, error: 'not_found', choices: [...owned.values()].map(nameOf).slice(0, CHOICES_MAX) };
  if (hits.length > 1) return { ok: false, error: 'ambiguous', choices: hits.map(nameOf).slice(0, CHOICES_MAX) };
  const state = await stateOf(hits[0].sourceId);
  if (!state || state.state !== 'open') return refusal(state || {});
  const why = stars <= LOW_STARS && WHY.has(args.why) ? args.why : '';
  return { ok: true, action: { type: TYPE, entryId: hits[0].sourceId, name: nameOf(hits[0]), stars, why } };
}

// The card's one line, the same in every language.
const cardParams = (action) => [{ name: action.name, value: `${action.stars}/5` }];

module.exports = { plan, cardParams, findEntries, TYPE };
