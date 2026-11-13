// The small request handler the tests of `branches` take apart: routes that can move as they are, routes that
// can move when their call hands them a name of the file, and one for each reason a body must stay.
import path from 'node:path';

export const OLD = 'server/demo.js';
export const TABLE = 'server/lights/routes.js';
export const SOURCE = `const fs = require('fs');
const lights = require('./lights-lib');
const { readBody, sendFile } = require('./http/read-body.js');

const LIMIT = 3;
function helper() { return LIMIT; }

// Answers every request.
const handleRequest = async (req, res) => {
  const urlObj = new URL(req.url, 'http://localhost');
  const reqPath = urlObj.pathname;
  const isRemote = false;
  const json = (value) => { res.end(JSON.stringify(value)); };
  const err500 = (message) => { res.writeHead(500); res.end(String(message)); };
  const secret = 1;

  if (reqPath === '/a' && req.method === 'GET') {
    // Says a.
    json({ a: lights.count() });

  } else if (reqPath === '/b' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req) || '{}');
      if (!body.ok) { err500('no'); return; }
      json({ b: fs.existsSync(body.file), remote: isRemote });
    } catch (e) { err500(e.message); }
  } else if (req.method === 'GET' && reqPath === '/c') {
    json({ c: helper(), limit: LIMIT });
  } else if (reqPath === '/d' && req.method === 'GET') {
    json({ d: secret });
  } else if (reqPath === '/e' && req.method === 'GET') {
    var count = 1;
    json({ count });
  } else if (reqPath === '/f' && req.method === 'GET') {
    return json({ f: this });
  } else if (reqPath === '/g' && req.method === 'GET') {
    json({ g: late() });
  } else if (reqPath.startsWith('/h/')) {
    json({ h: 1 });
  } else if (reqPath === '/i' && req.method === 'GET') { json({ i: 1 }); }
  else if (reqPath === '/j' && req.method === 'GET') {
    res.end(lights.name);
  } else if (reqPath === '/k' && req.method === 'GET') {
    json({ k: turns });
  } else {
    res.writeHead(404); res.end();
  }
};

const { late } = require('./late.js');
module.exports = { handleRequest, helper, sendFile, late };
let turns = 0;
`;

const BUILT_IN = new Set(['fs', 'path', 'os']);
export const rewrite = (spec, from, to) => {
  const bare = spec.replace(/^node:/, '');
  if (BUILT_IN.has(bare)) return { spec: `node:${bare}`, kind: 'builtin', file: null };
  const file = path.posix.join(path.posix.dirname(from), spec).replace(/(?:\.js)?$/, '.js');
  const relative = path.posix.relative(path.posix.dirname(to), file);
  return { spec: relative.startsWith('.') ? relative : `./${relative}`, kind: 'file', file };
};
export const idOf = (spec, from) => { const found = rewrite(spec, from, from); return found.file ?? found.spec; };
export const ALLOWED = new Set(['handleRequest']);
