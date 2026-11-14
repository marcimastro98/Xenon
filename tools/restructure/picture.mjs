// Says what a big CommonJS file is made of, in lines: its functions by size, what
// runs while it loads, how much of each chain of branches is still written in it,
// and for every big function the names that keep it in the file. Reading only: a
// guide for choosing the next cut, not a proof. Every line of the file is counted once.

const linesOf = (record) => record.range[1] - record.range[0] + 1;
const STATE_CODES = new Set(['is-shared-state', 'reassigns', 'changes-in-place', 'reads-state']);

// What a statement that runs at load does first, read off its first line.
const STATEMENT_KINDS = [
  ['timers started', /^(?:setInterval|setTimeout|setImmediate)\(/],
  ['process events (signals, errors, exit)', /^process\.(?:on|once)\(/],
  ['listeners handed to another module', /^[\w$.]+\.(?:on|once|addListener)\(/],
  ['blocks (if, try, for) that run at load', /^(?:if|try|for|while|switch|\{)[ ({]/],
  ['exports', /^module\.exports\b/],
];

/**
 * @param {{ kind: string, loadTime: boolean, names: string[] }} record a statement from analyze.mjs
 * @param {string} firstLine the first line of its code
 * @param {string} [shape] 'function' | 'call' | 'data' for a `const`, from its value
 * @returns {string} the row of the table it is counted in
 */
export function partOf(record, firstLine, shape) {
  if (record.kind === 'require') return 'lines that load a module (require)';
  if (record.kind === 'function' || record.kind === 'class') return 'functions';
  if (record.kind === 'let' || record.kind === 'var') return 'variables (let)';
  if (record.kind === 'const') {
    if (shape === 'function') return 'functions';
    return record.loadTime ? 'values built while the file loads (a call)' : 'constants (lists, tables, texts)';
  }
  const code = firstLine.trim();
  return STATEMENT_KINDS.find(([, test]) => test.test(code))?.[0] ?? 'other calls and assignments at load';
}

const SIZES = [['up to 10 lines', 10], ['11 to 40 lines', 40], ['41 to 100 lines', 100], ['over 100 lines', Infinity]];
const sizeOf = (lines) => SIZES.find(([, most]) => lines <= most)[0];

/**
 * The names that keep a declaration in the file, followed through everything it uses.
 * The walk stops at a variable (it would have to become a property of a shared object),
 * at protected code and at a value built while the file loads (it would have to be handed over).
 * @param {any} record @param {Map<string, any>} bindings @param {Set<string>} kept
 * @returns {{ state: string[], kept: string[], built: string[], file: string[], late: string[], other: string[] }}
 */
export function holdersOf(record, bindings, kept) {
  const found = { state: new Set(), kept: new Set(), built: new Set(), file: new Set(), late: new Set(), other: new Set() };
  const seen = new Set();
  const queue = [record];
  while (queue.length) {
    const at = queue.pop();
    if (seen.has(at)) continue;
    seen.add(at);
    for (const blocker of at.blockers) {
      if (blocker.code === 'needs') continue;
      if (blocker.code === 'bound-to-this-file') for (const name of blocker.names) found.file.add(name);
      else if (blocker.code === 'needs-a-module-loaded-later') for (const name of blocker.names) found.late.add(name);
      else if (STATE_CODES.has(blocker.code)) for (const name of blocker.names) found.state.add(name);
      else if (at === record) found.other.add(blocker.code);
    }
    for (const name of at.deps) {
      const binding = bindings.get(name);
      const next = binding.record;
      if (binding.state) found.state.add(name);
      else if (next.names.some((own) => kept.has(own))) found.kept.add(name);
      else if (next.kind !== 'function' && next.kind !== 'class' && next.loadTime) found.built.add(name);
      else queue.push(next);
    }
  }
  return Object.fromEntries(Object.entries(found).map(([key, names]) => [key, [...names].sort()]));
}

const CAUSES = [['state', 'variables'], ['kept', 'protected code'], ['built', 'values built at load'], ['file', 'words that mean this file'],
  ['late', 'modules loaded further down'], ['other', 'its own shape']];

/**
 * @param {object} job
 * @param {string} job.text the file
 * @param {{ records: any[], bindings: Map<string, any>, lineCount: number }} job.analysis from analyze.mjs
 * @param {Set<string>} [job.kept] protected names (protected.json)
 * @param {Map<any, string>} [job.featureOf] record to feature id (remainder.mjs)
 * @param {Map<number, string>} [job.shapes] index of a `const` statement to 'function' | 'call' | 'data'
 * @param {{ handler: string, first: number, last: number, bodies: { key: string | null, test: string, line: number, lines: number, moved: boolean }[] }[]} [job.chains]
 *   per handler with a chain of branches: 1-based first and last line of the chain, and its bodies
 * @param {number} [job.over] functions with more lines than this are listed with what keeps them
 * @returns {ReturnType<typeof build>}
 */
export function picture({ text, analysis, kept = new Set(), featureOf = new Map(), shapes = new Map(), chains = [], over = 40 }) {
  return build({ lines: text.split('\n'), analysis, kept, featureOf, shapes, chains, over });
}

function build({ lines, analysis, kept, featureOf, shapes, chains, over }) {
  const { records, bindings } = analysis;
  const handlers = new Set(chains.map((chain) => chain.handler));
  const isKept = (record) => record.names.some((name) => kept.has(name));
  const parts = new Map();
  const count = (part, record) => {
    const row = parts.get(part) ?? { part, pieces: 0, lines: 0, protected: 0, sizes: new Map() };
    row.pieces += 1;
    row.lines += linesOf(record);
    if (isKept(record)) row.protected += linesOf(record);
    parts.set(part, row);
    return row;
  };
  const functions = [];
  let covered = 0;
  for (const record of records) {
    covered += linesOf(record);
    if (record.names.some((name) => handlers.has(name))) { count(`the chain of ${record.names[0]}`, record); continue; }
    const part = partOf(record, lines[record.line[0] - 1] ?? '', shapes.get(record.index));
    const row = count(part, record);
    if (part !== 'functions') continue;
    const size = sizeOf(linesOf(record));
    const bucket = row.sizes.get(size) ?? { pieces: 0, lines: 0 };
    bucket.pieces += 1;
    bucket.lines += linesOf(record);
    row.sizes.set(size, bucket);
    functions.push(record);
  }
  const between = analysis.lineCount - covered;
  const big = [...functions, ...records.filter((record) => record.kind === 'const' && shapes.get(record.index) !== 'function' && !handlers.has(record.names[0]))]
    .filter((record) => linesOf(record) > over)
    .map((record) => ({ name: record.names[0], line: record.line[0], lines: linesOf(record), kind: record.kind, feature: featureOf.get(record) ?? 'engine-core',
      protected: isKept(record), movable: record.movable, holders: holdersOf(record, bindings, kept) }))
    .sort((a, b) => b.lines - a.lines);
  return {
    lines: analysis.lineCount, between,
    parts: [...parts.values()].sort((a, b) => b.lines - a.lines).map((row) => ({ ...row, sizes: SIZES.map(([size]) => ({ size, ...(row.sizes.get(size) ?? { pieces: 0, lines: 0 }) })).filter((s) => s.pieces) })),
    chains: chains.map((chain) => readChain(chain, records.find((record) => record.names.includes(chain.handler)))),
    over, big, alone: heldAlone(functions.filter((record) => !isKept(record) && !record.movable), bindings, kept),
  };
}

// A chain in lines: what stands before it in its function, the bodies that are one call of a table, the bodies still
// written in the file, the tests and braces around them, and what stands after it.
function readChain(chain, record) {
  const written = chain.bodies.filter((body) => !body.moved).sort((a, b) => b.lines - a.lines);
  const moved = chain.bodies.length - written.length;
  const inChain = chain.last - chain.first + 1;
  const bodyLines = written.reduce((sum, body) => sum + body.lines, 0);
  return { handler: chain.handler, line: record.line[0], lines: record.line[1] - record.line[0] + 1, before: chain.first - record.line[0],
    after: record.line[1] - chain.last, branches: chain.bodies.length, moved, written, writtenLines: bodyLines, frame: inChain - moved - bodyLines };
}

// For each single name, the functions it alone keeps in the file, and their lines: what one step on that name would free.
function heldAlone(stuck, bindings, kept) {
  const rows = new Map();
  const combos = new Map();
  for (const record of stuck) {
    const holders = holdersOf(record, bindings, kept);
    const causes = CAUSES.filter(([key]) => holders[key].length).map(([, said]) => said);
    const combo = causes.join(' + ') || 'nothing found (a name it needs is stuck for a reason of its own)';
    const sum = combos.get(combo) ?? { cause: combo, functions: 0, lines: 0 };
    sum.functions += 1;
    sum.lines += linesOf(record);
    combos.set(combo, sum);
    const all = CAUSES.flatMap(([key, said]) => holders[key].map((name) => ({ name, said })));
    if (all.length !== 1) continue;
    const id = `${all[0].said}: ${all[0].name}`;
    const row = rows.get(id) ?? { holder: all[0].name, kind: all[0].said, functions: 0, lines: 0 };
    row.functions += 1;
    row.lines += linesOf(record);
    rows.set(id, row);
  }
  const bySize = (a, b) => b.lines - a.lines || a.functions - b.functions;
  return { causes: [...combos.values()].sort(bySize), names: [...rows.values()].sort(bySize) };
}

const pad = (value, width) => String(value).padStart(width);
const some = (names, most = 5) => (names.length > most ? `${names.slice(0, most).join(', ')} and ${names.length - most} more` : names.join(', '));

/** @param {ReturnType<typeof picture>} seen @param {string} file @returns {string} the report */
export function renderPicture(seen, file) {
  const out = [`${file}: ${seen.lines} lines.`, '', `${'What it is made of'.padEnd(52)} pieces   lines  protected`];
  for (const row of seen.parts) {
    out.push(`  ${row.part.padEnd(50)} ${pad(row.pieces, 6)} ${pad(row.lines, 7)} ${pad(row.protected || '', 10)}`.trimEnd());
    for (const size of row.sizes) out.push(`      ${size.size.padEnd(46)} ${pad(size.pieces, 6)} ${pad(size.lines, 7)}`);
  }
  out.push(`  ${'comments and blank lines between the pieces'.padEnd(50)} ${pad('', 6)} ${pad(seen.between, 7)}`);
  for (const chain of seen.chains) {
    out.push('', `${chain.handler} (line ${chain.line}, ${chain.lines} lines): ${chain.branches} branches`,
      `  ${pad(chain.before, 5)} lines before the chain`,
      `  ${pad(chain.moved, 5)} lines are bodies that are one call of a table (${chain.moved} branches)`,
      `  ${pad(chain.frame, 5)} lines are the tests, braces and blank lines of the chain`,
      `  ${pad(chain.writtenLines, 5)} lines are the ${chain.written.length} bodies still written here:`);
    for (const body of chain.written) out.push(`        ${pad(body.lines, 5)}  ${body.key ?? body.test.replace(/\s+/g, ' ')}  (line ${body.line})`);
    out.push(`  ${pad(chain.after, 5)} lines after the chain`);
  }
  out.push('', `What keeps the functions that cannot move now (followed through everything they use):`);
  for (const row of seen.alone.causes) out.push(`  ${pad(row.functions, 4)} functions ${pad(row.lines, 6)} lines  ${row.cause}`);
  out.push('', 'Kept by one name alone (a step on that name frees these):');
  for (const row of seen.alone.names.slice(0, 40)) out.push(`  ${pad(row.functions, 4)} functions ${pad(row.lines, 6)} lines  ${row.holder}  (${row.kind})`);
  out.push('', `Pieces over ${seen.over} lines, by feature, and what keeps each:`);
  const features = new Map();
  for (const row of seen.big) features.set(row.feature, [...(features.get(row.feature) ?? []), row]);
  const total = (rows) => rows.reduce((sum, row) => sum + row.lines, 0);
  for (const [feature, rows] of [...features].sort((a, b) => total(b[1]) - total(a[1]))) {
    out.push(`  ${feature}: ${rows.length} pieces, ${total(rows)} lines`);
    for (const row of rows) {
      const why = row.protected ? ['protected, never moves']
        : row.movable ? ['can move now']
          : CAUSES.filter(([key]) => row.holders[key].length).map(([key, said]) => `${said}: ${some(row.holders[key])}`);
      out.push(`    ${pad(row.lines, 5)}  ${row.name} (line ${row.line}): ${why.join('; ') || 'a name it needs is stuck'}`);
    }
  }
  return out.join('\n');
}
