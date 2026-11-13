// The sound devices in use, as last seen: the default speaker and microphone, the speaker
// volume and whether sound is muted or turned down for speech. Kept so a volume or mute change
// does not have to look them up again.

const audioCache = {
  muted: false,
  speakerId: null, // full CLI ID — for SetDefault
  speakerName: null, // short endpoint name — for SetVolume/ToggleMute
  micId: null,
  micLabel: null, // friendly name (F.NAME) used to match DirectShow devices
  speakerVolume: 50,  // updated by getAudioInfo — used for duck/restore
  ducked: false,
  volumeBeforeDuck: null,
};

module.exports = { audioCache };
