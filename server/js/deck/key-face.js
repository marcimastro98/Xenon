// The face of a deck key: its icon as a built-in drawing, a picture or an emoji, the face it wears
// while its state is on, the face of each step of a cycle key, and the colour of its label.
'use strict';

(() => {
  // Only allow image icons from schemes that cannot run script: remote images,
  // inline data images, and object URLs. Anything else falls back to a glyph.
  function safeIconSrc(value) {
    const v = String(value || '').trim();
    return (/^https?:\/\//i.test(v) || /^data:image\//i.test(v) || /^blob:/i.test(v)) ? v : '';
  }

  // Swap a key's face to its alternate ON style (icon glyph / label / accent)
  // and restore the original losslessly when the state turns off. The base
  // icon's real nodes are parked in a fragment (never rebuilt from strings), so
  // image/builtin faces survive the round-trip; all text goes via textContent.
  // Fill a `.deck-ico` with the GLYPH forms of an icon: a built-in vector, a
  // compact picture, or an emoji. Shared by the base face (below) and by the
  // active face in applyStateStyle, so a state icon is built by the same code
  // that builds a normal one — the alternative was a second, drifting copy that
  // happened to support only text, which is exactly what it did support.
  //
  // Full-bleed pictures are deliberately not here: those restyle the whole cap
  // (`has-image` + the label scrim) rather than filling the glyph slot, and only
  // the base face does that. normalizeStateIcon stores an active-face picture as
  // 'small' for the same reason.
  function fillGlyphIcon(ico, icon) {
    ico.textContent = '';
    ico.classList.remove('is-builtin', 'is-img-small');
    const type = icon && icon.type;
    const src = type === 'image' ? safeIconSrc(icon.value) : '';
    if (src) {
      const img = document.createElement('img');
      img.draggable = false;
      img.src = src; img.alt = '';
      ico.classList.add('is-img-small');
      ico.appendChild(img);
      return true;
    }
    if (type === 'builtin' && window.DeckIcons && window.DeckIcons.has(icon.value)) {
      ico.classList.add('is-builtin');
      ico.appendChild(window.DeckIcons.el(icon.value));
      return true;
    }
    // Only an EMOJI is printed as text. Without that check the value of anything
    // that failed to render — an unknown built-in id, an image whose URL was
    // rejected — was written onto the cap as a word, so a key that should have
    // fallen back to its base face showed `javascript:alert(1)` instead. Harmless
    // as text (never markup, never fetched) and wrong in every other way. The base
    // face has always tested the type here; this is the same test.
    const text = (type === 'emoji' && icon && typeof icon.value === 'string') ? icon.value : '';
    if (!text) return false;
    ico.textContent = text;
    return true;
  }

  function applyStateStyle(node, on) {
    const ss = node._deckStateStyle;
    const base = node._ssBase;
    if (!ss || !base || on === node._ssApplied) return;
    node._ssApplied = on;
    if (ss.icon) {
      if (on && !base.iconFrag) {
        // Keep the base face's nodes rather than its markup: a built-in SVG or an
        // <img> has to come back exactly as it was, and remembering the classes
        // is what lets `is-builtin` / `is-img-small` be restored with it.
        base.iconFrag = document.createDocumentFragment();
        while (base.ico.firstChild) base.iconFrag.appendChild(base.ico.firstChild);
        base.iconClass = base.ico.className;
        if (!fillGlyphIcon(base.ico, ss.icon)) {
          // Nothing renderable (an unknown built-in id, a rejected image): put the
          // base face straight back rather than leaving the key blank.
          base.ico.className = base.iconClass;
          while (base.iconFrag.firstChild) base.ico.appendChild(base.iconFrag.firstChild);
          base.iconFrag = null;
        }
      } else if (!on && base.iconFrag) {
        base.ico.textContent = '';
        base.ico.className = base.iconClass || 'deck-ico';
        base.ico.appendChild(base.iconFrag);
        base.iconFrag = null;
      }
    }
    if (ss.label) base.labelEl.textContent = on ? ss.label : base.labelText;
    if (ss.color) {
      if (on) { node.classList.add('has-accent'); node.style.setProperty('--key-accent', ss.color); }
      else if (base.accent) { node.style.setProperty('--key-accent', base.accent); }
      else { node.style.removeProperty('--key-accent'); node.classList.remove('has-accent'); }
    }
    if (ss.color2 || (ss.color && base.accent2)) {
      // The lit face has its own gradient, or a plain colour that replaces the
      // base gradient; off restores whatever the base face had.
      const next = on ? (ss.color2 || '') : base.accent2;
      if (next) {
        node.classList.add('has-gradient');
        node.style.setProperty('--key-accent2', next);
        node.dataset.grad = (on ? '' : base.grad) || node.dataset.grad || 'd';
      } else {
        node.classList.remove('has-gradient');
        node.style.removeProperty('--key-accent2');
      }
    }
    if (ss.iconColor) {
      const c = on ? ss.iconColor : base.iconColor;
      base.ico.style.color = c;
      if (c) node.style.setProperty('--key-icon-color', c); else node.style.removeProperty('--key-icon-color');
    }
    if (ss.labelColor) setLabelColor(base.labelEl, on ? ss.labelColor : base.labelColor);
  }

  // Show a cycle key's state `index` (0 = its base face): back to the base face,
  // then the state's own face on top, and light that state's dot.
  function applyCycleFace(node, index) {
    const key = node._deckCycleKey;
    if (!key || node._cycleAt === index) return;
    applyStateStyle(node, false);
    node._deckStateStyle = index > 0 ? key.cycle[index - 1] : null;
    if (node._deckStateStyle) applyStateStyle(node, true);
    node._cycleAt = index;
    const pips = node.querySelectorAll(':scope > .deck-key-cycle > .pip');
    pips.forEach((p, i) => p.classList.toggle('is-at', i === index));
  }

  // The colour also goes in a variable: a cap style that inks its labels (Comic)
  // has to force its own colour, and reads this one first.
  function setLabelColor(label, c) {
    label.style.color = c || '';
    if (c) label.style.setProperty('--key-label-color', c); else label.style.removeProperty('--key-label-color');
  }

  window.DeckKeyFace = { safeIconSrc, applyStateStyle, applyCycleFace, setLabelColor };
})();
