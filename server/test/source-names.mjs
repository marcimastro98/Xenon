// Reads one declaration of a script by its name, cut to its own end.
//
// A test that runs a piece of a script used to take "what lies between this text and that
// one". The two texts may sit in different scripts, or swap places, the day a part moves,
// and the test then reads the wrong lines or none. A name does not move: the function, the
// constant or the `let` called so is found wherever it stands in the text, at any indent.
//
//   const { one, all, has } = namesOf(text, 'the disk widget');
//   one('advisorStat')            the declaration, from its first line to its last
//   all('CAT_META', 'el', 'btn')  several, in the order asked, with a line between
//
// How an end is found, without a parser: the scripts are written with one indent per
// level, so a declaration is its first line, every line under it that is empty or deeper,
// and the line that closes it (`}`, `]`, `)` at the indent of the first). A name declared
// twice, or not at all, fails the test with the label, so a wrong piece is never read.

import assert from 'node:assert/strict';

const escaped = (name) => name.replace(/[$]/g, '\\$&');
const indentOf = (line) => /^[ \t]*/.exec(line)[0].length;

/**
 * @param {string} text the script, or several read one after the other (browser-source.mjs)
 * @param {string} [label] what the text is, for the message of a failed read
 * @returns {{ one: (name: string) => string, all: (...names: string[]) => string, has: (name: string) => boolean }}
 */
export function namesOf(text, label = 'the script') {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const startsOf = (name) => {
    const opening = new RegExp(`^[ \\t]*(?:(?:async )?function\\*? ${escaped(name)}\\(|(?:const|let|var) ${escaped(name)}(?= =|;|,)|class ${escaped(name)}[ {])`);
    return lines.flatMap((line, at) => (opening.test(line) ? [at] : []));
  };
  const one = (name) => {
    const starts = startsOf(name);
    assert.equal(starts.length, 1, `${name} is declared ${starts.length} times in ${label}: a piece read by name needs it once`);
    const [first] = starts;
    const base = indentOf(lines[first]);
    let last = first;
    for (let at = first + 1; at < lines.length; at += 1) {
      if (lines[at].trim() === '') continue;
      if (indentOf(lines[at]) > base) { last = at; continue; }
      // The line that closes it stands at its indent; anything else there is the next declaration.
      if (last > first && indentOf(lines[at]) === base && /^[}\])]/.test(lines[at].trim())) last = at;
      break;
    }
    return lines.slice(first, last + 1).join('\n');
  };
  return { one, all: (...names) => names.map(one).join('\n'), has: (name) => startsOf(name).length > 0 };
}
