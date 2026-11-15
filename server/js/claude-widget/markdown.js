// Markdown as elements for the Claude tile: fenced code, headings, lists, inline code, bold and
// italic, every piece set as text.
'use strict';

(() => {
  const { el } = window.ClaudeWidgetLines;

  // ── markdown, as DOM ───────────────────────────────────────────────────────
  // Claude writes markdown, and showing it raw is how the panel ended up full of
  // asterisks and backticks. This builds NODES rather than an HTML string: every
  // piece of the transcript reaches the page through textContent, so there is no
  // parse step for a crafted tool result or a filename to aim at. It covers what
  // actually turns up in these messages — fenced code, headings, lists, inline
  // code, bold and italic — and anything it does not know stays plain text,
  // which reads fine.
  const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|__[^_]+__|_[^_\n]+_)/;

  function inlineInto(node, text) {
    const parts = String(text).split(INLINE_RE);
    parts.forEach(p => {
      if (!p) return;
      if (p.length > 2 && p.charAt(0) === '`' && p.charAt(p.length - 1) === '`') {
        node.appendChild(el('code', 'cw-md-code', p.slice(1, -1)));
      } else if (p.length > 4 && (p.startsWith('**') || p.startsWith('__'))) {
        node.appendChild(el('strong', '', p.slice(2, -2)));
      } else if (p.length > 2 && (p.charAt(0) === '*' || p.charAt(0) === '_')) {
        node.appendChild(el('em', '', p.slice(1, -1)));
      } else {
        node.appendChild(document.createTextNode(p));
      }
    });
    return node;
  }

  function markdownInto(box, raw) {
    const lines = String(raw || '').split('\n');
    let list = null;
    let fence = null;
    const endList = () => { list = null; };

    lines.forEach(line => {
      const fenceMark = /^\s*```(.*)$/.exec(line);
      if (fenceMark) {
        if (fence) { fence = null; }
        else { endList(); fence = el('pre', 'cw-md-pre'); box.appendChild(fence); }
        return;
      }
      if (fence) {
        fence.appendChild(document.createTextNode((fence.childNodes.length ? '\n' : '') + line));
        return;
      }

      const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        endList();
        box.appendChild(inlineInto(el('div', 'cw-md-h'), heading[2]));
        return;
      }
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        if (!list) { list = el('div', 'cw-md-list'); box.appendChild(list); }
        const item = el('div', 'cw-md-li');
        item.appendChild(el('span', 'cw-md-bullet', numbered ? numbered[1] + '.' : '•'));
        // The inline pieces go inside ONE text box, not straight into the item.
        // The item is a flex row, so appending them to it made every <strong>
        // and <code> its own flex COLUMN — which is why a bolded lead-in ended
        // up stacked in a narrow strip beside the rest of its own sentence.
        const body = el('div', 'cw-md-litext');
        inlineInto(body, bullet ? bullet[1] : numbered[2]);
        item.appendChild(body);
        list.appendChild(item);
        return;
      }
      endList();
      if (!line.trim()) return;                    // blank lines become the gap
      box.appendChild(inlineInto(el('div', 'cw-md-p'), line));
    });
    // An unterminated fence still shows its contents rather than swallowing the
    // rest of the message.
    return box;
  }

  window.ClaudeWidgetMarkdown = { markdownInto };
})();
