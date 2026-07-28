// The Linux recycle-bin delete. The runner is injected so the argv this builds
// can be asserted without trashing anything: what matters is that file names
// reach `gio` as arguments and never as shell syntax, and that a partial
// failure is reported in the shape diskspace.js retries on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { createLinuxTrash } = require(join(ROOT, 'linux-trash.js'));

const spy = (result = { ok: true, code: null }) => {
  const calls = [];
  const runner = async (cmd, args) => { calls.push({ cmd, args }); return result; };
  return { calls, runner };
};

test('paths are passed as arguments, after the -- guard', async () => {
  const s = spy();
  const trash = createLinuxTrash({ runner: s.runner });
  assert.deepEqual(await trash({ paths: ['/home/u/a.iso', '/home/u/b.iso'] }), { ok: true });
  assert.deepEqual(s.calls[0].args, ['trash', '--', '/home/u/a.iso', '/home/u/b.iso']);
});

test('a file name that looks like an option or like shell syntax stays a name', async () => {
  const s = spy();
  const trash = createLinuxTrash({ runner: s.runner });
  // `--` is what stops gio reading "-rf" as a flag; execFile is what stops the
  // semicolon and the quote being syntax. Both matter: these are the user's own
  // files, and one of them is allowed to be called anything.
  await trash({ paths: ['/home/u/-rf', "/home/u/a'; rm -rf ~; '.txt"] });
  assert.deepEqual(s.calls[0].args, ['trash', '--', '/home/u/-rf', "/home/u/a'; rm -rf ~; '.txt"]);
});

test('only absolute paths are forwarded', async () => {
  const s = spy();
  const trash = createLinuxTrash({ runner: s.runner });
  await trash({ paths: ['relative/x', '', null, '/home/u/real'] });
  assert.deepEqual(s.calls[0].args, ['trash', '--', '/home/u/real']);
});

test('an empty batch succeeds without invoking gio at all', async () => {
  const s = spy();
  const trash = createLinuxTrash({ runner: s.runner });
  // The caller already filtered everything out; that is not a failed delete.
  assert.deepEqual(await trash({ paths: [] }), { ok: true });
  assert.deepEqual(await trash({}), { ok: true });
  assert.equal(s.calls.length, 0);
});

test('a refusal reports `aborted`, which is what makes the caller retry singly', async () => {
  const s = spy({ ok: false, code: 1 });
  const trash = createLinuxTrash({ runner: s.runner });
  const res = await trash({ paths: ['/home/u/a', '/home/u/b'] });
  // gio fails the whole invocation when any one path is refused. Without
  // `aborted`, diskspace.js would record both files as unremovable instead of
  // retrying them one at a time and isolating the one that is really stuck.
  assert.deepEqual(res, { ok: false, aborted: true, rc: 1 });
});

test('emptying the bin is its own call, not a delete of every path', async () => {
  const s = spy();
  const trash = createLinuxTrash({ runner: s.runner });
  assert.deepEqual(await trash({ emptyRecycleBin: true }), { ok: true });
  assert.deepEqual(s.calls[0].args, ['trash', '--empty']);
});

test('a missing gio is a clean refusal, never a silent success', async () => {
  const trash = createLinuxTrash({ runner: async () => ({ ok: false, code: null }) });
  const res = await trash({ paths: ['/home/u/a'] });
  assert.equal(res.ok, false);
});
