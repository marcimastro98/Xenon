'use strict';
// What the embedded browser does to a page it has just attached or wants to hear and see: it
// presents itself as the installed Edge, adds the audio gate, sets the size, opens or closes
// the sound, and forces one frame.

const { STEALTH_SHIM, AUDIO_SHIM } = require('./browser-page-shims.js');

function makePageSetup({ edge, activeSession, send }) {
  // Push a page's audio-gate state. The gate (AUDIO_SHIM) defaults to muted; this
  // makes a page audible (mu=false) or silent (mu=true). The `&&` guard no-ops if
  // the shim isn't present yet (e.g. a popup mid-first-load).
  function setPageMuted(session, muted) {
    if (!session) return;
    send('Runtime.evaluate', {
      expression: 'window.__xenonAudio&&window.__xenonAudio.set(' + (muted ? 'true' : 'false') + ')',
      returnByValue: true,
    }, session).catch(() => {});
  }

  // Apply a tile's desired audio state to its active page. Called on screencast
  // start/stop and re-asserted after navigation (a fresh document resets the gate).
  function applyAudio(tile) {
    if (!tile) return;
    setPageMuted(activeSession(tile), !tile.audible);
  }

  // Configure a freshly-attached page session: identity spoof, the audio gate, size,
  // and auto-attach so ITS popups (and nested ones) surface here too. Used for both
  // the base page and every popup, so a popup is as capable as the tile it came from.
  async function setupPage(sessionId, tile) {
    // Every step is best-effort so a transient reject on one command (common on a
    // fast-navigating OAuth popup) doesn't leave the page half-configured. Popups
    // this page opens are discovered browser-wide (setDiscoverTargets), so no
    // per-session auto-attach is needed — and must not be used: it would invalidate
    // this manually-attached session and kill the screencast.
    await send('Page.enable', {}, sessionId).catch(() => {});
    // Present as a normal desktop Edge. Headless Edge's User-Agent carries a
    // "HeadlessChrome" token that some sites (e.g. Twitch's login) sniff to show a
    // "browser not supported" wall. Reuse the installed Edge's own UA with that
    // token stripped, fetched once and cached.
    if (!edge.userAgent) {
      try {
        const v = await send('Browser.getVersion', {});
        edge.userAgent = String((v && v.userAgent) || '').replace(/Headless/gi, '').replace(/\s{2,}/g, ' ').trim();
      } catch (e) { edge.userAgent = ''; }
    }
    if (edge.userAgent) {
      // Also override the UA-Client-Hints brands. Passing `userAgent` alone leaves
      // `navigator.userAgentData.brands` empty ([]), which is itself a bot tell;
      // supply a normal Chromium/Edge brand list built from the real major version.
      const major = (edge.userAgent.match(/Edg\/(\d+)/) || edge.userAgent.match(/Chrome\/(\d+)/) || [])[1] || '120';
      const brands = [
        { brand: 'Not/A)Brand', version: '24' },
        { brand: 'Chromium', version: major },
        { brand: 'Microsoft Edge', version: major },
      ];
      await send('Emulation.setUserAgentOverride', {
        userAgent: edge.userAgent,
        userAgentMetadata: {
          brands,
          fullVersionList: brands.map((b) => ({ brand: b.brand, version: major + '.0.0.0' })),
          platform: 'Windows', platformVersion: '15.0.0',
          architecture: 'x86', bitness: '64', model: '', mobile: false, wow64: false,
        },
      }, sessionId).catch(() => {});
    }
    // navigator.webdriver spoof (injected before the page's own scripts run).
    await send('Page.addScriptToEvaluateOnNewDocument', { source: STEALTH_SHIM }, sessionId).catch(() => {});
    // Per-page audio gate (see AUDIO_SHIM). Starts muted; startScreencast makes the
    // visible/active page audible, stopScreencast mutes it again.
    await send('Page.addScriptToEvaluateOnNewDocument', { source: AUDIO_SHIM }, sessionId).catch(() => {});
    await send('Emulation.setDeviceMetricsOverride', { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false }, sessionId).catch(() => {});
  }

  // Force a single screencast frame by momentarily perturbing the device metrics.
  // A same-size re-apply does NOT trigger a frame (verified), so we bump the width
  // by 1px and immediately restore it; the transient off-by-one is corrected within
  // the same tick and never reaches a stable frame.
  async function forceFrame(tile) {
    if (!tile) return;
    const base = { width: tile.w, height: tile.h, deviceScaleFactor: tile.dpr, mobile: false };
    const session = activeSession(tile);
    try {
      await send('Emulation.setDeviceMetricsOverride', Object.assign({}, base, { width: tile.w + 1 }), session);
      await send('Emulation.setDeviceMetricsOverride', base, session);
    } catch (e) { /* best effort */ }
  }

  return { setPageMuted, applyAudio, setupPage, forceFrame };
}

module.exports = { makePageSetup };
