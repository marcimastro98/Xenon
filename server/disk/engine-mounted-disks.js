// The engine's reader of the mounted disks off Windows, or none on Windows.

const { nativeCollectors } = require('../system/native-collectors.js');
const { createMountedDisks } = require('./mounted-disks.js');

const mountedDisks = nativeCollectors ? createMountedDisks(() => nativeCollectors.disks()) : null;

module.exports = { mountedDisks };
