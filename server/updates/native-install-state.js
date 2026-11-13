// The download of the app's installer that is running now: one at a time.

const nativeInstall = {
  inFlight: null, // one verified installer download at a time (POST /api/native/install)
};

module.exports = { nativeInstall };
