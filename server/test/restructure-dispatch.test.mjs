// The tools that take tests of whole addresses out of the request handler's chain
// (tools/restructure/dispatch-read.mjs, dispatch-move.mjs, dispatch-undo.mjs), on a
// small engine written here: what is read of the chain, when a test can be true for an
// address, which tables may leave and why the others stay, and that a step can be undone.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { callLine, headLine, requireLine } from '../../tools/restructure/branches-text.mjs';
import { applyMove, featureRoutesClaimed, LOOKUP_TEST, moveProblems, planMove } from '../../tools/restructure/dispatch-move.mjs';
import { canMatch, exactRoutes, knownOf, readDispatch, renderDispatch } from '../../tools/restructure/dispatch-read.mjs';
import { chainBack, cut, handsLines, listBack, listLine, readHands, readListed, uncut, unmark, waitingLine } from '../../tools/restructure/dispatch-undo.mjs';
import { openParser, parserAvailable } from '../../tools/restructure/parser.mjs';

const parser = parserAvailable() ? await openParser() : null;
after(() => parser?.close());
const SKIP = 'TypeScript is not installed here (npm run quality:install)';

const branch = (test, ...body) => [`  } else if (${test}) {`, ...body, ''];
const MODULES = {
  './a/routes.js': [headLine('GET /a/one', 'req, res, { json }, { store }'), headLine('POST /a/two', 'req, res, { json }, { store, other }'),
    headLine('GET /a/files/*', 'req, res, { json }')].join('\n'),
  './b/routes.js': [headLine('POST /b/two', 'req, res, { json }'), headLine('GET /b/three', 'req, res, { json }, { vault }')].join('\n'),
  './c/routes.js': [headLine('GET /', 'req, res, { json }'), headLine('GET /c/page', 'req, res, { json }')].join('\n'),
  './d/routes.js': [headLine('GET|POST /d/both', 'req, res, { json }'), headLine('POST /d/x|/d/y', 'req, res, { json }, { other }')].join('\n'),
  './e/routes.js': headLine('GET /e/files/*', 'req, res, { json }'),
};
const moduleTextOf = (spec) => MODULES[spec];
const ENGINE = ["const featureRoutes = require('./feature-routes.js');", 'const SAID = {', "  '/said/hello': () => 1,", '};',
  requireLine('aBranches', './a/routes.js'), requireLine('bBranches', './b/routes.js'), requireLine('cBranches', './c/routes.js'),
  requireLine('dBranches', './d/routes.js'), requireLine('eBranches', './e/routes.js'), '',
  'const routeHands = () => ({', '});', '',
  'const handleRequest = async (req, res) => {', '  const reqPath = req.url;',
  "  if (reqPath === '/' && req.method === 'GET') {", callLine('cBranches', 'GET /'), '',
  ...branch("reqPath === '/a/one' && req.method === 'GET'", callLine('aBranches', 'GET /a/one', undefined, ['store'])),
  ...branch("reqPath === '/c/page' && req.method === 'GET'", callLine('cBranches', 'GET /c/page')),
  ...branch(LOOKUP_TEST, '    await featureRoutes.run(req.method, reqPath, req, res, {}, routeHands());'),
  ...branch("SAID[reqPath] && req.method === 'POST'", '    SAID[reqPath]();'),
  ...branch("reqPath.startsWith('/b/') && !unlocked()", '    res.writeHead(403); res.end();'),
  ...branch("reqPath === '/b/two' && req.method === 'POST'", callLine('bBranches', 'POST /b/two')),
  ...branch("reqPath === '/b/three' && req.method === 'GET'", callLine('bBranches', 'GET /b/three', undefined, ['vault'])),
  ...branch("reqPath === '/a/two' && req.method === 'POST'", callLine('aBranches', 'POST /a/two', undefined, ['store', 'other'], [], true)),
  ...branch("reqPath === '/d/both' && (req.method === 'GET' || req.method === 'POST')", callLine('dBranches', 'GET|POST /d/both')),
  ...branch("(reqPath === '/d/x' && req.method === 'POST') || (reqPath === '/d/y' && req.method === 'POST')", callLine('dBranches', 'POST /d/x|/d/y', undefined, ['other'])),
  ...branch("reqPath.startsWith('/a/files/') && req.method === 'GET'", callLine('aBranches', 'GET /a/files/*')),
  ...branch("reqPath.startsWith('/e/files/') && req.method === 'GET'", callLine('eBranches', 'GET /e/files/*')),
  '  } else {', '    res.writeHead(404); res.end();', '  }', '};', ''].join('\n');
