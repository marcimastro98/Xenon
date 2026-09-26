// The Store code ceiling is stated in three places in this repo and must agree:
//   community-catalog.js MAX_CODE_BYTES  what the app accepts from codes/<id>.txt
//   js/preset-share.js CATALOG_CODE_MAX  what the export dialog calls publishable
//   js/preset-share.js MAX_CODE_BYTES    what the import dialog decodes (base64 JSON, so a code
//                                        of N bytes decodes to ~0.75 N)
// A code the packager and the exporter call publishable that the app then refuses shows up as
// an Install button that fails with bad_code on every machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const mb = (text, name) => {
  const m = text.match(new RegExp(`const ${name} = (\\d+) \\* 1024 \\* 1024;`));
  assert.ok(m, `${name} not found as "<n> * 1024 * 1024"`);
  return Number(m[1]) * 1024 * 1024;
};

test('the Store code ceiling agrees between the app and the export dialog', () => {
  const catalog = mb(src('../community-catalog.js'), 'MAX_CODE_BYTES');
  const share = src('../js/preset-share.js');
  assert.equal(mb(share, 'CATALOG_CODE_MAX'), catalog);
  assert.ok(mb(share, 'MAX_CODE_BYTES') >= Math.ceil(catalog * 0.75), 'the import dialog must decode any code the catalog accepts');
});
