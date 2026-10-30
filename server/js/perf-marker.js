'use strict';

// Performance Mode in the top bar. A running session paused animations, the
// Media wave and heavy tiles with nothing on screen saying so, and many people
// took that for a broken Xenon. This button is on screen whenever a session
// runs, on every page and in both chromes (it lives in .clock-meta, which the
// minimal island adopts), and one tap ends it. With "always in the bar" on in
// Settings it also stays when nothing runs, to start a session at any time.
// Hidden from Settings → Dynamic Island like the Claude and Codex markers.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  // A gauge with its needle to the right.
  const GAUGE = 'M12 4a9 9 0 0 0-9 9 9 9 0 0 0 1.2 4.5h15.6A9 9 0 0 0 21 13a9 9 0 0 0-9-9Zm0 2a7 7 0 0 1 7 7 7 7 0 0 1-.4 2.5H5.4A7 7 0 0 1 5 13a7 7 0 0 1 7-7Zm4.2 2.4-4.6 3.6a1.6 1.6 0 1 0 1.9 2.2l2.7-5.8Z';

  let sig = '';
  let busy = false;

  const tr = (key, fallback) => (typeof t === 'function' && t(key)) || fallback;

  function perf() {
    return typeof normalizePerformance === 'function' && typeof hubSettings === 'object' && hubSettings
      ? normalizePerformance(hubSettings.performance)
      : null;
  }

  function glyph() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', 'perf-tb-mark');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', GAUGE);
    svg.appendChild(path);
    return svg;
  }

  async function press() {
    const P = window.PerfMode;
    const p = perf();
    if (busy || !P || !p) return;
    busy = true;
    sync(true);
    try {
      if (p.active) await P.restore({ by: 'bar' });
      else await P.optimize({ by: 'manual' });
    } catch (e) {
      console.warn('[perf-marker] ' + (p.active ? 'restore' : 'optimize') + ' failed:', e && e.message);
    } finally {
      busy = false;
      sync(true);
    }
  }

  function build(on) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'perf-tb' + (on ? ' is-on' : '');
    btn.disabled = busy;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    const titleKey = on ? 'perf_bar_on_title' : 'perf_bar_off_title';
    btn.setAttribute('data-i18n-title', titleKey);
    btn.title = tr(titleKey, on ? 'Performance Mode is on. Tap to turn it off and get everything back' : 'Start Performance Mode');
    const label = document.createElement('span');
    label.className = 'perf-tb-label';
    const labelKey = on ? 'perf_bar_on' : 'perf_bar_off';
    label.setAttribute('data-i18n', labelKey);
    label.textContent = tr(labelKey, on ? 'Performance on' : 'Performance');
    btn.append(glyph(), label);
    btn.addEventListener('click', press);
    return btn;
  }

  function sync(force) {
    const host = document.getElementById('clock-perf');
    const p = perf();
    if (!host || !p) return;
    const show = p.active || p.barAlways;
    const next = [show, p.active, busy].join('|');
    if (next === sig && !force) return;
    sig = next;
    if (!show) { host.hidden = true; host.replaceChildren(); }
    else { host.hidden = false; host.replaceChildren(build(p.active)); }
    // The island's width changed: let the minimal bar measure it again.
    const minimal = window.TopbarMinimal;
    if (minimal && typeof minimal.reflowIsland === 'function') minimal.reflowIsland();
  }

  window.addEventListener('xenon:perf-change', () => sync(false));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => sync(false));
  else sync(false);

  window.PerfMarker = { sync };
})();
