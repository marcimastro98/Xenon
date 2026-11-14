// The timer that waits before the lighting is written to the settings.

const lightingPersist = {
  // Provider-agnostic tool dispatch shared by the Gemini and Ollama chat loops.
  // `deps` carries the per-request context the handlers need.
  // Persist the bridge's current lighting config into settings.json so AI-driven
  // (and endpoint-driven) changes survive a restart. Best-effort; never throws.
  // Coalesced: a burst of lighting tweaks (slider drags, AI sweeps, effect
  // toggles) used to rewrite the whole settings.json — the largest store — once
  // per call; now at most once per window. The config written is read fresh from
  // the bridge at flush time, so the last state always wins. Flushed on shutdown.
  timer: null,
};

module.exports = { lightingPersist };
