'use strict';

// Critique of a Deck profile, read from the SANITIZED profile the code carries
// (the one the import installs): keys that show nothing, keys that do nothing,
// empty folders, repeated titles in one folder and label colours that cannot be
// read on their cap. Findings use the same paths as the create_preset report.

const DeckActions = require('./js/deck-actions.js');
const themePalette = require('./js/theme-palette.js');
const { BODY_TEXT, LARGE_TEXT, finding, contrastFinding, worstContrast } = require('./ai-preset-critique-core.js');

// The cap faces of components/DeckPanel/DeckPanel.css (default cap style): a
// plain key, an accent key and a two-colour key, each as its top and bottom
// colour. The cap styles reshade around these, so they are the reference.
function capFace(key) {
  if (key.bg && key.bg2) return [themePalette.mix('#181b23', key.bg, 0.5), themePalette.mix('#10131a', key.bg2, 0.46)];
  if (key.bg) return [themePalette.mix('#1b1f27', key.bg, 0.42), themePalette.mix('#14171d', key.bg, 0.18)];
  return ['#1d212a', '#0c0e14'];
}

const hasIcon = (key) => !!(key.icon && String(key.icon.value || '').trim());
const hasTitle = (key) => !!String(key.title || '').trim();

function keyDoesSomething(key) {
  if (key.state || key.live) return true;   // a status or live-value key is read, not pressed
  return Object.values(key.triggers || {}).some((t) => DeckActions.triggerSteps(t).length > 0);
}

function folderKeys(folder) {
  return (folder && Array.isArray(folder.pages) ? folder.pages : [])
    .flatMap((page, i) => (page && Array.isArray(page.keys) ? page.keys : []).map((key, j) => ({ key, at: '.pages[' + i + '].keys[' + j + ']' })))
    .filter((k) => k.key);
}

function critiqueKey(key, path) {
  const out = [];
  if (key.kind !== 'slider' && !hasIcon(key) && !hasTitle(key) && !key.live) {
    out.push(finding('fix', path, 'the key shows nothing: no icon and no title', 'give it an icon or a title'));
  }
  if (key.kind === 'action' && !keyDoesSomething(key)) {
    out.push(finding('fix', path, 'an action key with no action: pressing it does nothing', 'add a tap trigger (deck_action_catalog)'));
  }
  if (key.kind === 'folder' && !folderKeys(key.folder).length) {
    out.push(finding('fix', path, 'the folder is empty', 'put keys in it or remove it'));
  }
  if (key.labelColor && hasTitle(key) && !key.bgImage) {
    const face = capFace(key);
    // Labels are short and bold: below the large-text minimum they are a fix,
    // below the body-text one worth a look.
    const label = contrastFinding(path + '.labelColor', key.labelColor, face, BODY_TEXT, 'labelColor');
    if (label && worstContrast(key.labelColor, face) >= LARGE_TEXT) label.severity = 'consider';
    if (label) out.push(label);
  }
  return out;
}

function duplicateTitles(keys, path) {
  const count = new Map();
  for (const { key } of keys) {
    const title = String(key.title || '').trim().toLowerCase();
    if (title) count.set(title, (count.get(title) || 0) + 1);
  }
  return [...count].filter(([, n]) => n > 1)
    .map(([title, n]) => finding('consider', path, n + ' keys titled "' + title + '" in the same folder', 'give each key its own title'));
}

function critiqueFolder(folder, path) {
  const keys = folderKeys(folder);
  const out = duplicateTitles(keys, path);
  for (const { key, at } of keys) {
    out.push(...critiqueKey(key, path + at));
    if (key.kind === 'folder') out.push(...critiqueFolder(key.folder, path + at + '.folder'));
  }
  return out;
}

function critiqueDeck(profile) {
  return profile && profile.root ? critiqueFolder(profile.root, 'root') : [];
}

module.exports = { critiqueDeck, capFace };