const LIST = ['const FEATURES = Object.freeze([', "  require('./old/routes.js'),", ']);', 'const inChain = (_loaded) => ({ branches: {} });', 'const TABLE_FILES = () => [',
  ...Object.keys(MODULES).map(waitingLine), '];', ''].join('\n');
const plan = (locals, engineText = ENGINE, listText = LIST, claimed = []) => planMove({ engineText, listText, moduleTextOf, locals, parser, claimed, known: knownOf(engineText, parser) });

test('a key that names whole addresses stands for every method and address in it, any other key for none', () => {
  assert.deepEqual(exactRoutes('GET /a'), ['GET /a']);
  assert.deepEqual(exactRoutes('POST|GET /a'), ['POST /a', 'GET /a']);
  assert.deepEqual(exactRoutes('POST /a|/b'), ['POST /a', 'POST /b']);
  for (const key of ['GET /a/*', '* /a', 'GET /a|/b/*', null, 'get /a', 'GET a']) assert.deepEqual(exactRoutes(key), [], String(key));
});

test('the chain is read branch by branch: what it asks, how, and what answers', (t) => {
  if (!parser) return t.skip(SKIP);
  const { rows } = readDispatch(ENGINE, parser);
  assert.equal(rows.length, 13);
  assert.deepEqual(rows.map((row) => row.how), ['exact', 'exact', 'exact', 'other', 'other', 'other', 'exact', 'exact', 'exact', 'exact', 'exact', 'beginning', 'beginning']);
  assert.deepEqual(rows[9].routes, ['GET /d/both', 'POST /d/both']);
  assert.deepEqual(rows[10].routes, ['POST /d/x', 'POST /d/y']);
  assert.deepEqual({ local: rows[1].call.local, key: rows[1].call.key, own: rows[1].call.own }, { local: 'aBranches', key: 'GET /a/one', own: ['store'] });
  assert.equal(rows[8].call.returns, true);
  assert.equal(rows[3].call, null, 'the branch that asks feature-routes.js is answered by its own line');
  const lines = ENGINE.split('\n');
  for (const row of rows.slice(1)) assert.equal(lines[row.from], `  } else if (${row.test}) {`);
  assert.equal(rows[1].to - rows[1].from, 2, 'a branch is its test, its call and the empty line after');
  const said = renderDispatch(rows);
  assert.match(said[1], /exact\s+GET \/a\/one {2}-> {2}aBranches\['GET \/a\/one'\] handed store$/);
  assert.equal(said.at(-1), '13 branches: 8 ask for whole addresses, 2 for a beginning, 3 another way; 10 are answered by a table\'s function, 3 by lines of the handler.');
});

