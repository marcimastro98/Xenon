/*
 * iCUE runtime helpers — property access, state, language, personalization.
 * Plain script (no ES imports); inlined into each widget at build time.
 * Avoids `?.` / `??` so the iCUE validator accepts it.
 */

/* Read an iCUE-injected property safely. iCUE may expose properties as locals
 * inside a sandboxed Function() context rather than as window props, so check
 * both paths. Returns undefined for unset/empty values. */
function getIcueProperty(name) {
  if (typeof window !== "undefined" && Object.prototype.hasOwnProperty.call(window, name)) {
    var value = window[name];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  try {
    var local = Function('return typeof ' + name + ' !== "undefined" ? ' + name + ' : undefined')();
    if (local !== undefined && local !== null && local !== "") return local;
  } catch (e) {}
  return undefined;
}

/* Clamp to a numeric range, falling back to a default for non-numbers. */
function clampRange(value, min, max, fallback) {
  value = Number(value);
  if (!isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/* Toggle the standard loading / error / empty / content states. */
function showState(state) {
  var states = ["loading-state", "error-state", "empty-state", "content"];
  for (var i = 0; i < states.length; i++) {
    var el = document.querySelector("." + states[i]);
    if (el) el.style.display = states[i] === state ? "" : "none";
  }
}

/* Active UI language from the iCUE info object (falls back to 'en'). */
function readLanguage() {
  if (typeof iCUE !== "undefined" && iCUE && iCUE.iCUELanguage) return iCUE.iCUELanguage;
  return "en";
}

/* Apply the standard personalization properties to CSS custom properties.
 * Widgets render everything from these vars; JS only sets the values. Each
 * value is applied only when present, so a widget's own CSS :root defaults
 * (and brand palette) stay intact in browser preview and when iCUE omits one. */
function applyPersonalization() {
  var root = document.documentElement;
  var textColor = getIcueProperty("textColor");
  var accentColor = getIcueProperty("accentColor");
  var backgroundColor = getIcueProperty("backgroundColor");
  if (typeof textColor === "string" && textColor) root.style.setProperty("--text-color", textColor);
  if (typeof accentColor === "string" && accentColor) root.style.setProperty("--accent-color", accentColor);
  if (typeof backgroundColor === "string" && backgroundColor) root.style.setProperty("--bg-color", backgroundColor);
  root.style.setProperty("--bg-opacity", clampRange(getIcueProperty("transparency"), 0, 100, 100) / 100);
}
