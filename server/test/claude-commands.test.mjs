'use strict';
// claude-commands.js — the "/" picker's list. Pinned: it reads the places
// Claude Code reads (user, project, enabled plugins), names only with a short
// description, skips what the user cannot invoke or switched off, and the
// project's own command shadows the user's of the same name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createCommandList, _internal } = require('../claude-commands.js');

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xenon-cmds-'));
  const config = path.join(root, 'config');
  const project = path.join(root, 'work', 'alpha');
  const plugins = path.join(root, 'plugins');
  await fs.mkdir(project, { recursive: true });
  return { root, config, project, plugins, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function lister(tree) {
  return createCommandList({
    configDir: () => tree.config,
    projectDir: async (id) => (id === 'p1' ? tree.project : ''),
  });
}

test('frontmatter: plain, quoted and block-scalar values', () => {
  const fm = _internal.frontmatter('---\r\nname: "deploy"\r\ndescription: >-\r\n  Ships the\r\n  build\r\nuser-invocable: false\r\n---\r\nbody');
  assert.equal(fm.name, 'deploy');
  assert.equal(fm.description, 'Ships the build');
  assert.equal(fm['user-invocable'], 'false');
  assert.deepEqual(_internal.frontmatter('no frontmatter'), {});
});

test('no description: the first line of prose stands in', () => {
  assert.equal(_internal.firstLine('---\nname: x\n---\n\n# Review the diff\nmore'), 'Review the diff');
});

test('user commands, nested commands, skills and plugins are listed', async () => {
  const tree = await makeTree();
  try {
    await write(path.join(tree.config, 'commands', 'review.md'), '---\ndescription: Review the branch\n---\n');
    await write(path.join(tree.config, 'commands', 'git', 'sync.md'), 'Sync with main\n');
    await write(path.join(tree.config, 'skills', 'seo', 'SKILL.md'), '---\nname: seo\ndescription: |\n  Audit a page\n---\n');
    await write(path.join(tree.config, 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\nuser-invocable: false\n---\n');
    await write(path.join(tree.plugins, 'ctx', 'skills', 'docs', 'SKILL.md'), '---\nname: docs\ndescription: Library docs\n---\n');
    await write(path.join(tree.plugins, 'off', 'commands', 'nope.md'), 'nope\n');
    await write(path.join(tree.config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: {
      'ctx@market': [{ installPath: path.join(tree.plugins, 'ctx') }],
      'off@market': [{ installPath: path.join(tree.plugins, 'off') }],
    } }));
    await write(path.join(tree.config, 'settings.json'), JSON.stringify({ enabledPlugins: { 'off@market': false } }));

    const list = await lister(tree).list('');
    assert.deepEqual(list.map((c) => c.name), ['ctx:docs', 'git:sync', 'review', 'seo']);
    const byName = Object.fromEntries(list.map((c) => [c.name, c]));
    assert.equal(byName.review.desc, 'Review the branch');
    assert.equal(byName['git:sync'].desc, 'Sync with main');
    assert.equal(byName.seo.desc, 'Audit a page');
    assert.equal(byName['ctx:docs'].kind, 'plugin');
  } finally { await tree.cleanup(); }
});

test("the project's own command shadows the user's of the same name", async () => {
  const tree = await makeTree();
  try {
    await write(path.join(tree.config, 'commands', 'test.md'), 'user version\n');
    await write(path.join(tree.project, '.claude', 'commands', 'test.md'), 'project version\n');
    const list = await lister(tree).list('p1');
    assert.equal(list.length, 1);
    assert.equal(list[0].desc, 'project version');
    assert.equal(list[0].kind, 'project');
    // An unknown project id reads no project folder.
    assert.equal((await lister(tree).list('nope'))[0].kind, 'user');
  } finally { await tree.cleanup(); }
});

test('names outside the allowed shape are dropped, descriptions are one bounded line', async () => {
  const tree = await makeTree();
  try {
    await write(path.join(tree.config, 'commands', 'bad name.md'), 'x\n');
    await write(path.join(tree.config, 'commands', 'long.md'), '---\ndescription: ' + 'a'.repeat(400) + '\n---\n');
    const list = await lister(tree).list('');
    assert.deepEqual(list.map((c) => c.name), ['long']);
    assert.ok(list[0].desc.length <= 140);
    assert.equal(_internal.NAME_RE.test('../etc'), false);
  } finally { await tree.cleanup(); }
});

test('no config dir: an empty list, not a crash', async () => {
  const list = await createCommandList({}).list('');
  assert.deepEqual(list, []);
});
