// How long the volume keeps being read after someone looked at it, and how much slower it is
// read during a game.

// The 'audio' tick spawns SoundVolumeView.exe (native, can't move to pwsh-worker),
// so each fire is a process + temp-CSV cycle. External volume/mute changes are rare
// and this is a glance display, so an 8s cadence roughly halves the daily spawn
// count vs 5s while staying responsive; a dirty-check then skips the SSE broadcast
// (and the client-side mixer rebuild) when nothing actually changed.
//
// "A dashboard is open" was the WRONG gate, though: this tick was firing whenever
// any surface was connected, whether or not anything consumed it, which is a
// process spawn every 8 seconds forever (~10.8k/day) for a number nobody was
// reading. It also outlived its second consumer without noticing — lighting.onAudio
// has been a no-op since the volume flash was removed, so the old comment claiming
// "lighting still sees every sample" was describing a consumer that no longer
// exists. Gate it on actual demand instead, the same shape as audioLevelsWanted()
// and idleProbeWanted():
//   - a widget granted the `audio` stream is fed straight off this tick, so it
//     keeps the poll alive for as long as it is installed and un-suspended;
//   - otherwise the poll runs only while someone is plausibly looking at the
//     Volume UI. fetchAudio() runs when that panel opens, so a recent GET /audio
//     is the signal, and the window is generous because it is refreshed by any
//     interaction. The trade is that a mixer left open and untouched past the
//     window stops noticing volume changes made OUTSIDE Xenon until it is touched
//     again; changes made through Xenon apply locally and are unaffected.
const AUDIO_WATCH_WINDOW_MS = 120000;

// Each look is a process on Windows: through a game the mixer follows, four times slower.
const AUDIO_POLL_GAME_MS = 32000;

module.exports = { AUDIO_WATCH_WINDOW_MS, AUDIO_POLL_GAME_MS };
