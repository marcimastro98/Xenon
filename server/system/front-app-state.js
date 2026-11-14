// Whether a foreground app has ever been named on this computer.

const frontApp = {
  // A foreground app seen once proves the probe works here: macOS without the helper
  // and some Wayland desktops never name one.
  seen: false,
};

module.exports = { frontApp };
