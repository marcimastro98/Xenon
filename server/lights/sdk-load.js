'use strict';
// Loading the iCUE SDK library and letting it go again.

const { bridge } = require('./bridge-state.js');
const { resolveDllPath } = require('./sdk-dll.js');

function loadLib() {
  if (bridge.lib) return true;
  try {
    bridge.dllPath = resolveDllPath();
    if (!bridge.dllPath) { bridge.lastError = 'iCUE SDK DLL not found (set ICUE_SDK_DLL or install iCUE).'; return false; }
    bridge.koffi = require('koffi');
    bridge.lib = bridge.koffi.load(bridge.dllPath);
    bridge.koffi.struct('CorsairVersion', { major: 'int', minor: 'int', patch: 'int' });
    bridge.koffi.struct('CorsairSessionStateChanged', {
      state: 'int', clientVersion: 'CorsairVersion', serverVersion: 'CorsairVersion', serverHostVersion: 'CorsairVersion',
    });
    bridge.koffi.struct('CorsairDeviceInfo', { type: 'int', id: 'char[128]', serial: 'char[128]', model: 'char[128]', ledCount: 'int', channelCount: 'int' });
    bridge.koffi.struct('CorsairDeviceFilter', { deviceTypeMask: 'int' });
    bridge.koffi.struct('CorsairLedPosition', { id: 'uint32', cx: 'double', cy: 'double' });
    bridge.koffi.struct('CorsairLedColor', { id: 'uint32', r: 'uint8', g: 'uint8', b: 'uint8', a: 'uint8' });
    bridge.koffi.proto('void CorsairStateCb(void*, CorsairSessionStateChanged*)');
    bridge.fns = {
      connect: bridge.lib.func('int CorsairConnect(CorsairStateCb*, void*)'),
      disconnect: bridge.lib.func('int CorsairDisconnect()'),
      getDevices: bridge.lib.func('int CorsairGetDevices(CorsairDeviceFilter*, int, _Out_ CorsairDeviceInfo*, _Out_ int*)'),
      getLedPositions: bridge.lib.func('int CorsairGetLedPositions(const char*, int, _Out_ CorsairLedPosition*, _Out_ int*)'),
      setLedColors: bridge.lib.func('int CorsairSetLedColors(const char*, int, CorsairLedColor*)'),
      // CorsairProperty is { CorsairDataType type; union { bool; int32; double;
      // char*; {ptr,count} arrays } value; } — 24 bytes on x64 (4-byte type,
      // padding, 8-byte-aligned 16-byte union). It is read from a raw byte
      // buffer (type at offset 0, value at offset 8) instead of a koffi union:
      // only CT_Int32 (battery percent) is ever consumed, and a raw buffer
      // sidesteps output-union decoding entirely. See getBatteryLevels().
      readProperty: bridge.lib.func('int CorsairReadDeviceProperty(const char*, int, uint32, _Out_ uint8_t*)'),
      freeProperty: bridge.lib.func('int CorsairFreeProperty(uint8_t*)'),
    };
    return true;
  } catch (e) {
    bridge.lastError = 'SDK load failed: ' + e.message;
    bridge.lib = null; bridge.fns = null;
    return false;
  }
}

function disconnect() {
  if (bridge.animTimer) { clearInterval(bridge.animTimer); bridge.animTimer = null; }
  const wasLive = !!(bridge.lib && bridge.connected);
  bridge.connected = false;
  bridge.connecting = false;
  bridge.lastWrite.clear();
  // Unregister the koffi callback only once the SDK session is fully torn down,
  // so the SDK can't invoke a freed trampoline mid-teardown.
  const dropCallback = () => { if (bridge.koffi && bridge.stateCb) { try { bridge.koffi.unregister(bridge.stateCb); } catch { /* ignore */ } bridge.stateCb = null; } };
  // CorsairDisconnect is a synchronous cross-process call: run it off the event
  // loop so a wedged iCUE service can never block the server on teardown.
  if (wasLive) {
    try { bridge.fns.disconnect.async(() => dropCallback()); }
    catch { dropCallback(); }
  } else {
    dropCallback();
  }
}

module.exports = { loadLib, disconnect };
