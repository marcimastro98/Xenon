// The Widget face (pump-face.html): a Store widget put on the pump ({ face: 'widget', id }),
// run by the dashboard's own sandbox in pump-widget.html, framed here. While that page
// cannot show it (Store widgets off, not approved, removed: its <html data-state>), the
// clock stands in, so a pump is never blank. Joins window.PumpFaceKit.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const SHAPES = ['round', 'square', 'wide'];
  // Seconds the host page may take to say anything before the clock stands in (the
  // engine restarting, a page that failed to load).
  const SILENT_TICKS = 4;

  function shapeOf(layer) {
    const root = layer.closest('.pf-root');
    return SHAPES.find((s) => root?.classList.contains('pf-shape-' + s)) || 'round';
  }

  // The line's look as the widget gets it (placement.look): four colours, size, and a unit
  // only when one was chosen for this line.
  function lookQuery(show) {
    const colors = window.PumpFaces.colorsOf(show.colors, Kit.prefs().accent) || window.PumpFaces.colorsOf('xenon');
    return { colors: colors.join(','), size: show.size || 'normal', ...(show.units === 'c' || show.units === 'f' ? { units: show.units } : {}) };
  }

  function create(layer, show) {
    const frame = Kit.el('iframe', 'pf-widget');
    frame.title = show.id;
    frame.src = '/pump-widget?' + new URLSearchParams({ id: show.id, shape: shapeOf(layer), ...lookQuery(show) });
    layer.append(frame);
    let stand = null;
    let silent = 0;

    // The host page is ours (same origin): its state is read, never anything it shows.
    function state() {
      try { return frame.contentDocument?.documentElement?.dataset.state || ''; } catch { return ''; }
    }

    function check() {
      const s = state();
      if (!s && ++silent < SILENT_TICKS) return;
      const off = s !== 'on';
      frame.hidden = off;
      if (off && !stand) {
        const clock = Kit.el('div', 'pf-face-in');
        layer.append(clock);
        stand = { node: clock, impl: Kit.get('face', 'clock')(clock, window.PumpFaces.normalizeFace({ face: 'clock', weather: false })) };
      } else if (!off && stand) {
        stand.impl.stop?.();
        stand.node.remove();
        stand = null;
      }
    }

    return {
      update(data) { stand?.impl.update(data); },
      tick() { check(); stand?.impl.tick?.(); },
      stop() { stand?.impl.stop?.(); frame.src = 'about:blank'; },
    };
  }

  Kit.add('face', 'widget', create);
})();
