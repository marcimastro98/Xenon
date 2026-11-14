// When moved code was the last user of a required name, the old file keeps a `require('x');` that
// stands alone, so that x still loads where it did (require-edits.mjs). This asks the rule of
// `bare` (bare-requires.mjs) about every such line a step leaves, and takes out the ones it proves
// dead: a move that leaves a dead line would need a second commit to tidy it.
//
// A line goes only when the rule says "dead" for the tree as it will be after the step. A line
// with a comment above it stays: the comment is about the require, and a person decides. One line
// is taken at a time and the rest are judged again without it. Pure: plans and texts in, a plan out.

import { judgeBareRequires } from './bare-requires.mjs';

const BARE_LINE = /^require\(\s*(['"])([^'"]+)\1\s*\);$/;
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
const specOf = (edit) => (edit.newLines.length === 1 ? BARE_LINE.exec(edit.newLines[0])?.[2] ?? null : null);

/** @param {{ glue: { edits?: { newLines: string[] }[] } }} plan @returns {boolean} the step leaves a require that stands alone */
export function leavesBare(plan) {
  return (plan.glue.edits ?? []).some((edit) => specOf(edit) !== null);
}

/**
 * @param {object} job
 * @param {any} job.plan a plan of extract-plan.mjs or inner-plan.mjs
 * @param {string} job.source the old file @param {string} job.target the new module, both repo-relative
 * @param {any} job.parser from parser.mjs
 * @param {string[]} job.files the server's files as they are, repo-relative
 * @param {(file: string) => string | null} job.read the text of a file as it is, null when there is none
 * @param {(file: string) => string} [job.real] the one name of a file that can be reached under two
 * @param {Map<string, any>} [job.known] what bare-requires.mjs read of each file, kept between calls
 * @param {string[]} [job.only] a recorded step redone: take exactly these, in this order, and say when one is not proven
 * @returns {{ plan: any, dropped: { spec: string, why: string }[], kept: { spec: string, why: string }[], problems: string[] }}
 *   `plan` is the same plan when nothing was taken. `kept`: the lines of this step that stay, each with the reason.
 */
export function dropDeadRequires({ plan, source, target, parser, files, read, real = (file) => file, known, only }) {
  if (!leavesBare(plan) && !only?.length) return { plan, dropped: [], kept: [], problems: [] };
  const lines = plan.newSource.split('\n');
  const edits = (plan.glue.edits ?? []).map((edit) => ({ ...edit }));
  const places = { sourceAt: plan.glue.sourceAt, bodyAt: plan.glue.bodyAt };
  const judged = real(source);
  const all = [...new Set([...files, source, target])];
  const left = () => edits.filter((edit) => specOf(edit) !== null);

  // What the rule says of each line this step leaves, for the tree as the step makes it.
  const verdicts = () => {
    const text = lines.join('\n');
    const { rows } = judgeBareRequires({ files: all, parser, real, known,
      read: (file) => (file === source || file === judged ? text : file === target ? plan.moduleText : read(file)) });
    const mine = new Map(rows.filter((row) => row.file === judged).map((row) => [row.line, row]));
    return (edit) => {
      if (COMMENT.test(lines[edit.at - 1] ?? '')) return { verdict: 'stays', why: 'the comment above it is about this require: a person decides' };
      return mine.get(edit.at + 1) ?? { verdict: 'stays', why: 'it was not read as a statement of its own' };
    };
  };
  const take = (edit) => {
    const gone = edit.at;
    const after = (line) => (line > gone ? line - 1 : line);
    lines.splice(gone, 1);
    edit.newLines = [];
    for (const other of edits) if (other !== edit) other.at = after(other.at);
    places.sourceAt = after(places.sourceAt);
    if (places.bodyAt !== undefined) places.bodyAt = after(places.bodyAt);
  };

  const dropped = [];
  const problems = [];
  let kept = [];
  if (only) {
    for (const spec of only) {
      const edit = left().find((candidate) => specOf(candidate) === spec);
      if (!edit) { problems.push(`require('${spec}') is recorded as taken out, but the step leaves no such line`); continue; }
      const row = verdicts()(edit);
      if (row.verdict !== 'dead') { problems.push(`require('${spec}') is recorded as taken out, but it is not proven dead: ${row.why}`); continue; }
      dropped.push({ spec, why: row.why });
      take(edit);
    }
    kept = left().map((edit) => ({ spec: specOf(edit), why: 'the step that was recorded left it' }));
  } else {
    for (;;) {
      const verdictOf = verdicts();
      const dead = left().find((edit) => verdictOf(edit).verdict === 'dead');
      if (!dead) { kept = left().map((edit) => ({ spec: specOf(edit), why: verdictOf(edit).why })); break; }
      dropped.push({ spec: specOf(dead), why: verdictOf(dead).why });
      take(dead);
    }
  }
  if (dropped.length === 0) return { plan, dropped, kept, problems };
  const glue = { ...plan.glue, sourceAt: places.sourceAt, edits };
  if (places.bodyAt !== undefined) glue.bodyAt = places.bodyAt;
  return { plan: { ...plan, newSource: lines.join('\n'), glue }, dropped, kept, problems };
}

/**
 * The sentences a command prints about the lines a step left or took.
 * @param {{ dropped: { spec: string, why: string }[], kept: { spec: string, why: string }[] } | undefined} bare @param {boolean} dryRun
 * @returns {string[]}
 */
export function bareLines(bare, dryRun) {
  if (!bare) return [];
  return [
    ...bare.dropped.map((row) => `  ${dryRun ? 'would take' : 'took'} out require('${row.spec}'); the moved code was its last user and the line is proven dead: ${row.why}.`),
    ...bare.kept.map((row) => `  ${dryRun ? 'would leave' : 'left'} require('${row.spec}'); in its place: ${row.why}.`),
  ];
}
