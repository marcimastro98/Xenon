// Names the code builds at runtime: `edge-${look}.webp`, 'deck_err_' + code,
// id + '_title'. Each becomes a regex over a bare name, so a file or a string key
// that no literal mentions can come back as "maybe" (with the pattern and where
// it was seen) instead of "unused".

const HOLE = '\u0000';
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `nameChars` is the body of a regex character class (what a name may contain).
// `minStatic` is how many fixed characters a pattern needs to be worth keeping:
// `${a}${b}` would match everything. With `ignoreExt`, a trailing `.webp` does
// not count as fixed text, so `${name}.png` is not taken as a pattern.
export function builtNamePatterns(texts, { nameChars, minStatic = 2, ignoreExt = false }) {
  const run = new RegExp(`[${HOLE}${nameChars}]+`, 'g');
  const lead = new RegExp(`^[${nameChars}]+`);
  const trail = new RegExp(`[${nameChars}]+$`);
  const any = `[${nameChars}]*`;
  // Punctuation alone (`${y}-${m}-${d}`) fixes nothing: a letter or digit must be there too.
  const fixedLength = (piece) => {
    const fixed = piece.split(HOLE).join('');
    const kept = ignoreExt ? fixed.replace(/\.[A-Za-z0-9]{2,5}$/, '') : fixed;
    return /[A-Za-z0-9]/.test(kept) ? kept.length : 0;
  };
  const found = new Map();
  const add = (source, rel) => { if (!found.has(source)) found.set(source, rel); };

  for (const [rel, text] of texts) {
    for (const m of text.matchAll(/`((?:[^`\\]|\\.)*)`/g)) {
      if (!m[1].includes('${')) continue;
      const flat = m[1].replace(/\$\{[^{}`]*\}/g, HOLE);
      for (const r of flat.matchAll(run)) {
        if (!r[0].includes(HOLE) || fixedLength(r[0]) < minStatic) continue;
        add(`^${r[0].split(HOLE).map(escapeRe).join(any)}$`, rel);
      }
    }
    // A literal joined with + is a prefix or a suffix. One that ends with - or _
    // is a prefix wherever it stands ((amb ? 'amb-' : 'edge-') + id), and one
    // that starts with - or _ a suffix.
    for (const m of text.matchAll(/(['"`])([^'"`\n\\]*)\1(\s*\+)?/g)) {
      const t = trail.exec(m[2]);
      if (t && (m[3] || /[-_]$/.test(t[0])) && fixedLength(t[0]) >= minStatic) add(`^${escapeRe(t[0])}`, rel);
    }
    for (const m of text.matchAll(/(\+\s*)?(['"`])([^'"`\n\\]*)\2/g)) {
      const l = lead.exec(m[3]);
      if (l && (m[1] || /^[-_]/.test(l[0])) && fixedLength(l[0]) >= minStatic) add(`${escapeRe(l[0])}$`, rel);
    }
  }
  return [...found].map(([source, example]) => ({ re: new RegExp(source), source, example }));
}
