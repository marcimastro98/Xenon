// Cuts a stylesheet into parts that a page links one after the other. Read in
// link order the parts are the old file byte for byte, so every rule keeps its
// place in the cascade. A cut is only allowed between two rules: a part that
// began inside a block, a comment or a string would be read differently alone.

import { Refusal } from './extract-plan.mjs';

export const MAX_PART_LINES = 300;
// These only work at the very top of a sheet, or speak for one sheet alone.
const ONE_SHEET_RULES = new Set(['import', 'charset', 'namespace']);

/**
 * Walks the stylesheet once.
 * @param {string} text
 * @returns {{ between: Set<number>, problems: string[] }} `between`: the 1-based lines that start between two rules
 */
export function readStylesheet(text) {
  const between = new Set([1]);
  const problems = [];
  let [depth, round, line, last] = [0, 0, 1, ''];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\n') {
      line += 1;
      if (depth === 0 && round === 0 && (last === '' || last === '}' || last === ';')) between.add(line);
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) { problems.push(`the comment that opens at line ${line} never closes`); break; }
      // A comment between two rules belongs to the rule after it: no cut inside it.
      line += text.slice(i, end).split('\n').length - 1;
      i = end + 1;
    } else if (c === '"' || c === "'") {
      let end = i + 1;
      while (end < text.length && text[end] !== c && text[end] !== '\n') end += text[end] === '\\' ? 2 : 1;
      if (text[end] !== c) { problems.push(`the string that opens at line ${line} never closes`); break; }
      i = end;
      last = c;
    } else if (c === '@' && depth === 0 && round === 0) {
      const name = /^[a-z-]+/i.exec(text.slice(i + 1, i + 24))?.[0].toLowerCase() ?? '';
      if (ONE_SHEET_RULES.has(name)) problems.push(`@${name} at line ${line} works for one stylesheet only: this file cannot be cut`);
      last = c;
    } else if (/\S/.test(c)) {
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if (c === '(') round += 1;
      else if (c === ')') round -= 1;
      if (depth < 0 || round < 0) { problems.push(`a bracket closes at line ${line} that never opened`); break; }
      last = c;
    }
  }
  if (problems.length === 0 && (depth !== 0 || round !== 0)) problems.push('a block or a bracket is still open at the end of the file');
  return { between, problems };
}

const countLines = (text) => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/**
 * @param {string} text the stylesheet
 * @param {{ file: string, at: number }[]} cuts each part's file and the 1-based line it starts at
 * @param {string} source repo-relative name of the stylesheet, for the messages
 * @returns {{ kept: string, parts: { file: string, text: string }[] }} throws a Refusal with every reason
 */
export function planStyleSplit(text, cuts, source) {
  const { between, problems } = readStylesheet(text);
  const reasons = problems.map((problem) => `${source}: ${problem}`);
  const lines = text.split('\n');
  const total = countLines(text);
  if (cuts.length === 0) reasons.push('no cut given: say where each part starts (<line>:<file>)');
  cuts.forEach((cut, index) => {
    if (!Number.isInteger(cut.at) || cut.at < 2 || cut.at > total) reasons.push(`${cut.file}: line ${cut.at} is not a line of ${source} after the first`);
    else if (index > 0 && cut.at <= cuts[index - 1].at) reasons.push(`${cut.file}: the cuts must go down the file, line ${cut.at} comes after ${cuts[index - 1].at}`);
    else if (!between.has(cut.at)) reasons.push(`${cut.file}: line ${cut.at} is inside a rule, a comment or a list of selectors, not between two rules`);
  });
  if (reasons.length) throw new Refusal(reasons);
  const slice = (from, to) => lines.slice(from - 1, to - 1).join('\n') + (to - 1 < lines.length ? '\n' : '');
  const parts = cuts.map((cut, index) => ({ file: cut.file, text: slice(cut.at, index + 1 < cuts.length ? cuts[index + 1].at : lines.length + 1) }));
  const kept = slice(1, cuts[0].at);
  for (const part of parts) {
    if (part.text.trim() === '') reasons.push(`${part.file} would be empty`);
    if (countLines(part.text) > MAX_PART_LINES) reasons.push(`${part.file} would be ${countLines(part.text)} lines: a new file stays within ${MAX_PART_LINES}`);
  }
  if (kept + parts.map((part) => part.text).join('') !== text) reasons.push(`${source}: the parts read one after the other are not the old file`);
  if (reasons.length) throw new Refusal(reasons);
  return { kept, parts };
}
