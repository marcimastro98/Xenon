'use strict';
// The few iCUE services the widget uses, each one safe to call when the page
// is opened in a plain browser for testing (no channel, no plugins).

// iCUE fills these in through its WebChannel: the data provider (isPreview,
// tr) and the focus manager its own focus listener calls.
function icueObjects() {
  const channel = window.__icueChannel || window.icueChannel;
  return (channel && channel.objects) || null;
}

// The data provider is registered under an id iCUE generates per widget, so
// find it by shape rather than by name.
function icueDataProvider() {
  const objects = icueObjects();
  if (!objects) return null;
  return Object.values(objects).find((o) => o && 'isPreview' in o && 'iCUEGlobalObject' in o) || null;
}

function icueIsPreview() {
  const provider = icueDataProvider();
  return !!(provider && provider.isPreview === true);
}

function icueOnPreviewChange(fn) {
  const provider = icueDataProvider();
  if (provider && provider.isPreviewChanged) provider.isPreviewChanged.connect(fn);
}

// Asks iCUE to give this widget the keyboard: the call iCUE's own listener
// makes when a text field in the widget page takes focus.
function icueGrantKeyboard() {
  const objects = icueObjects();
  const manager = objects && objects.icueFocusManager;
  if (manager && typeof manager.grantFocus === 'function') manager.grantFocus();
}

// Without the link plugin a link would open inside the widget itself, so
// there is no fallback: no plugin, no link.
function icueOpenLink(url) {
  const ready = typeof pluginLinkprovider_initialized !== 'undefined' && pluginLinkprovider_initialized;
  const plugin = window.plugins && window.plugins.Linkprovider;
  if (ready && plugin && typeof plugin.open === 'function') plugin.open(url);
}

// tr() is iCUE's translation lookup and returns a Promise; in a browser the
// English key is the text.
function icueText(key) {
  return typeof window.tr === 'function' ? Promise.resolve(window.tr(key)).catch(() => key) : Promise.resolve(key);
}
