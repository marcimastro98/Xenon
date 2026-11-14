// Turns the AI's answer into safe markup: escaped text, links with an allowed scheme, emphasis,
// lists and code.
'use strict';

// ── Markdown rendering ────────────────────────────────────────────
// Converts AI markdown to safe HTML for assistant chat bubbles.
// Only used for assistant messages — user text is always escaped.

function _escHtmlAI(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Only http(s) and mailto links are rendered as anchors. Assistant output can be
// influenced by untrusted content (vision/screen captures, media metadata, tool
// results), so a `javascript:`/`data:` URL must never become a live href — a
// single tap would run arbitrary JS in the dashboard origin. Anything else is
// shown as plain label text instead of a clickable link.
function _aiSafeLinkScheme(url) {
  // url is already HTML-escaped here; unescape the entity a scheme could hide in
  // before testing, so `java&#115;cript:` can't slip past the check.
  const probe = String(url).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&').trim().toLowerCase();
  return /^(https?:|mailto:)/.test(probe);
}

// Bold, italic and inline code, in that order (no nesting to keep it simple).
function _inlineEmphasis(html) {
  return html
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');
}

function _inlineMarkdown(line) {
  // Links are taken out BEFORE the emphasis pass and put back after it. The
  // other way round, a code span or an underscore inside a link's URL became
  // markup — `<code class="…">` has quotes of its own — inside href="…", which
  // let assistant text (and whatever page or file it was quoting) add
  // attributes to the anchor. A URL ends at whitespace or ")" and never
  // contains a quote or angle bracket; only the label gets emphasis.
  const links = [];
  const text = _escHtmlAI(String(line == null ? '' : line).replace(/\u0000/g, ''))
    .replace(/\[([^\]]+)\]\(([^)\s"<>]+)\)/g, (_full, label, url) => {
      links.push(_aiSafeLinkScheme(url)
        ? `<a href="${url}" target="_blank" rel="noopener" class="ai-link">${_inlineEmphasis(label)}</a>`
        : `${_inlineEmphasis(label)} (${url})`);
      return `\u0000${links.length - 1}\u0000`;
    });
  return _inlineEmphasis(text).replace(/\u0000(\d+)\u0000/g, (_m, i) => links[Number(i)]);
}

function _aiRenderMarkdown(raw) {
  const lines = String(raw || '').split('\n');
  const out = [];
  let inList = false;
  let inOrderedList = false;

  const closeList = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Horizontal rule
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr class="ai-hr">'); continue; }

    // Headers
    const h4 = line.match(/^####\s+(.*)/);
    if (h4) { closeList(); out.push(`<h4 class="ai-h4">${_inlineMarkdown(h4[1])}</h4>`); continue; }
    const h3 = line.match(/^###\s+(.*)/);
    if (h3) { closeList(); out.push(`<h3 class="ai-h3">${_inlineMarkdown(h3[1])}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) { closeList(); out.push(`<h2 class="ai-h3">${_inlineMarkdown(h2[1])}</h2>`); continue; }

    // Unordered list
    const ul = line.match(/^[-*+]\s+(.*)/);
    if (ul) {
      if (inOrderedList) { out.push('</ol>'); inOrderedList = false; }
      if (!inList) { out.push('<ul class="ai-ul">'); inList = true; }
      out.push(`<li>${_inlineMarkdown(ul[1])}</li>`);
      continue;
    }

    // Ordered list
    const ol = line.match(/^\d+\.\s+(.*)/);
    if (ol) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (!inOrderedList) { out.push('<ol class="ai-ol">'); inOrderedList = true; }
      out.push(`<li>${_inlineMarkdown(ol[1])}</li>`);
      continue;
    }

    closeList();

    // Blank line → paragraph break
    if (line.trim() === '') { out.push('<br>'); continue; }

    // Regular paragraph line
    out.push(`<p class="ai-p">${_inlineMarkdown(line)}</p>`);
  }

  closeList();
  return out.join('');
}