test('whether a test can be true for a method and an address: no, yes, or it depends on something else', (t) => {
  if (!parser) return t.skip(SKIP);
  const known = knownOf(ENGINE, parser, { lib: { spec: './lib', values: { PREFIX: '/w/', count: 3 } } });
  assert.deepEqual(known.maps, { SAID: ['/said/hello'] });
  assert.deepEqual(known.texts, {}, 'a text is known only when the file requires its module under that name');
  const withLib = knownOf(`const lib = require('./lib');\n${ENGINE}`, parser, { lib: { spec: './lib', values: { PREFIX: '/w/', count: 3 } } });
  assert.deepEqual(withLib.texts, { 'lib.PREFIX': '/w/' });
  const ask = (test, method, address, names = known) => {
    const text = ENGINE.replace(LOOKUP_TEST, test);
    const row = readDispatch(text, parser).rows[3];
    return canMatch(row.node, parser, method, address, names);
  };
  assert.equal(ask("reqPath === '/x' && req.method === 'GET'", 'GET', '/x'), true);
  assert.equal(ask("reqPath === '/x' && req.method === 'GET'", 'POST', '/x'), false);
  assert.equal(ask("'/x' !== reqPath", 'GET', '/x'), false);
  assert.equal(ask("reqPath.startsWith('/b/') && !unlocked()", 'GET', '/b/two'), null, 'the other half of the test is not about the request line');
  assert.equal(ask("reqPath.startsWith('/b/') && !unlocked()", 'GET', '/a/one'), false, 'and cannot make it true when the address half is false');
  assert.equal(ask("reqPath.startsWith('/b/') || unlocked()", 'GET', '/a/one'), null);
  assert.equal(ask("reqPath.endsWith('.png') || reqPath.includes('/img/')", 'GET', '/a/img/b'), true);
  assert.equal(ask("req.method === 'GET' && /^\\/(js|styles)(\\/|$)/.test(reqPath)", 'GET', '/js/a.js'), true);
  assert.equal(ask("req.method === 'GET' && /^\\/(js|styles)(\\/|$)/.test(reqPath)", 'GET', '/jsx'), false);
  assert.equal(ask('/x/g.test(reqPath)', 'GET', '/x'), null, 'a pattern that remembers where it stopped is not run');
  assert.equal(ask("SAID[reqPath] && req.method === 'POST'", 'POST', '/said/hello'), true);
  assert.equal(ask("SAID[reqPath] && req.method === 'POST'", 'POST', '/said/other'), false);
  assert.equal(ask("OTHER[reqPath] && req.method === 'POST'", 'POST', '/said/other'), null, 'an object the file says nothing certain about');
  assert.equal(ask("req.method === 'GET' && reqPath.startsWith(lib.PREFIX)", 'GET', '/w/a', withLib), true);
  assert.equal(ask("req.method === 'GET' && reqPath.startsWith(lib.PREFIX)", 'GET', '/w/a'), null);
  assert.equal(ask("!(reqPath === '/x')", 'GET', '/y'), true);
  assert.equal(ask('isRemote', 'GET', '/y'), null);
  // An object something else also mentions is not a map of addresses: it could have been changed.
  assert.deepEqual(knownOf(ENGINE.replace("const routeHands", 'SAID.more = 1;\nconst routeHands'), parser).maps, {});
});

test('routeHands is written sorted and full lines, and read back; any other writing is refused', () => {
  const names = Array.from({ length: 30 }, (_, at) => `name${String(29 - at).padStart(2, '0')}Value`);
  const lines = handsLines([...names, names[0]]);
  assert.ok(lines.length > 1 && lines.every((line) => line.length <= 140 && line.startsWith('  ') && line.endsWith(',')));
  const file = ['const routeHands = () => ({', ...lines, '});'];
  assert.deepEqual(readHands(file).names, [...names].sort());
  assert.deepEqual(readHands(['const routeHands = () => ({', '});']).names, []);
  assert.throws(() => readHands(['const routeHands = () => ({', '  b, a,', '});']), /not written the way this step writes it/);
  assert.throws(() => readHands(['nothing']), /not written the way this step writes it/);
});

test('the list of files is read with its marks, a mark comes off and goes back on', () => {
  const read = readListed(LIST);
  assert.deepEqual(read.waiting, Object.keys(MODULES));
  assert.deepEqual(read.specs, []);
  const off = unmark(LIST, ['./b/routes.js', './d/routes.js']);
  assert.deepEqual(readListed(off).specs, ['./b/routes.js', './d/routes.js']);
  assert.deepEqual(readListed(off).all, Object.keys(MODULES), 'the order of the list never changes');
  assert.ok(off.includes(listLine('./b/routes.js')) && !off.includes(waitingLine('./b/routes.js')));
  assert.equal(listBack(off, { listed: ['./b/routes.js', './d/routes.js'] }), LIST);
  assert.throws(() => unmark(off, ['./b/routes.js']), /does not hold this line once/);
  assert.throws(() => readListed(LIST.replace(waitingLine('./a/routes.js'), "  later(require('./a/routes.js')),")), /not one required file/);
  assert.throws(() => readListed('const x = 1;'), /TABLE_FILES is not written the way/);
});

