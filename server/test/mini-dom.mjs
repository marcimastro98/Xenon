// A DOM small enough to read, big enough to run a client module.
//
// NOT a test file (the runner's glob is *.test.mjs). It exists because the
// client modules in server/js/ had almost no render coverage, and the bugs that
// were reaching users were render bugs: a button that drew empty, a control
// offered on a surface that refuses it, a dialog painted see-through. `node
// --check` passes on all of those, and the server-side unit tests cannot see
// them. call-modal-render.test.mjs made the case first, with its own private
// copy of roughly this; a second copy is where it got shared instead.
//
// It is deliberately partial. It implements what these modules actually touch
// and nothing else, so it stays readable — if a module needs more, add it here
// rather than reaching for a full browser emulation.

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function makeDom() {
  const observersFor = new Map();   // node -> [callback]

  function notify(node) {
    const cbs = observersFor.get(node);
    if (cbs) cbs.forEach((cb) => cb());
  }

  function mkEl(tag, ns) {
    const node = {
      tag,
      tagName: String(tag).toUpperCase(),
      namespaceURI: ns || null,
      id: '',
      className: '',
      attrs: Object.create(null),
      children: [],
      parentNode: null,
      _text: '',
      _hidden: false,
      _handlers: Object.create(null),
      // Custom properties are readable, because some of them ARE the contract:
      // phone-view.js publishes the dock's measured height as --ph-dock-h and
      // the CSS that keeps toasts off the bar reads it.
      style: {
        _props: Object.create(null),
        setProperty(k, v) { this._props[k] = String(v); },
        removeProperty(k) { delete this._props[k]; },
        getPropertyValue(k) { return this._props[k] || ''; },
      },
      // No layout engine here, so a box is whatever a test says it is. Zero by
      // default: code that measures must cope with "not laid out yet", which is
      // the state a real element is in for the first frame.
      _rect: { width: 0, height: 0 },
      dataset: Object.create(null),
      type: '',
      title: '',
      value: '',
      rows: 0,
      maxLength: 0,
      placeholder: '',
      disabled: false,
    };
    Object.defineProperty(node, 'hidden', {
      get() { return node._hidden; },
      set(v) { node._hidden = !!v; notify(node); },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return node._text + node.children.map((c) => c.textContent).join(''); },
      set(v) { node._text = String(v); node.children = []; },
    });
    Object.defineProperty(node, 'innerHTML', {
      // Enough to satisfy modules that inject their own static, trusted markup.
      // The CONTENT is not parsed: no test here asserts on it, and pretending to
      // parse HTML would be the point where this stops being readable.
      get() { return node._html || ''; },
      set(v) { node._html = String(v); },
    });
    node.classList = {
      add: (...c) => { node.className = [...new Set(node.className.split(/\s+/).filter(Boolean).concat(c))].join(' '); },
      remove: (...c) => { node.className = node.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(' '); },
      contains: (c) => node.className.split(/\s+/).includes(c),
      toggle: (c, on) => (on ? node.classList.add(c) : node.classList.remove(c)),
    };
    node.setAttribute = (k, v) => {
      node.attrs[k] = String(v);
      if (k === 'class') node.className = String(v);
      if (k === 'id') node.id = String(v);
      notify(node);
    };
    node.getAttribute = (k) => (k in node.attrs ? node.attrs[k] : null);
    node.removeAttribute = (k) => { delete node.attrs[k]; if (k === 'id') node.id = ''; };
    node.hasAttribute = (k) => k in node.attrs;
    node.appendChild = (child) => {
      if (child && child._isFragment) { child.children.slice().forEach(node.appendChild); return child; }
      if (child.parentNode) child.remove();
      child.parentNode = node;
      node.children.push(child);
      return child;
    };
    node.append = (...kids) => kids.forEach(node.appendChild);
    node.remove = () => {
      if (!node.parentNode) return;
      const at = node.parentNode.children.indexOf(node);
      if (at >= 0) node.parentNode.children.splice(at, 1);
      node.parentNode = null;
    };
    node.addEventListener = (type, fn) => { (node._handlers[type] ||= []).push(fn); };
    node.removeEventListener = (type, fn) => {
      const list = node._handlers[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    };
    /** Fire a handler the way a tap would, including a usable event object. */
    node.click = () => (node._handlers.click || []).forEach((fn) => fn({
      stopPropagation() {}, preventDefault() {}, target: node,
    }));
    node.closest = (sel) => {
      let n = node;
      while (n) { if (matches(n, sel)) return n; n = n.parentNode; }
      return null;
    };
    node.cloneNode = () => {
      const copy = mkEl(node.tag, node.namespaceURI);
      copy.className = node.className;
      copy.id = node.id;
      Object.assign(copy.attrs, node.attrs);
      copy._text = node._text;
      node.children.forEach((c) => copy.appendChild(c.cloneNode(true)));
      return copy;
    };
    node.getBoundingClientRect = () => ({
      width: node._rect.width, height: node._rect.height,
      top: 0, left: 0, right: node._rect.width, bottom: node._rect.height, x: 0, y: 0,
    });
    node.querySelector = (sel) => find(node, sel)[0] || null;
    node.querySelectorAll = (sel) => find(node, sel);
    return node;
  }

  // Descendant selectors of class / tag / #id / [attr] / [attr="v"] tokens.
  // Enough for every selector these modules use, and small enough to read.
  function matches(node, part) {
    const tokens = part.match(/\[[^\]]+\]|[.#]?[\w-]+/g) || [];
    return tokens.every((tk) => {
      if (tk[0] === '[') {
        const m = tk.slice(1, -1).match(/^([\w-]+)(?:=["']?([^"']*)["']?)?$/);
        if (!m) return false;
        const have = node.getAttribute(m[1]);
        return m[2] === undefined ? have !== null : have === m[2];
      }
      if (tk[0] === '.') return node.classList.contains(tk.slice(1));
      if (tk[0] === '#') return node.id === tk.slice(1);
      return node.tagName === tk.toUpperCase();
    });
  }
  function descendants(node, out = []) {
    node.children.forEach((c) => { out.push(c); descendants(c, out); });
    return out;
  }
  function find(root, sel) {
    // Comma-separated selector lists are not supported on purpose: none of the
    // modules under test use one, and half-supporting it would return a wrong
    // answer rather than an obvious failure.
    const parts = sel.trim().split(/\s+/);
    let scope = [root];
    for (const part of parts) {
      const next = [];
      scope.forEach((n) => descendants(n).forEach((d) => { if (matches(d, part) && !next.includes(d)) next.push(d); }));
      scope = next;
    }
    return scope;
  }

  const documentElement = mkEl('html');
  const body = mkEl('body');
  documentElement.appendChild(body);

  const document = {
    documentElement,
    body,
    readyState: 'complete',
    createElement: (t) => mkEl(t),
    createElementNS: (ns, t) => mkEl(t, ns),
    createDocumentFragment: () => {
      const f = mkEl('#fragment');
      f._isFragment = true;
      return f;
    },
    querySelector: (s) => find(documentElement, s)[0] || null,
    querySelectorAll: (s) => find(documentElement, s),
    getElementById: (id) => descendants(documentElement).find((n) => n.id === id) || null,
    addEventListener() {},
    removeEventListener() {},
  };

  class MutationObserver {
    constructor(cb) { this.cb = cb; this.targets = []; }
    observe(target) {
      this.targets.push(target);
      if (!observersFor.has(target)) observersFor.set(target, []);
      observersFor.get(target).push(this.cb);
    }
    disconnect() {
      this.targets.forEach((tgt) => {
        const cbs = observersFor.get(tgt) || [];
        const at = cbs.indexOf(this.cb);
        if (at >= 0) cbs.splice(at, 1);
      });
      this.targets = [];
    }
  }

  // Nothing is ever laid out here, so a resize never happens on its own: the
  // test sets an element's `_rect` and calls fireResize(). That keeps "the
  // observer is wired up" and "it recomputes when the box changes" as two
  // separate, checkable facts.
  const resizeWatchers = [];
  class ResizeObserver {
    constructor(cb) { this.cb = cb; }
    observe(target) { resizeWatchers.push({ cb: this.cb, target }); }
    disconnect() {
      for (let i = resizeWatchers.length - 1; i >= 0; i--) {
        if (resizeWatchers[i].cb === this.cb) resizeWatchers.splice(i, 1);
      }
    }
  }
  const resizeTargets = () => resizeWatchers.map((w) => w.target);
  const fireResize = () => resizeWatchers.slice().forEach((w) => w.cb([]));

  return {
    document, mkEl, matches, descendants,
    MutationObserver, observersFor,
    ResizeObserver, resizeTargets, fireResize,
  };
}

/** Let queued promise callbacks run — the modules load their data with await. */
export const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
