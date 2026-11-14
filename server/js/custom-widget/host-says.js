// What the host tells a frame about how the dashboard reads, none of it a permission: the words,
// the language, and the units a temperature is read in.
'use strict';

(() => {
  const t = (k, fb) => (typeof window.t === 'function' ? window.t(k) : (fb != null ? fb : k));

  function langCode() {
    return (typeof t === 'function' && t('locale')) || 'en';
  }

  // Celsius or Fahrenheit, as the user set it in Settings. Sent for the same
  // reason `lang` is: a widget that draws a temperature — a monitor showing CPU
  // and GPU, a weather tile — has no other way to know, and one showing °C on a
  // dashboard where everything else says °F is wrong in a way the widget author
  // cannot fix from inside. Not a permission: it is a preference about how to
  // format, and it says nothing about the user beyond which unit they read.
  //
  // Values ARE NOT converted. Xenon reports Celsius everywhere it reports a
  // temperature, and it keeps doing that: converting on the way out would mean a
  // widget could not tell 30 °C from 30 °F without reading this field anyway, and
  // the two together are the only pair that cannot be misread.
  function tempUnit() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    return hs.tempUnit === 'f' ? 'f' : 'c';
  }

  // The unit the user reads CPU/GPU temperatures in. Usually the same as
  // tempUnit, but it can be set apart (°F forecast, °C hardware), so a monitor
  // widget reads this one and a weather widget reads tempUnit.
  function hwTempUnit() {
    const hs = (typeof hubSettings === 'object' && hubSettings) ? hubSettings : {};
    return hs.hwTempUnit === 'c' || hs.hwTempUnit === 'f' ? hs.hwTempUnit : tempUnit();
  }

  window.CustomWidgetHostSays = { t, langCode, tempUnit, hwTempUnit };
})();
