// What a widget or Ambient scene already says about itself in its manifest.json:
// version, description and category. The form fills its own empty fields from
// it, so the listing starts equal to the package instead of being typed again
// by hand (a version typed as "1" for a manifest's "1.0.0", a category that
// differs from the one the creator chose in the Maker).
(function () {
  'use strict';

  var VERSION_RE = /^\d+(\.\d+){0,3}$/;
  var MAX_DESC = 800;

  function decode(b64) {
    try {
      var bin = atob(String(b64));
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (e) { return ''; }
  }

  function manifestOf(env) {
    if (!env || (env.kind !== 'widget' && env.kind !== 'ambient')) return null;
    var files = env.data && env.data.payload && env.data.payload.files;
    if (!Array.isArray(files)) return null;
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!f || f.path !== 'manifest.json' || typeof f.data !== 'string') continue;
      try {
        var m = JSON.parse(decode(f.data));
        return m && typeof m === 'object' && !Array.isArray(m) ? m : null;
      } catch (e) { return null; }
    }
    return null;
  }

  /**
   * The listing fields the package states, each '' when it states none or one
   * the form would not take. `categories` lists the form's own values.
   */
  function read(env, categories) {
    var m = manifestOf(env);
    var out = { version: '', description: '', category: '' };
    if (!m) return out;
    if (typeof m.version === 'string' && VERSION_RE.test(m.version.trim())) out.version = m.version.trim();
    if (typeof m.description === 'string') out.description = m.description.trim().slice(0, MAX_DESC);
    if (typeof m.category === 'string' && (categories || []).indexOf(m.category) !== -1) out.category = m.category;
    return out;
  }

  window.XenonSubmitManifest = { read: read };
})();
