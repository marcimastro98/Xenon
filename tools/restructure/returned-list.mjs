// The list side of returned.mjs: a function that returns a list written out is cut into
// functions that each return a stretch of it.
//
//   function all() {                     function one() {
//     return [                             return [
//       { name: 'a', text: '…' },            { name: 'a', text: '…' },
//       { name: 'b', text: '…' },          ];
//       ...more(),                       }
//     ];                            ->
//   }                                    function two() {
//                                          return [
//                                            { name: 'b', text: '…' },
//                                            ...more(),
//                                          ];
//                                        }
//
//                                        function all() {
//                                          return [
//                                            ...one(),
//                                            ...two(),
//                                          ];
//                                        }
//
//   node tools/restructure/cli.mjs spread --returned --list --from <file> --name <function> [--dry-run] <part>=<first name> [...]
//
// The rules of returned.mjs hold, with these in place of the ones about keys:
//   - an entry is an object written out whose first key is `name: '<text>'`, or another
//     list spread into this one (`...more`); no hole, no name twice;
//   - a part is said by the name of its first entry, so it starts at an object, never
//     at a spread list.
// A list spread into a part and the part spread into the whole is read once, at the
// same place among the entries, as it was when it was spread into the whole directly.

/**
 * @param {any} literal the list a function returns @param {any} K the kinds of parser.mjs
 * @returns {{ keys: (string | null)[], reasons: string[] }} per entry its name, null for a spread list; and what keeps the list from being cut
 */
export function listNames(literal, K) {
  const keys = [];
  const reasons = new Set();
  for (const entry of literal.elements) {
    if (entry.kind === K.SpreadElement) { keys.push(null); continue; }
    const first = entry.kind === K.ObjectLiteralExpression ? entry.properties[0] : null;
    const named = first?.kind === K.PropertyAssignment && first.name.kind === K.Identifier && first.name.text === 'name'
      && (first.initializer.kind === K.StringLiteral || first.initializer.kind === K.NoSubstitutionTemplateLiteral);
    if (entry.kind === K.OmittedExpression) reasons.add('a hole');
    else if (!named) reasons.add('an entry that is not an object starting with `name: \'…\'`, nor a list spread into it');
    else if (keys.includes(first.initializer.text)) reasons.add(`the name ${first.initializer.text} twice`);
    keys.push(named ? first.initializer.text : null);
  }
  return { keys, reasons: [...reasons] };
}

/** The words the messages of a cut use: a list has entries with names, an object has keys. */
export const wordsOf = (list) => (list ? { whole: 'list', entry: 'name' } : { whole: 'object', entry: 'key' });
