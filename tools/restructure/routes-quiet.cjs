// Loaded before the engine in the throwaway copy the route check starts
// (`node --require`): that copy can start no program, open no connection and
// send no packet. It only answers.
//
// A route that would run a system tool or ask a service gets the same refusal a
// PC without that tool, or without a network, would give it, so the check never
// touches what is installed on the PC it runs on, and two runs give the same
// answers. What is compared is how the route answers the refusal: the same
// before and after a move.
'use strict';

const childProcess = require('node:child_process');
const dgram = require('node:dgram');
const dns = require('node:dns');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');

const missing = (file) => Object.assign(new Error(`spawn ${file} ENOENT`),
  { code: 'ENOENT', errno: -2, syscall: `spawn ${file}`, path: String(file), spawnargs: [] });
const refused = () => Object.assign(new Error('connect ECONNREFUSED (the route check keeps the copy offline)'),
  { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' });

// What Node hands back when the program is not there: a child with no pid that says so, then closes.
function quietChild(file) {
  const child = new EventEmitter();
  Object.assign(child, { pid: undefined, exitCode: null, signalCode: null, killed: false, connected: false,
    spawnfile: String(file), spawnargs: [String(file)] });
  child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdio = [child.stdin, child.stdout, child.stderr];
  for (const name of ['ref', 'unref', 'disconnect']) child[name] = () => {};
  child.kill = () => false;
  child.send = () => false;
  setImmediate(() => {
    child.stdout.end();
    child.stderr.end();
    if (child.listenerCount('error') > 0) child.emit('error', missing(file));
    child.emit('close', -2, null);
  });
  return child;
}

const withCallback = (file, args) => {
  const callback = args.findLast((arg) => typeof arg === 'function');
  if (callback) setImmediate(callback, missing(file), '', '');
  return quietChild(file);
};

childProcess.spawn = (file) => quietChild(file);
childProcess.fork = (file) => quietChild(file);
childProcess.execFile = (file, ...args) => withCallback(file, args);
childProcess.exec = (command, ...args) => withCallback(String(command).split(' ')[0], args);
childProcess.spawnSync = (file) => ({ error: missing(file), status: null, signal: null, output: null, pid: 0, stdout: null, stderr: null });
childProcess.execFileSync = (file) => { throw missing(file); };
childProcess.execSync = (command) => { throw missing(String(command).split(' ')[0]); };

// Every connection out is refused, the ones to this PC too: other programs listen there (and the installed app).
// A connection that came in is never connected by this call, so the copy still answers.
net.Socket.prototype.connect = function connect() {
  process.nextTick(() => this.destroy(refused()));
  return this;
};

// A name is never looked up. An address written out is let through: that is how the copy opens its own port.
const realLookup = dns.lookup;
dns.lookup = (hostname, ...args) => {
  if (net.isIP(String(hostname)) !== 0 || hostname === 'localhost') return realLookup(hostname, ...args);
  const callback = args.findLast((arg) => typeof arg === 'function');
  if (callback) process.nextTick(callback, Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND', hostname }));
};

dgram.Socket.prototype.send = function send(...args) {
  const callback = args.findLast((arg) => typeof arg === 'function');
  if (callback) process.nextTick(callback, refused());
};
