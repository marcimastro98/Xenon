'use strict';

// "Widgets only": the driver page (js/shell-driver.js) holds the widget host
// (sdk-service.html) in a hidden frame while a Store widget has a Deck action
// the user granted, and removes it when none is left, so its memory goes back.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DriverSdkHost = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  const HOST_URL = '/sdk-service';

  // The same switches custom-widget.js reads before it starts a background
  // frame: widgets on, safe mode off, and a granted Deck action.
  function wanted(settings) {
    if (!settings || typeof settings !== 'object' || settings.safeMode === true) return false;
    const sdk = settings.sdkWidgets;
    if (!sdk || typeof sdk !== 'object' || sdk.enabled !== true) return false;
    const grants = sdk.grants && typeof sdk.grants === 'object' ? sdk.grants : {};
    return Object.keys(grants).some((id) => {
      const g = grants[id];
      return !!g && Array.isArray(g.handlers) && g.handlers.length > 0;
    });
  }

  function create(doc) {
    let frame = null;
    function sync(settings) {
      const want = wanted(settings);
      if (want && !frame) {
        frame = doc.createElement('iframe');
        frame.hidden = true;
        frame.title = 'Xenon widgets';
        frame.src = HOST_URL;
        doc.body.appendChild(frame);
      } else if (!want && frame) {
        frame.remove();
        frame = null;
      }
      return want;
    }
    return { sync, active: () => !!frame };
  }

  return Object.freeze({ HOST_URL, wanted, create });
});
