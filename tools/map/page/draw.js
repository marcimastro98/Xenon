// Small DOM helpers. Text always goes in as text, never as markup.

/**
 * @param {string} tag
 * @param {Record<string, any> | null} attrs
 * @param {...any} kids
 */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'hue') el.style.setProperty('--h', String(value));
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false || kid === '') continue;
    el.append(kid.nodeType ? kid : String(kid));
  }
  return el;
}

let saidTimer = 0;
/** A short line at the bottom of the screen. @param {string} text */
function sayBriefly(text) {
  const box = document.getElementById('said');
  box.textContent = text;
  clearTimeout(saidTimer);
  saidTimer = setTimeout(() => { box.textContent = ''; }, 2200);
}

/** @param {string} text */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    sayBriefly(t('copied', text));
  } catch {
    sayBriefly(t('copyFailed'));
  }
}

/** Highlights the words that matched, as text nodes. @param {string} text @param {string[]} terms */
function marked(text, terms) {
  const frag = document.createDocumentFragment();
  const lower = text.toLowerCase();
  let i = 0;
  while (i < text.length) {
    let hit = null;
    for (const term of terms) {
      const at = lower.indexOf(term, i);
      if (at >= 0 && (!hit || at < hit.at)) hit = { at, len: term.length };
    }
    if (!hit) { frag.append(text.slice(i)); break; }
    if (hit.at > i) frag.append(text.slice(i, hit.at));
    frag.append(h('mark', null, text.slice(hit.at, hit.at + hit.len)));
    i = hit.at + hit.len;
  }
  return frag;
}

/** Restarts the highlight on an element. @param {Element} el */
function flash(el) {
  el.classList.remove('flash');
  void el.getBoundingClientRect();
  el.classList.add('flash');
}
