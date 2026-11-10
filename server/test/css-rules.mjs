// Reading a stylesheet in a test: its selectors, its rules and what a rule sets, without a
// browser. Enough for the sheets in server/styles and server/components, which keep one
// rule per selector list and no nested rules outside at-rules.

// A list split on the commas outside brackets.
export function splitTop(list) {
  const out = [];
  let depth = 0;
  let part = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(part.trim()); part = ''; } else part += ch;
  }
  out.push(part.trim());
  return out;
}

const uncommented = (css) => css.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '');

// Every selector of every rule, at-rules aside.
export function selectorsOf(css) {
  return [...uncommented(css).matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim())
    .filter((prelude) => prelude && !prelude.startsWith('@'))
    .flatMap(splitTop);
}

// The rules outside any at-rule, with a closing `:is(a, b)` opened up, so a selector
// can be looked up as the element it styles.
export function topRules(css) {
  const bare = uncommented(css);
  const rules = [];
  let depth = 0;
  let start = 0;
  let prelude = '';
  for (let i = 0; i < bare.length; i++) {
    if (bare[i] === '{' && depth++ === 0) { prelude = bare.slice(start, i).trim(); start = i + 1; }
    if (bare[i] === '}' && --depth === 0) {
      if (!prelude.startsWith('@')) {
        const selectors = splitTop(prelude).flatMap((sel) => {
          const m = /^(.*?):is\(([^()]*)\)$/.exec(sel);
          return m ? splitTop(m[2]).map((one) => m[1] + one) : [sel];
        });
        rules.push({ selectors, body: bare.slice(start, i) });
      }
      start = i + 1;
    }
  }
  return rules;
}

// What the rules set on one selector, a later rule over an earlier one, as the cascade
// does between rules of the same weight.
export function declsIn(rules, selector) {
  const out = {};
  for (const rule of rules.filter((r) => r.selectors.includes(selector))) {
    for (const decl of rule.body.split(';')) {
      const at = decl.indexOf(':');
      if (at > 0) out[decl.slice(0, at).trim()] = decl.slice(at + 1).trim();
    }
  }
  return out;
}
