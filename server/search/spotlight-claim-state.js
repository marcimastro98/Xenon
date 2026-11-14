// The clock that waits for the app window to claim the search shortcut before the browser popup
// opens instead.

const spotlightClaim = {
  // Native first: the hotkey is broadcast to every dashboard; a NATIVE kiosk
  // webview opens the frameless Tauri Spotlight window and claims it (POST
  // /spotlight/claimed). No claim within the window → the Edge app-mode popup
  // opens instead, so browser-only installs lose nothing.
  timer: null,
};

module.exports = { spotlightClaim };
