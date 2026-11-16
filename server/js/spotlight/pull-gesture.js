// The pull-down gesture that opens the search: the island stretches under the finger, a drop
// pinches off past a point and falls back or opens the search when it is let go.
'use strict';

window.SpotlightPullGesture = (wrapper) => {
  const { PULL_OPEN_PX, PULL_START_PX, spotState, reducedMotion, open } = wrapper;

  // ── pull-down gesture: the island itself melts into a droplet ────────────
  // Apple-style choreography in three phases, driven per-frame from the
  // pointer (CSS vars + transforms only — no layout thrash):
  //   1. STRETCH  (0 → DETACH_AT of the threshold): the capsule itself is the
  //      liquid — it stretches down (scaleY + translateY via --spot-pull,
  //      composing with the island's own --mini-tx anchor) while a bulge
  //      swells out of its bottom edge under the finger, connected by a neck.
  //   2. PINCH-OFF (past DETACH_AT): the capsule springs back with an elastic
  //      overshoot and the bulge detaches as a free teardrop that follows the
  //      finger (x smoothed, so it trails like a real drop).
  //   3. COMMIT / ABSORB: enough pull → the drop glides into the pill's
  //      resting rect and becomes the search bar. Short pull → the drop flies
  //      back to the detach point and the capsule absorbs it with a bounce.
  // Horizontal drags and plain taps are untouched: the gesture claims the
  // pointer only after clearly vertical movement.
  const DETACH_AT = 0.4;         // fraction of PULL_OPEN_PX where the drop pinches off

  function ensureDrop() {
    if (spotState.dropEl) return spotState.dropEl;
    spotState.dropEl = document.createElement('div');
    spotState.dropEl.className = 'spot-drop';
    spotState.dropEl.hidden = true;
    document.body.appendChild(spotState.dropEl);
    return spotState.dropEl;
  }

  // Where the shell rests once open — the drop glides to this rect.
  function shellRestRect() {
    const w = Math.min(620, window.innerWidth - 48);
    const top = Math.min(window.innerHeight * (window.innerHeight <= 760 ? 0.09 : 0.26), 220);
    return { left: (window.innerWidth - w) / 2, top, width: w, height: 62 };
  }

  function zoneStretch(zone, p) {
    zone.classList.add('spot-zone-stretch');
    zone.classList.remove('spot-zone-return', 'spot-zone-absorb');
    zone.style.setProperty('--spot-pull', String(p));
  }
  function zoneRelease(zone, absorb) {
    zone.classList.remove('spot-zone-stretch');
    zone.classList.add(absorb ? 'spot-zone-absorb' : 'spot-zone-return');
    zone.style.setProperty('--spot-pull', '0');
    setTimeout(() => zone.classList.remove('spot-zone-return', 'spot-zone-absorb'), 450);
  }

  function attachGesture() {
    document.addEventListener('pointerdown', (e) => {
      if (spotState.openState) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const zone = e.target && e.target.closest && e.target.closest('.topbar, #topbar-mini');
      if (!zone) return;
      spotState.pull = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, zone, zoneRect: zone.getBoundingClientRect(), detached: false, cx: e.clientX };
    });

    window.addEventListener('pointermove', (e) => {
      if (!spotState.pull || e.pointerId !== spotState.pull.id) return;
      const dy = e.clientY - spotState.pull.y;
      const dx = Math.abs(e.clientX - spotState.pull.x);
      if (!spotState.pull.active) {
        if (dy > PULL_START_PX && dy > dx * 1.5) {
          spotState.pull.active = true;
          if (reducedMotion()) return;
          const d = ensureDrop();
          d.className = 'spot-drop spot-drop-attached';
          d.hidden = false;
          d.style.borderRadius = '50% / 44% 56%';
          spotState.pull.cx = Math.max(spotState.pull.zoneRect.left + 24, Math.min(spotState.pull.zoneRect.right - 24, e.clientX));
        } else if (dx > 24 || dy < -PULL_START_PX) {
          spotState.pull = null; // horizontal or upward: not ours
        }
        return;
      }
      e.preventDefault();
      if (reducedMotion()) return;

      // ONE continuous model for the whole drag: the drop's size and position
      // are the same functions of progress before and after the pinch-off, so
      // that moment changes ownership (capsule → finger) without any jump —
      // the v1 two-formula split popped visibly right at the detach point.
      const drag = Math.max(0, dy);
      const p = Math.min(1, drag / PULL_OPEN_PX);
      const ease = 1 - Math.pow(1 - p, 2);
      const zr = spotState.pull.zoneRect;
      const w = 42 + ease * 24;
      const h = 14 + ease * 46;

      if (!spotState.pull.detached && p >= DETACH_AT) {
        // Pinch-off: the capsule springs back elastic; the drop is free now.
        spotState.pull.detached = true;
        zoneRelease(spotState.pull.zone, false);
        spotState.dropEl.classList.remove('spot-drop-attached');
      }

      // The drop rides just under the fingertip (slight lag — a drop trails,
      // it doesn't teleport), clamped onto the capsule while still attached.
      const tx = spotState.pull.detached ? e.clientX : Math.max(zr.left + 24, Math.min(zr.right - 24, e.clientX));
      spotState.pull.cx += (tx - spotState.pull.cx) * (spotState.pull.detached ? 0.3 : 0.5);
      const bottom = zr.bottom + drag * 0.8;
      spotState.dropEl.style.width = w + 'px';
      spotState.dropEl.style.height = h + 'px';
      spotState.dropEl.style.left = (spotState.pull.cx - w / 2) + 'px';
      spotState.dropEl.style.top = (bottom - h) + 'px';

      if (!spotState.pull.detached) {
        // Still one body: stretch the capsule gently and keep a thinning neck
        // bridging its bottom edge and the drop (the neck is the ::before,
        // sized by these vars — it covers whatever gap the pull opens).
        const local = p / DETACH_AT;
        zoneStretch(spotState.pull.zone, local);
        const gap = Math.max(0, (bottom - h) - (zr.bottom + local * 6));
        spotState.dropEl.style.setProperty('--neck-h', (gap + 10).toFixed(1) + 'px');
        spotState.dropEl.style.setProperty('--neck-w', (30 - local * 14).toFixed(1) + 'px');
      }
      spotState.dropEl.classList.toggle('spot-drop-ready', drag >= PULL_OPEN_PX);
    }, { passive: false });

    const finish = (e) => {
      if (!spotState.pull || (e.pointerId != null && e.pointerId !== spotState.pull.id)) return;
      const wasActive = spotState.pull.active;
      const dy = wasActive ? (e.clientY - spotState.pull.y) : 0;
      const zone = spotState.pull.zone;
      const zr = spotState.pull.zoneRect;
      const detached = spotState.pull.detached;
      const cx = spotState.pull.cx;
      spotState.pull = null;
      if (!wasActive) return;
      if (reducedMotion()) {
        if (dy >= PULL_OPEN_PX && !spotState.openState) open();
        return;
      }
      if (!spotState.dropEl) return;
      if (dy >= PULL_OPEN_PX && !spotState.openState) {
        // Phase 3 (commit): the drop glides into the pill's resting place and
        // BECOMES the search bar; the shell fades in underneath it.
        if (!detached) zoneRelease(zone, false);
        const rest = shellRestRect();
        spotState.dropEl.classList.remove('spot-drop-ready', 'spot-drop-attached');
        spotState.dropEl.classList.add('spot-drop-commit');
        spotState.dropEl.style.left = rest.left + 'px';
        spotState.dropEl.style.top = rest.top + 'px';
        spotState.dropEl.style.width = rest.width + 'px';
        spotState.dropEl.style.height = rest.height + 'px';
        spotState.dropEl.style.borderRadius = '18px';
        const d = spotState.dropEl;
        setTimeout(() => {
          open();
          setTimeout(() => { d.hidden = true; d.classList.remove('spot-drop-commit'); }, 160);
        }, 220);
      } else {
        // Phase 3 (absorb): surface tension wins — the drop flies back to the
        // capsule's bottom edge and the capsule swallows it with a bounce.
        spotState.dropEl.classList.remove('spot-drop-ready', 'spot-drop-attached');
        spotState.dropEl.classList.add('spot-drop-retract');
        const backX = Math.max(zr.left + 26, Math.min(zr.right - 26, cx));
        spotState.dropEl.style.left = (backX - 11) + 'px';
        spotState.dropEl.style.top = (zr.bottom - 12) + 'px';
        spotState.dropEl.style.width = '22px';
        spotState.dropEl.style.height = '10px';
        spotState.dropEl.style.borderRadius = '50%';
        const d = spotState.dropEl;
        setTimeout(() => {
          zoneRelease(zone, true); // the absorb bounce fires as the drop lands
          setTimeout(() => { d.hidden = true; d.classList.remove('spot-drop-retract'); }, 60);
        }, 170);
      }
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }

  return { attachGesture };
};
