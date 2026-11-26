// Just enough page for Bit's player (packages/core/src/bit-player.js): elements that keep
// children and attributes, a clock whose timers run only when a test says so, and the whole
// engine loaded in the order every page loads it (bit-engine-pages.test.mjs).
import { readFileSync } from './browser-source.mjs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
export const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
export const BIT_ENGINE = require('./fixtures/bit-engine.json');

export class FakeEl {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parent = null; this.textContent = ''; this.className = ''; this.isConnected = true; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this.append(...cs); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); this.isConnected = false; }
}

export function fakeClock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { pending.delete(id); },
    pending,
    runNext() { const [id, t] = pending.entries().next().value; pending.delete(id); t.fn(); },
  };
}

/** The engine in a fresh context; `extra` adds files after it (a clip pack). */
export function bootPlayer({ extra = [] } = {}) {
  const clock = fakeClock();
  const docListeners = {};
  const document = {
    hidden: false,
    createElementNS: (_ns, tag) => new FakeEl(tag),
    addEventListener: (type, fn) => { docListeners[type] = fn; },
    removeEventListener: () => {},
  };
  const ctx = { document, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Math, Promise, Object, Array, String, Number, Set, Map };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of [...BIT_ENGINE, ...extra]) {
    vm.runInContext(read(`../${f}`), ctx, { filename: f });
  }
  return { ctx, clock, Xenon: ctx.Xenon, docListeners };
}