test('a cut says which single line it stood next to, and is put back there', () => {
  assert.throws(() => cut(['a', 'same', 'b', 'c', 'same', 'd'], 2, 2), /could not be put back/, 'between two lines that both stand twice');
  const again = ['a', 'b', 'c', 'd'];
  const made = cut(again, 1, 2);
  assert.deepEqual(made, { lines: ['b', 'c'], before: 'd' });
  uncut(again, made);
  assert.deepEqual(again, ['a', 'b', 'c', 'd']);
  const atEnd = ['a', 'b'];
  const last = cut(atEnd, 1, 1);
  assert.deepEqual(last, { lines: ['b'], after: 'a' });
  uncut(atEnd, last);
  assert.deepEqual(atEnd, ['a', 'b']);
  assert.throws(() => uncut(['x', 'x'], { lines: ['y'], before: 'x' }), /is not there once/);
});

test('a table leaves the chain whole, with the names it was handed, and the step puts itself back', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['dBranches']);
  assert.deepEqual(made.refused, []);
  assert.deepEqual(made.moves.map((move) => [move.local, move.spec, move.routes, move.own]), [['dBranches', './d/routes.js', ['GET /d/both', 'POST /d/both', 'POST /d/x', 'POST /d/y'], ['other']]]);
  const step = applyMove({ engineText: ENGINE, listText: LIST, moves: made.moves });
  assert.ok(!step.engineText.includes('dBranches'), 'its tests, its calls and its require line are gone');
  assert.deepEqual(readHands(step.engineText.split('\n')).names, ['other']);
  assert.deepEqual(readListed(step.listText).specs, ['./d/routes.js']);
  assert.equal(ENGINE.split('\n').length - step.engineText.split('\n').length, 6 + 1 - 1, 'two branches of three lines and a require line out, one line of names in');
  assert.deepEqual(step.step.listed, ['./d/routes.js']);
  assert.equal(chainBack(step.engineText, [step.step]), ENGINE);
  assert.equal(listBack(step.listText, step.step), LIST);
  const proof = { before: ENGINE, after: step.engineText, listBefore: LIST, listAfter: step.listText, step: step.step, moduleTextOf, parser, known: knownOf(step.engineText, parser) };
  assert.deepEqual(moveProblems(proof), []);
  // A second step on top of the first, and both undone in one go.
  const next = planMove({ engineText: step.engineText, listText: step.listText, moduleTextOf, locals: ['aBranches'], parser, known: knownOf(step.engineText, parser) });
  assert.deepEqual(next.refused, []);
  assert.deepEqual(next.moves[0].routes, ['GET /a/one', 'POST /a/two'], 'a branch that reads `return await` leaves like any other');
  const second = applyMove({ engineText: step.engineText, listText: step.listText, moves: next.moves });
  assert.ok(second.engineText.includes(requireLine('aBranches', './a/routes.js')), 'the table is still called for the addresses it answers by their beginning');
  assert.ok(second.engineText.includes(callLine('aBranches', 'GET /a/files/*')));
  assert.deepEqual(readHands(second.engineText.split('\n')).names, ['other', 'store']);
  assert.deepEqual(second.step.hands, ['store'], 'a name the list already holds is not recorded twice');
  assert.equal(chainBack(second.engineText, [step.step, second.step]), ENGINE);
  assert.equal(readDispatch(second.engineText, parser).rows.length, 9);
});

