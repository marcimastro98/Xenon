// The themes of the home page's chips, as the settings each one seeds the demo with: the
// same codes the catalog hands out, read through the app's own import rules.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const { decodePreset, themeImportPatch } = createRequire(import.meta.url)('../../server/js/preset-share.js');

const codeFile = (name) => readFileSync(new URL(`../../docs/community/codes/${name}.txt`, import.meta.url), 'utf8');

function catalogCode(id) {
  const catalog = JSON.parse(readFileSync(new URL('../../docs/community/catalog.json', import.meta.url), 'utf8'));
  const entry = catalog.entries.find((e) => e.id === id);
  if (!entry) throw new Error(`no catalog entry ${id}`);
  return entry.code;
}

// A pack carries its theme next to its widgets: only the look is wanted here.
export function themeSettings(code) {
  const envelope = decodePreset(code);
  if (!envelope) throw new Error('not a theme code');
  return themeImportPatch(envelope.kind === 'bundle' ? envelope.data.theme : envelope.data);
}

// The picture stays on the theme's own colours, whatever the demo's album cover is;
// a theme with both appearances is shown in the one it was drawn for.
const look = (code, appearance) => ({ ...themeSettings(code), dynamicAlbumTheme: false, ...(appearance ? { appearance } : {}) });

export const HERO_THEMES = {
  ocean: () => ({ settings: look(catalogCode('deep-ocean')) }),
  kintsugi: () => ({ settings: look(codeFile('kintsugi'), 'dark') }),
  limnograph: () => ({ settings: look(codeFile('limnograph'), 'light') }),
  afterimage: () => ({ settings: look(codeFile('afterimage')) }),
  forest: () => ({ settings: look(codeFile('forest')) }),
  // A built-in style, chosen the way Settings chooses it.
  retro: () => ({ open: "applyThemeById('retro');" }),
};
