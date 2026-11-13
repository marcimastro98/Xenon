// Whether the settings file was missing when the engine started.

const settingsBoot = {
  // True when settings.json did NOT exist as this process started: the only honest
  // way to tell a brand-new install from an old one that just enabled the version
  // ping. Read once at boot (see readHubSettings().then below) because the answer
  // stops being available a moment later. Defaults to false, so anything that goes
  // wrong reads as "not new" — under-counting births is the recoverable direction.
  fileMissing: false,
};

module.exports = { settingsBoot };
