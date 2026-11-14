'use strict';
// The two scripts the browser tile runs in every page before the page's own: one hides that the
// browser is driven, one reports whether the page plays sound.

// Injected into every page before its own scripts run: hide the headless
// automation tell. `navigator.webdriver` is true in headless Edge, which sites
// like Twitch sniff to show a "browser not supported" wall (verified: even with a
// clean User-Agent, webdriver:true still triggered it).
//
// NOTE: this used to also force window.open()/target!=_self links back into the
// same page, because a popup spawned an invisible target that wedged the visible
// page. That broke real popups — most importantly OAuth "Continue with Google/
// Amazon" flows, whose popup must postMessage/`window.opener` its opener and then
// self-close; reusing the opener's own window left the callback with no opener and
// a blank page. Popups are now rendered for real (each tile keeps a stack of pages
// and shows the top one — see onTargetCreated/onTargetGone), so the hijack is gone and
// window.open behaves natively.
const STEALTH_SHIM = [
  '(function(){',
  '  try { Object.defineProperty(navigator, "webdriver", { get: function(){ return false; }, configurable: true }); } catch(_){}',
  '})();',
].join('\n');

// Per-page audio gate, injected before the page's own scripts. The single shared
// Edge is launched WITHOUT the global `--mute-audio`, so audio must be gated per
// page: only the tab currently being viewed (active tab of an on-screen tile)
// should be audible, or a backgrounded/off-screen page would keep playing sound.
//
// The gate starts MUTED and the server flips it audible on `startScreencast` and
// back to muted on `stopScreencast`, so audio tracks the exact same "is this the
// visible, streaming tab" state the screencast already tracks.
//
// It only ever touches media it muted itself (tracked in `forced`): going audible
// un-mutes solely those elements, never forcing a site's intentionally-muted media
// (e.g. an autoplay preview) to play sound. New/late media elements are caught via
// a MutationObserver and the capture-phase "play"/"volumechange" listeners, so the
// current state is always enforced (even if the site programmatically un-mutes an
// already-playing element).
//
// Frames: the shim is injected into EVERY frame (each starts muted), but the server
// only evaluates set() in the top frame. So the state is propagated down the frame
// tree with postMessage — this reaches cross-origin embeds (YouTube/Twitch iframe
// players), which querySelectorAll can't. A late-created frame asks its parent for
// the current state on init, so it doesn't get stuck at the muted default.
const AUDIO_SHIM = [
  '(function(){',
  '  try {',
  '    var muted = true;',
  '    var forced = new WeakSet();',
  '    var apply = function(el){',
  '      try {',
  '        if (muted) { if (!el.muted) { el.muted = true; forced.add(el); } }',
  '        else if (forced.has(el)) { el.muted = false; forced.delete(el); }',
  '      } catch(_){}',
  '    };',
  '    var applyAll = function(){ try { var m = document.querySelectorAll("video,audio"); for (var i=0;i<m.length;i++) apply(m[i]); } catch(_){} };',
  '    var broadcast = function(){ try { for (var i=0;i<window.frames.length;i++){ try { window.frames[i].postMessage({ __xenonMute: muted }, "*"); } catch(_){} } } catch(_){} };',
  '    var applyMute = function(mu){ muted = !!mu; applyAll(); broadcast(); };',
  '    window.__xenonAudio = { set: applyMute };',
  '    window.addEventListener("message", function(e){ var d = e && e.data; if(!d || typeof d !== "object") return; if(d.__xenonMute !== undefined){ applyMute(!!d.__xenonMute); } else if(d.__xenonMuteReq && e.source){ try { e.source.postMessage({ __xenonMute: muted }, "*"); } catch(_){} } }, false);',
  '    document.addEventListener("play", function(e){ if(e.target) apply(e.target); }, true);',
  '    document.addEventListener("volumechange", function(e){ if(e.target) apply(e.target); }, true);',
  '    var scan = function(nodes){ for (var i=0;i<nodes.length;i++){ var n = nodes[i]; if(!n || n.nodeType !== 1) continue; if(n.matches && n.matches("video,audio")) apply(n); if(n.querySelectorAll){ var mm = n.querySelectorAll("video,audio"); for (var k=0;k<mm.length;k++) apply(mm[k]); } } };',
  '    var mo = new MutationObserver(function(muts){ for (var i=0;i<muts.length;i++) scan(muts[i].addedNodes); });',
  '    var startObs = function(){ try { mo.observe(document.documentElement || document, { childList:true, subtree:true }); applyAll(); } catch(_){} };',
  '    if (document.documentElement) startObs(); else document.addEventListener("DOMContentLoaded", startObs);',
  '    if (window.top !== window.self) { try { window.parent.postMessage({ __xenonMuteReq: 1 }, "*"); } catch(_){} }',
  '  } catch(_){}',
  '})();',
].join('\n');

module.exports = { STEALTH_SHIM, AUDIO_SHIM };
