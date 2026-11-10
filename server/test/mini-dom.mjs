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
      // No scroller here, but modules carry a scroll position across a repaint,
      // which is a real behaviour worth being able to assert on.
      scrollTop: 0,
    };
    // Reachability from the document root: modules use it to decide whether a
    // node they are holding is still the one on screen.
    Object.defineProperty(node, 'isConnected', {
      get() {
        let n = node;
        while (n.parentNode) n = n.parentNode;
        return n === documentElement;
      },
    });
    Object.defineProperty(node, 'parentElement', { get() { return node.parentNode; } });
    // No layout here: a node counts as laid out when nothing above it is hidden.
    Object.defineProperty(node, 'offsetParent', {
      get() {
        for (let n = node; n; n = n.parentNode) if (n.hidden) return null;
        return node.parentNode;
      },
    });
    Object.defineProperty(node, 'hidden', {
      get() { return node._hidden; },
      set(v) { node._hidden = !!v; notify(node); },
    });
    Object.defineProperty(node, 'textContent', {
      get() { return node._text + node.children.map((c) => c.textContent).join(''); },
      set(v) { node._text = String(v); node.children = []; },
    });
    // Elements only (there are no text nodes here), enough for a `while
    // (from.firstChild) to.appendChild(from.firstChild)` move.
    Object.defineProperty(node, 'firstChild', { get() { return node.children[0] || null; } });
    Object.defineProperty(node, 'lastElementChild', { get() { return node.children[node.children.length - 1] || null; } });
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
    // dataset and data-* are one thing in the DOM.
    node.getAttribute = (k) => {
      if (k in node.attrs) return node.attrs[k];
      const key = k.startsWith('data-') ? k.slice(5).replace(/-(\w)/g, (_, ch) => ch.toUpperCase()) : '';
      return key in node.dataset ? node.dataset[key] : null;
    };
    node.removeAttribute = (k) => { delete node.attrs[k]; if (k === 'id') node.id = ''; };
    // Inclusive, as in the DOM.
    node.contains = (other) => {
      for (let n = other; n; n = n.parentNode) if (n === node) return true;
      return false;
    };
    node.hasAttribute = (k) => k in node.attrs;
    node.toggleAttribute = (k, on) => { if (on) node.setAttribute(k, ''); else node.removeAttribute(k); return !!on; };
    node.appendChild = (child) => {
      if (child && child._isFragment) { child.children.slice().forEach(node.appendChild); return child; }
      if (child.parentNode) child.remove();
      child.parentNode = node;
      node.children.push(child);
      return child;
    };
    // A string is text, as in the DOM; order against the child nodes is not kept.
    node.append = (...kids) => kids.forEach((k) => { if (typeof k === 'string') node._text += k; else node.appendChild(k); });
    node.insertBefore = (child, ref) => {
      if (!ref) return node.appendChild(child);
      if (child.parentNode) child.remove();
      child.parentNode = node;
      node.children.splice(node.children.indexOf(ref), 0, child);
      return child;
    };
    node.prepend = (...kids) => kids.slice().reverse().forEach((k) => node.insertBefore(k, node.children[0] || null));
    node.replaceChildren = (...kids) => {
      node.children.slice().forEach((c) => c.remove());
      node._text = '';
      kids.forEach(node.appendChild);
    };
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
    // A list is "any of these compound selectors": perf-widget.js looks for
    // '.pager-page, .layer-slot'.
    node.closest = (sel) => {
      const parts = sel.split(',').map((p) => p.trim());
      let n = node;
      while (n) { if (parts.some((p) => matches(n, p))) return n; n = n.parentNode; }
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
    node.focus = () => { document.activeElement = node; };
    node.blur = () => { if (document.activeElement === node) document.activeElement = document.body; };
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
    // A list answers in document order, as the DOM does.
    if (sel.includes(',')) {
      const hit = new Set(sel.split(',').flatMap((one) => find(root, one)));
      return descendants(root).filter((d) => hit.has(d));
    }
    // `:scope > x` is a direct child of the node asked.
    const direct = sel.trim().match(/^:scope\s*>\s*(.+)$/);
    if (direct) return root.children.filter((c) => matches(c, direct[1]));
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
    // Nothing takes focus on its own here; a module that preserves the caret
    // across a repaint reads this and must cope with "nothing is focused".
    activeElement: null,
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
    _handlers: Object.create(null),
    addEventListener(type, fn) { (this._handlers[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      const list = this._handlers[type] || [];
      const at = list.indexOf(fn);
      if (at >= 0) list.splice(at, 1);
    },
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
// A rig's window that takes key listeners. The list comes back so the rig can press keys.
export function windowKeys(window) {
  const handlers = [];
  window.addEventListener = (type, fn) => { if (type === 'keydown') handlers.push(fn); };
  window.removeEventListener = (type, fn) => {
    const at = handlers.indexOf(fn);
    if (type === 'keydown' && at >= 0) handlers.splice(at, 1);
  };
  return handlers;
}

export const settle = async (turns = 8) => { for (let i = 0; i < turns; i++) await Promise.resolve(); };
