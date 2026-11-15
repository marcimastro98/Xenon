// The part of the shape check (ui-shape-check.mjs) that runs inside the page: it counts
// the listeners every element is given, and writes an element and all under it as lines
// of text. Each function here is sent to the page as its own text, so none may use a name
// of this file: what one needs of another is handed to it.

/** What the page is given before its first script runs: `window.__xenonShape`. */
export const PAGE_NAME = '__xenonShape';
// The handlers a page can set as a property, without addEventListener.
export const PROPERTY_HANDLERS = ['onclick', 'onchange', 'oninput', 'onkeydown', 'onkeyup', 'onpointerdown', 'onpointerup', 'onsubmit', 'onfocus', 'onblur', 'onscroll', 'onwheel'];

/**
 * One element and all under it, as lines: a tag with its id and classes, its other attributes by name, the listeners it was
 * given, what a field holds; then its texts and elements, one step deeper each.
 * @param {any} node an element (anything with `nodeType`, `tagName`, `attributes`, `childNodes`)
 * @param {{ listeners?: (node: any) => string, skip?: (node: any) => boolean, depth?: number }} [how]
 *   `listeners`: what was counted for an element, `''` for none; `skip`: an element written as one line, without what is under it
 * @returns {string[]}
 */
export function shapeLines(node, how = {}) {
  const out = [];
  const quote = (text) => JSON.stringify(String(text).replace(/\s+/g, ' ').trim());
  const walk = (at, depth) => {
    const pad = '  '.repeat(depth);
    if (at.nodeType === 3) {
      const text = String(at.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (text) out.push(`${pad}${JSON.stringify(text)}`);
      return;
    }
    if (at.nodeType !== 1) return;
    const attributes = [...(at.attributes ?? [])].map((attribute) => [attribute.name, attribute.value]);
    const held = (name) => attributes.find(([key]) => key === name)?.[1] ?? '';
    const classes = held('class').split(/\s+/).filter(Boolean);
    let line = `${pad}${String(at.tagName).toLowerCase()}${held('id') ? `#${held('id')}` : ''}${classes.map((name) => `.${name}`).join('')}`;
    for (const [name, value] of attributes.filter(([key]) => key !== 'class' && key !== 'id').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) line += ` [${name}=${quote(value)}]`;
    const tag = String(at.tagName).toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      line += ` value=${quote(at.value ?? '')}`;
      if (at.checked) line += ' checked';
      if (at.disabled) line += ' disabled';
    }
    const counted = how.listeners ? how.listeners(at) : '';
    if (counted) line += ` {${counted}}`;
    if (how.skip?.(at)) { out.push(`${line} …`); return; }
    out.push(line);
    for (const child of at.childNodes ?? []) walk(child, depth + 1);
  };
  walk(node, how.depth ?? 0);
  return out;
}

/**
 * Runs first in every page of the check. Counts the listeners each target is given, the way the browser keeps them
 * (the same function for the same event and phase counts once), and leaves `window.__xenonShape`.
 * @param {string} name @param {typeof shapeLines} lines `shapeLines`, written into the script as code @param {string[]} handlers
 */
export function installInPage(name, lines, handlers) {
  if (window[name]) return;
  const kept = new WeakMap();
  const phase = (options) => (typeof options === 'boolean' ? options : Boolean(options?.capture));
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function addCounted(type, listener, options) {
    if (listener) {
      const byType = kept.get(this) ?? new Map();
      kept.set(this, byType);
      const list = byType.get(type) ?? [];
      byType.set(type, list);
      if (!list.some((entry) => entry.listener === listener && entry.capture === phase(options))) list.push({ listener, capture: phase(options) });
    }
    return add.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function removeCounted(type, listener, options) {
    const list = kept.get(this)?.get(type);
    const at = list ? list.findIndex((entry) => entry.listener === listener && entry.capture === phase(options)) : -1;
    if (at >= 0) list.splice(at, 1);
    return remove.call(this, type, listener, options);
  };
  const listeners = (node) => {
    const counted = [...(kept.get(node) ?? [])].filter(([, list]) => list.length).map(([type, list]) => `${type}:${list.length}`);
    for (const handler of handlers) if (typeof node[handler] === 'function') counted.push(handler);
    return counted.sort().join(',');
  };
  const pathOf = (node) => {
    if (!node || node === document.body) return 'body';
    if (node === document.documentElement) return 'html';
    const steps = [];
    for (let at = node; at && at.nodeType === 1 && at !== document.body; at = at.parentElement) {
      const same = at.parentElement ? [...at.parentElement.children].filter((other) => other.tagName === at.tagName) : [at];
      steps.unshift(`${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ''}${[...at.classList].map((cls) => `.${cls}`).join('')}${same.length > 1 ? `:${same.indexOf(at) + 1}` : ''}`);
    }
    return steps.join(' > ');
  };
  let changed = 0;
  const watch = () => { new MutationObserver(() => { changed = performance.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); };
  if (document.documentElement) watch(); else document.addEventListener('readystatechange', watch, { once: true });
  window[name] = {
    /** @param {{ roots: string[], skip: string[] }} asked @returns {{ shape: string[], focus: string }} */
    read(asked) {
      const shape = [];
      const skipped = (node) => asked.skip.some((selector) => node.matches(selector));
      for (const selector of asked.roots) {
        const found = [...document.querySelectorAll(selector)];
        shape.push(`== ${selector}: ${found.length}`);
        for (const root of found) shape.push(...lines(root, { listeners, skip: skipped, depth: 1 }));
      }
      return { shape, focus: pathOf(document.activeElement) };
    },
    /** @returns {number} how long ago the page last changed, in ms */
    quietFor: () => performance.now() - changed,
  };
}

/** @returns {string} the script a page of the check starts with */
export function initScript() {
  return `(${installInPage.toString()})(${JSON.stringify(PAGE_NAME)}, ${shapeLines.toString()}, ${JSON.stringify(PROPERTY_HANDLERS)});`;
}
