// After a move out of a file, takes out the blank lines the move left doubled or at the end of
// the file: a blank line that now follows another blank line, or the start of the file, only
// because the lines between them went. Pure: the old text and a plan in, a plan out.

const blank = (line) => line.trim() === '';

/**
 * @param {string} before the old file
 * @param {any} plan a plan of extract-plan.mjs, as dead-requires.mjs may have left it
 * @returns {any} the same plan when no blank line is to go, or when the plan cannot be put together again from its
 *   parts (then nothing is tidied); else one whose `newSource` is without them, with `glue.sourceAt` and every
 *   edit's `at` counted again, and `glue.blanks`: the 0-based lines of the old file that went
 */
export function tidyPlan(before, plan) {
  const old = before.split('\n');
  const { sourceFirst, sourceLines, edits = [] } = plan.glue;
  if (sourceFirst === undefined || edits.some((edit) => edit.first === undefined)) return plan;
  const gone = new Set();
  for (const [first, last] of plan.ranges) for (let line = first; line <= last; line += 1) gone.add(line - 1);
  const whole = new Set(gone); // lines that went and left nothing in their place
  const editAt = new Map(edits.map((edit) => [edit.first, edit]));
  for (const edit of edits) {
    for (let i = 0; i < edit.oldLines.length; i += 1) {
      gone.add(edit.first + i);
      if (edit.newLines.length === 0) whole.add(edit.first + i);
    }
  }

  // The file put together again from the plan's parts, the way extract-plan.mjs does it.
  const build = (tidy) => {
    const kept = [];
    const blanks = [];
    const at = new Map();
    let sourceAt = -1;
    let wentAbove = false; // the line just above in the old file went, whole
    const put = (lines) => { if (lines.length) { kept.push(...lines); wentAbove = false; } };
    old.forEach((line, index) => {
      if (index === sourceFirst) { sourceAt = kept.length; put(sourceLines); }
      const edit = editAt.get(index);
      if (edit) { at.set(edit, kept.length); put(edit.newLines); }
      if (gone.has(index)) { wentAbove = whole.has(index); return; }
      // The line after the last line break counts: dropping it is dropping the blank line above it.
      if (tidy && wentAbove && blank(line) && (kept.length === 0 || blank(kept.at(-1)))) { blanks.push(index); return; }
      put([line]);
    });
    return { text: kept.join('\n'), blanks, at, sourceAt };
  };

  if (build(false).text !== plan.newSource) return plan;
  const tidied = build(true);
  if (tidied.blanks.length === 0) return plan;
  return { ...plan, newSource: tidied.text,
    glue: { ...plan.glue, sourceAt: tidied.sourceAt, blanks: tidied.blanks, edits: edits.map((edit) => ({ ...edit, at: tidied.at.get(edit) })) } };
}
