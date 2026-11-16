// SDK block parts — the host-drawn pieces a widget's island, mini slot and badge
// are built from: icons (a glyph, a named icon from the app's library, or the
// widget's own path), text and bars in the widget's colour and size, Vitals-like
// meters, and the detail card a meter opens.
//
// Every value arrives already normalized by SdkIslandSchema (sdk-island-schema.js):
// colours are plain hex, a path is path commands and numbers only, a name is an
// id. Nodes are built with createElement / createElementNS and textContent, so
// nothing a widget sends is ever parsed as markup. Colours and sizes travel as
// CSS custom properties on the node, never as a style string.
(() => {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const t = (key, fallback) => (typeof window.t === 'function' ? window.t(key) : fallback);

  function setColor(node, color) {
    if (color) node.style.setProperty('--sdk-part-color', color);
  }

  function sizeClass(size) {
    return size === 'small' || size === 'large' ? ` is-${size}` : '';
  }

  // The widget's path wins (it is the most specific), then a library icon, then
  // the glyph — so a widget can send a glyph as the fallback for an older Xenon
  // or for a name this Xenon does not know.
  function iconNode(src, className) {
    const node = document.createElement('span');
    node.className = className;
    if (src.path) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', src.path);
      svg.appendChild(path);
      node.appendChild(svg);
      return node;
    }
    const lib = src.name && window.DeckIcons && typeof window.DeckIcons.el === 'function' ? window.DeckIcons.el(src.name) : null;
    if (lib) node.appendChild(lib);
    else node.textContent = src.text || '';
    return node;
  }

  function text(block) {
    const node = document.createElement('span');
    const tone = ['muted', 'accent', 'success', 'warning', 'danger'].includes(block.tone) ? ` tone-${block.tone}` : '';
    node.className = `sdk-island-text${tone}${block.weight === 'strong' ? ' is-strong' : ''}`
      + `${block.maxLines === 2 ? ' two-lines' : ''}${sizeClass(block.size)}${block.color ? ' has-color' : ''}`;
    node.textContent = block.text;
    setColor(node, block.color);
    return node;
  }

  function icon(block) {
    const node = iconNode(block, `sdk-island-icon${sizeClass(block.size)}`);
    if (block.color) node.style.color = block.color;
    return node;
  }

  function progress(block) {
    const node = document.createElement('span');
    node.className = `sdk-island-progress${block.orientation === 'vertical' ? ' is-vertical' : ''}`;
    if (block.width) node.style.setProperty('--sdk-bar-w', `${block.width}px`);
    if (block.height) node.style.setProperty('--sdk-bar-h', `${block.height}px`);
    setColor(node, block.color);
    const fill = document.createElement('span');
    fill.style.setProperty('--sdk-bar-level', String(block.value));
    node.appendChild(fill);
    return node;
  }

  // A meter is pressable when it has something to do: its own action id, its
  // detail card, or both (the card opens and the widget is told).
  function meter(block, onAction) {
    const pressable = !!(block.id || block.detail);
    const node = document.createElement(pressable ? 'button' : 'span');
    node.className = `sdk-meter${sizeClass(block.size)}`;
    setColor(node, block.color);
    const stack = document.createElement('span');
    stack.className = 'sdk-meter-stack';
    if (block.text || block.name || block.path) stack.appendChild(iconNode(block, 'sdk-meter-ico'));
    const bar = document.createElement('span');
    bar.className = 'sdk-meter-bar';
    const fill = document.createElement('span');
    fill.style.setProperty('--sdk-bar-level', String(block.value));
    bar.appendChild(fill);
    stack.appendChild(bar);
    node.appendChild(stack);
    if (block.label) {
      const label = document.createElement('span');
      label.className = 'sdk-meter-label';
      label.textContent = block.label;
      node.appendChild(label);
    }
    if (!pressable) return node;
    node.type = 'button';
    if (block.detail?.title) node.setAttribute('aria-label', block.detail.title);
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      if (block.detail) openDetail(block.detail, block, node);
      if (block.id && typeof onAction === 'function') onAction(block.id);
    });
    return node;
  }

  // ── detail card ──
  let open = null;   // { overlay, onKey, returnTo }

  function closeDetail() {
    if (!open) return;
    document.removeEventListener('keydown', open.onKey);
    open.overlay.remove();
    if (open.returnTo?.isConnected) open.returnTo.focus();
    open = null;
  }

  function detailRow(row) {
    const node = document.createElement('div');
    node.className = 'sdk-detail-row';
    setColor(node, row.color);
    if (row.text || row.name || row.path) {
      node.appendChild(iconNode(row, 'sdk-detail-ico'));
      node.classList.add('has-ico');
    }
    const label = document.createElement('span');
    label.className = 'sdk-detail-label';
    label.textContent = row.label;
    const value = document.createElement('span');
    value.className = 'sdk-detail-value';
    value.textContent = row.value;
    node.append(label, value);
    if (typeof row.progress === 'number') {
      node.appendChild(progress({ value: row.progress, color: row.color }));
      node.classList.add('has-bar');
    }
    return node;
  }

  function detailHead(detail, owner) {
    const head = document.createElement('div');
    head.className = 'sdk-detail-head';
    if (owner && (owner.text || owner.name || owner.path)) head.appendChild(iconNode(owner, 'sdk-detail-ico'));
    const title = document.createElement('h2');
    title.className = 'sdk-detail-title';
    title.id = 'sdk-detail-title';
    title.textContent = detail.title;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'sdk-detail-close';
    close.setAttribute('aria-label', t('close', 'Close'));
    close.textContent = '✕';
    close.addEventListener('click', closeDetail);
    head.append(title, close);
    return head;
  }

  function openDetail(detail, owner, returnTo) {
    closeDetail();
    const overlay = document.createElement('div');
    overlay.className = 'sdk-detail-overlay';
    const card = document.createElement('div');
    card.className = 'sdk-detail-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    if (detail.title) card.setAttribute('aria-labelledby', 'sdk-detail-title');
    setColor(card, owner?.color);
    card.appendChild(detailHead(detail, owner));
    if (detail.rows.length) {
      const rows = document.createElement('div');
      rows.className = 'sdk-detail-rows';
      rows.append(...detail.rows.map(detailRow));
      card.appendChild(rows);
    }
    if (detail.note) {
      const note = document.createElement('p');
      note.className = 'sdk-detail-note';
      note.textContent = detail.note;
      card.appendChild(note);
    }
    overlay.appendChild(card);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeDetail(); });
    const onKey = (event) => { if (event.key === 'Escape') closeDetail(); };
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    open = { overlay, onKey, returnTo: returnTo || null };
    const close = card.querySelector('.sdk-detail-close');
    if (close) close.focus();
  }

  // One entry point for the parts this file owns; anything else returns null and
  // the caller (sdk-island.js renderBlock) draws it.
  function render(block, onAction) {
    if (block.type === 'text') return text(block);
    if (block.type === 'icon') return icon(block);
    if (block.type === 'progress') return progress(block);
    if (block.type === 'meter') return meter(block, onAction);
    return null;
  }

  window.SdkBlockRender = { render, iconNode, openDetail, closeDetail };
})();