test('a table stays, with the reason said, when leaving could change which lines answer', (t) => {
  if (!parser) return t.skip(SKIP);
  const why = (local, engineText, listText, claimed) => plan([local], engineText, listText, claimed).refused[0]?.why;
  assert.match(why('cBranches'), /'GET \/' is the first branch of the chain/);
  assert.match(why('bBranches'), /stands before POST \/b\/two and can be true for it: reqPath\.startsWith\('\/b\/'\) && !unlocked\(\)/);
  assert.match(why('eBranches'), /no key of it names whole addresses/);
  assert.match(why('zBranches'), /requires no table under that name/);
  assert.match(why('dBranches', ENGINE, unmark(LIST, ['./d/routes.js'])), /answers for its file already/);
  assert.match(why('dBranches', ENGINE, LIST.replace(`${waitingLine('./d/routes.js')}\n`, '')), /does not load its file: write `inChain\(require\('\.\/d\/routes\.js'\)\),`/);
  assert.match(why('dBranches', ENGINE, LIST, ['POST /d/y']), /POST \/d\/y is answered by a table or a feature already/);
  // A test for a beginning that stands before the branch asking feature-routes.js: every address after it would be answered sooner.
  const early = ENGINE.replace(`  } else if (${LOOKUP_TEST}) {`, `  } else if (reqPath.startsWith('/d/') && busy()) {\n    wait();\n\n  } else if (${LOOKUP_TEST}) {`);
  assert.match(why('dBranches', early), /stands before GET \/d\/both and can be true for it/);
  assert.equal(why('aBranches', early), undefined, 'and says nothing about the addresses it cannot be true for');
  // The object of addresses: an address it holds stays behind it.
  const said = ENGINE.replace("'/said/hello': () => 1,", "'/said/hello': () => 1,\n  '/d/x': () => 2,");
  assert.match(why('dBranches', said), /stands before POST \/d\/x and can be true for it: SAID\[reqPath\]/);
  const twice = ENGINE.replace(`  } else if (${LOOKUP_TEST}) {`, `  } else if (reqPath === '/d/both' && req.method === 'GET') {\n    other();\n\n  } else if (${LOOKUP_TEST}) {`);
  assert.match(why('dBranches', twice), /GET \/d\/both is asked for twice/);
  const more = ENGINE.replace(callLine('dBranches', 'GET|POST /d/both'), `${callLine('dBranches', 'GET|POST /d/both')}\n    more();`);
  assert.match(why('dBranches', more), /0 branches call 'GET\|POST \/d\/both', one was expected/);
  const other = ENGINE.replace("reqPath === '/d/both' && (req.method === 'GET' || req.method === 'POST')", "reqPath === '/d/other' && (req.method === 'GET' || req.method === 'POST')");
  assert.match(why('dBranches', other), /calls 'GET\|POST \/d\/both' and its test asks for something else/);
  assert.throws(() => plan(['dBranches'], ENGINE.replace(LOOKUP_TEST, 'nothing()')), /has no branch that asks feature-routes\.js/);
  assert.deepEqual(plan(null).moves.map((move) => move.local), ['aBranches', 'dBranches'], 'asked for every table, the ones that can leave do');
});

test('a step that would leave an address with two answers, or a name nobody hands over, does not prove itself', (t) => {
  if (!parser) return t.skip(SKIP);
  const made = plan(['dBranches']);
  const step = applyMove({ engineText: ENGINE, listText: LIST, moves: made.moves });
  const proof = { before: ENGINE, after: step.engineText, listBefore: LIST, listAfter: step.listText, step: step.step, moduleTextOf, parser, known: knownOf(step.engineText, parser) };
  assert.match(moveProblems({ ...proof, before: `${ENGINE}\n` })[0], /putting the cuts back does not give the engine file as it was/);
  assert.match(moveProblems({ ...proof, listBefore: `${LIST}\n` })[0], /does not give the file as it was/);
  assert.match(moveProblems({ ...proof, claimed: ['POST /d/x'] })[0], /POST \/d\/x is answered twice/);
  const kept = step.engineText.replace('  } else {\n', "  } else if (reqPath === '/d/x' && req.method === 'POST') {\n    again();\n\n  } else {\n");
  assert.ok(moveProblems({ ...proof, after: kept }).some((line) => /of the chain can still answer POST \/d\/x, which \.\/d\/routes\.js answers/.test(line)));
  const bare = step.engineText.replace('  other,\n', '');
  assert.ok(moveProblems({ ...proof, after: bare }).some((line) => /is handed other, which routeHands does not hold/.test(line)));
});

test('the addresses the older features answer are read from their files', () => {
  const read = (spec) => ({ './old/routes.js': "const routes = { 'GET /api/old': read, 'POST /api/old/save': save };" })[spec];
  assert.deepEqual(featureRoutesClaimed(LIST, read), ['GET /api/old', 'POST /api/old/save']);
});
