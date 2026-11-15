'use strict';
// What the macOS collectors remember between two reads: the last answers, the reads under way,
// and the tools found missing.

const held = {
  macmonCache: { data: { cpuTemp: null, gpu: null, gpuTemp: null }, at: 0 },
  macmonInFlight: null,
  macmonFailures: 0,
  macmonNextTry: 0,
  helperFailures: 0,
  helperNextTry: 0,
  // A spawn that fails is the helper being absent, unsigned or broken, and it
  // will fail identically for every mode — so that pin is SHARED, and one probe
  // every five minutes is what an install without the helper costs. A mode that
  // runs and answers "I cannot read this" is a different thing entirely and must
  // not pin the others out: an Intel Mac reads no HID sensors and still has a
  // perfectly good app switcher, which is why `temps` keeps its own counter for
  // the fall-through to macmon below.
  helperDownUntil: 0,
  sensorCache: undefined, // given its first value where the engine loads
  sensorInFlight: null,
  gpuStaticPromise: null,
  audioDevicesCache: { data: null, at: 0 },
  audioDevicesInFlight: null,
  sasMissingAt: 0,
  audioRowsCache: { rows: null, at: 0 },
  // macOS has no shell-reachable input mute, so a muted microphone is one held at
  // zero. The pre-mute level is remembered here to restore it, the way the volume
  // slider itself would.
  lastInputVolume: 75,
  audioProbe: null,
  audioProbeAt: 0,
  procPrev: null,
  procPrevAt: 0,
};

module.exports = { held };
