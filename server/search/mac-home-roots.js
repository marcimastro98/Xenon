// Whether a folder the file index is asked to walk makes the whole home folder reachable on
// macOS, which is what brings up the system's permission dialogs.

const os = require('node:os');
const { nativeCollectors } = require('../system/native-collectors.js');

// The roots that make the home directory reachable, and therefore every folder
// macOS protects. Dropping exactly these is the difference between one honest
// message and a dialog per protected folder, per walk. The test lives with the
// rest of the macOS seam (darwin-collectors.js), where it can be run against a
// home directory that is not this machine's.
function macRootReachesHome(root) {
  if (!nativeCollectors || typeof nativeCollectors.rootReachesHome !== 'function') return false;
  return nativeCollectors.rootReachesHome(root, os.homedir());
}

module.exports = { macRootReachesHome };
