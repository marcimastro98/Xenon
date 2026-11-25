'use strict';
// The person's own Bit (server/bit/): Bit in the chat, a Deck key and a paired phone
// reach it through these entries, so server/bit/actions.js runs the same steps as
// its routes and every rule (what it owns and wears) holds once. Same shape as
// capability-catalog.js, which appends them; the page loads this file just before it.
((root, factory) => {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CapabilityCatalogBit = api;
})(typeof window !== 'undefined' ? window : globalThis, () => {
  // Moves anyone may ask for: clips of the engine that read well on any Bit.
  // "surprise" picks one of the others.
  const MOVES = ['surprise', 'wave', 'dance', 'hop', 'spin', 'moonwalk', 'juggle', 'bow', 'wink', 'airGuitar', 'cheer'];
  // Same list as server/bit/model.js PLACES (a test keeps them equal).
  const PLACES = ['corner', 'topbar', 'both', 'off'];
  const WEAR = ['toggle', 'on', 'off'];
  const keys = (list, prefix) => Object.fromEntries(list.map((v) => [v, prefix + v]));
  const snake = (id) => id.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  const CAPABILITIES = [
    {
      type: 'bitReact', group: 'xenon', labelKey: 'deck_act_bitReact',
      params: [{ name: 'move', kind: 'select', options: MOVES, optionKeys: Object.fromEntries(MOVES.map((m) => [m, `bit_move_${snake(m)}`])) }],
      capability: {
        domain: 'ai', risk: 'safe', requires: 'bit',
        ai: {
          name: 'bit_move',
          description: 'Make the user\'s own Bit (the little companion on their dashboard, by the clock or on its widget) play a move now, on every screen: wave, dance, hop, spin, moonwalk, juggle, bow, wink, airGuitar, cheer, or surprise (one of them). Error "egg": it has not hatched yet. Use it for "make my Bit dance", "say hi, Bit", "do a trick".',
          params: { move: 'surprise, wave, dance, hop, spin, moonwalk, juggle, bow, wink, airGuitar or cheer' },
        },
      },
    },
    {
      type: 'bitPlace', group: 'xenon', labelKey: 'deck_act_bitPlace',
      params: [{ name: 'place', kind: 'select', options: PLACES, optionKeys: keys(PLACES, 'mybit_place_') }],
      capability: {
        domain: 'ai', risk: 'safe', requires: 'bit',
        ai: {
          name: 'place_bit',
          description: 'Where the user\'s own Bit stands on the dashboard: corner (bottom corner), topbar (by the clock), both, or off (hidden; its Bit widget, if placed, stays). Use it for "hide my Bit", "put Bit by the clock", "bring Bit back".',
          params: { place: 'corner, topbar, both or off' },
        },
      },
    },
    // Bit's own changes: one item at a time, or a name. Never a Deck key.
    {
      type: 'bitWear', group: 'xenon', hidden: true, labelKey: 'deck_act_bitWear',
      params: [
        { name: 'item', kind: 'text', maxLen: 24 },
        { name: 'wear', kind: 'select', options: WEAR, optionKeys: keys(WEAR, 'bit_wear_') },
      ],
      capability: {
        domain: 'ai', risk: 'safe', requires: 'bit',
        ai: {
          name: 'dress_bit',
          description: 'Put on or take off one item the user\'s own Bit owns (get_my_bit lists owned and worn; one item per slot, the new one replaces the old). wear: on, off or toggle. Error "not_owned": it does not have it yet; items come from traits, seasons, supporters\' months, or the shop on its sheet and in the Store for Sparks. Use it for "put the scarf on my Bit", "take Bit\'s hat off".',
          params: { item: 'The item id, from get_my_bit owned', wear: 'on, off or toggle' },
        },
      },
    },
    {
      type: 'bitRename', group: 'xenon', hidden: true, labelKey: 'deck_act_bitRename',
      params: [{ name: 'name', kind: 'text', maxLen: 24 }],
      capability: {
        domain: 'ai', risk: 'safe', requires: 'bit',
        ai: {
          name: 'rename_bit',
          description: 'Give the user\'s own Bit a name (up to 24 characters, shown on its sheet and card), or "" to clear it. Only when the user asks for a name: never pick one yourself. Error "bad_name": letters, numbers, spaces and simple marks only.',
          params: { name: 'The name the user chose' },
        },
      },
    },
    {
      type: 'bitGet', group: 'xenon', hidden: true, labelKey: 'deck_act_bitGet', params: [],
      capability: {
        domain: 'ai', risk: 'safe', requires: 'bit',
        ai: {
          name: 'get_my_bit',
          description: 'How the user\'s own Bit is: hatched (false = still an egg, tapping it hatches it), name, number (its place among every Bit born; local = born offline, no number yet), founder (had Xenon before Bit came), stage and days (days of use: baby, young, adult, veteran, legend), lookOneIn (how many Bits it takes to find its whole look once), traits (habits it is learning, progress 0-1, each earns an item), worn and owned (item ids), place and reactions (how many moves an hour it makes by itself), cards (recap cards ready on its sheet: "2026-11" a month, "2026" the year; what they count stays on the PC). Use it for "how is my Bit?", "what does Bit have?", "how rare is my Bit?".',
          params: {},
        },
      },
    },
  ];

  return { CAPABILITIES, MOVES, PLACES };
});
