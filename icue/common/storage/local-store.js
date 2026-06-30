/*
 * Local persistence for Xenon native widgets — shared by Notes, Tasks, Timers.
 *
 * Phase 1 persistence is the browser localStorage (per the native roadmap; a
 * local-file backend arrives with the Phase 4 Companion Bridge). Every access is
 * wrapped in try/catch so a sandbox that blocks storage degrades gracefully —
 * widgets keep working in-memory instead of throwing — and `available()` lets a
 * widget surface an honest "not saved" state rather than pretending it persisted.
 *
 * Plain script (no ES imports, no `?.` / `??`); inlined into each widget at build.
 */
var XenonStore = (function () {
  function probe() {
    try {
      var k = "__xenon_probe__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;            // private mode / sandbox / disabled storage
    }
  }

  var ok = (typeof window !== "undefined" && window.localStorage) ? probe() : false;

  function load(key, fallback) {
    if (!ok) return fallback;
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    if (!ok) return false;
    try {
      window.localStorage.setItem(key, String(value));
      return true;
    } catch (e) {
      return false;            // e.g. quota exceeded
    }
  }

  function remove(key) {
    if (!ok) return false;
    try {
      window.localStorage.removeItem(key);
      return true;
    } catch (e) {
      return false;
    }
  }

  function loadJSON(key, fallback) {
    var raw = load(key, null);
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return fallback;         // corrupt value — fall back, never throw
    }
  }

  function saveJSON(key, obj) {
    var raw;
    try {
      raw = JSON.stringify(obj);
    } catch (e) {
      return false;
    }
    return save(key, raw);
  }

  return {
    available: function () { return ok; },
    load: load,
    save: save,
    remove: remove,
    loadJSON: loadJSON,
    saveJSON: saveJSON
  };
})();
