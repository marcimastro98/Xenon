// Linux app pictures (linux-app-icons.js): found through the .desktop file, by the
// window's class, and left out when there is no small, real picture to show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createAppIcons, desktopValue } = require('../linux-app-icons.js');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'xenon-icons-'));
  const put = async (rel, data) => {
    const file = path.join(home, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return file;
  };
  try { await run(home, put); } finally { await rm(home, { recursive: true, force: true }); }
}

const entry = (lines) => ['[Desktop Entry]', 'Type=Application', ...lines].join('\n');

test('desktopValue reads the main group only', () => {
  const text = entry(['Icon=spotify']) + '\n[Desktop Action New]\nIcon=other\n';
  assert.equal(desktopValue(text, 'Icon'), 'spotify');
  assert.equal(desktopValue('[Desktop Action New]\nIcon=other\n', 'Icon'), '');
  assert.equal(desktopValue('', 'Icon'), '');
});

test('the file named after the class gives the picture, a PNG from the theme', async () => {
  await withHome(async (home, put) => {
    await put('applications/spotify.desktop', entry(['Icon=spotify-client']));
    await put('icons/hicolor/48x48/apps/spotify-client.png', PNG);
    const url = await createAppIcons([home])('Spotify');
    assert.equal(url, `data:image/png;base64,${PNG.toString('base64')}`);
  });
});

test('a reverse-DNS file name matches on its last part (Flatpak)', async () => {
  await withHome(async (home, put) => {
    await put('applications/org.kde.krita.desktop', entry(['Icon=krita']));
    await put('icons/hicolor/64x64/apps/krita.png', PNG);
    assert.ok((await createAppIcons([home])('krita')).startsWith('data:image/png;base64,'));
  });
});

test('StartupWMClass finds a file called something else', async () => {
  await withHome(async (home, put) => {
    await put('applications/code-editor.desktop', entry(['Icon=code', 'StartupWMClass=Code']));
    await put('icons/hicolor/scalable/apps/code.svg', '<svg/>');
    assert.ok((await createAppIcons([home])('code')).startsWith('data:image/svg+xml;base64,'));
  });
});

test('an absolute Icon path and pixmaps both work', async () => {
  await withHome(async (home, put) => {
    const file = await put('opt/app/logo.png', PNG);
    await put('applications/one.desktop', entry([`Icon=${file}`]));
    await put('applications/two.desktop', entry(['Icon=two']));
    await put('pixmaps/two.png', PNG);
    const lookup = createAppIcons([home]);
    assert.ok(await lookup('one'));
    assert.ok(await lookup('two'));
  });
});

test('no file, no Icon, a missing, oversize or foreign picture: no picture', async () => {
  await withHome(async (home, put) => {
    await put('applications/plain.desktop', entry(['Name=Plain']));
    await put('applications/gone.desktop', entry(['Icon=gone']));
    await put('applications/big.desktop', entry(['Icon=big']));
    await put('icons/hicolor/48x48/apps/big.png', Buffer.alloc(13 * 1024));
    const file = await put('opt/logo.xpm', 'x');
    await put('applications/odd.desktop', entry([`Icon=${file}`]));
    const lookup = createAppIcons([home]);
    for (const cls of ['nobody', 'plain', 'gone', 'big', 'odd', '']) assert.equal(await lookup(cls), null, cls);
  });
});

test('an answer is kept: the folders are read once', async () => {
  await withHome(async (home, put) => {
    await put('applications/one.desktop', entry(['Icon=one']));
    await put('icons/hicolor/48x48/apps/one.png', PNG);
    const lookup = createAppIcons([home]);
    const first = await lookup('one');
    await rm(path.join(home, 'icons'), { recursive: true });
    assert.equal(await lookup('ONE'), first);
  });
});
