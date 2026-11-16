// A file dropped outside the tile must not replace the dashboard: drops that carry files are
// stopped on the window.
'use strict';

(() => {
  function hasFiles(e) {
    const types = e && e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, 'Files') >= 0;
  }

  // A file dropped ANYWHERE else replaces the whole dashboard with that file —
  // the browser navigates to it. Prevented only for drags that carry files, so
  // GridStack's own drag in layout-edit mode is untouched.
  function guardWindowDrops() {
    for (const type of ['dragover', 'drop']) {
      document.addEventListener(type, (e) => {
        if (!hasFiles(e)) return;
        if (e.target && e.target.closest && e.target.closest('.xfer-zone')) return;
        e.preventDefault();
      });
    }
  }

  window.TransferWidgetWindowDrops = { hasFiles, guardWindowDrops };
})();
