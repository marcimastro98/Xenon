// The Widget face (pump-face.html): a Store widget put on the pump ({ face: 'widget', id }),
// or the screen's style drawing a line (show.line, pump-faces.js drawnShow), run by the
// dashboard's own sandbox in pump-widget.html, framed here. While that page cannot show it
// (Store widgets off, not approved, removed: its <html data-state>), the clock stands in, or
// the line as Xenon draws it, so a pump is never blank. Joins window.PumpFaceKit.
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

  // The line's colours: four, too hot and the colour behind.
  function lineColors(show) {
    const Faces = window.PumpFaces;
    return { colors: Faces.colorsOf(show.colors, Kit.prefs().accent) || Faces.colorsOf('xenon'), ...Faces.edgesOf(show.colors) };
  }

  // The line's look as the widget gets it (placement.look): its colours, size, a unit only when one
  // was chosen for this line, and whether its colours follow it.
  function lookQuery(show) {
    const Faces = window.PumpFaces;
    const { colors, warn, background } = lineColors(show);
    return {
      colors: colors.join(','), warn, background, size: show.size || 'normal',
      ...(show.units === 'c' || show.units === 'f' ? { units: show.units } : {}),
      ...(Faces.colorSetOf(show) === 'live' ? { live: '1' } : {}),
      ...(show.line ? { line: show.line.face, moment: show.line.moment } : {}),
      ...(show.line && Array.isArray(show.readings) ? { readings: show.readings.join(',') } : {}),
    };
  }

  // What stands in: the line itself as Xenon draws it, or the clock for a widget of its own.
  function standIn(show) {
    const own = show.line ? { ...show, drawn: undefined, id: undefined, line: undefined } : null;
    return own && Kit.get('face', own.face) ? own : window.PumpFaces.normalizeFace({ face: 'clock', weather: false });
  }

  function create(layer, show) {
    const frame = Kit.el('iframe', 'pf-widget');
    frame.title = show.id;
    frame.src = '/pump-widget?' + new URLSearchParams({ id: show.id, shape: shapeOf(layer), ...lookQuery(show) });
    layer.append(frame);
    let stand = null;
    let silent = 0;
    let last = null;

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
        const node = Kit.el('div', 'pf-face-in');
        const own = standIn(show);
        layer.append(node);
        stand = { node, impl: Kit.get('face', own.face)(node, own) };
        if (last) stand.impl.update(last);
      } else if (!off && stand) {
        stand.impl.stop?.();
        stand.node.remove();
        stand = null;
      }
    }

    return {
      update(data) { last = data; stand?.impl.update(data); },
      tick() { check(); stand?.impl.tick?.(); },
      // A style that takes the pump's alerts (pump-widget-host.js): how Xenon writes them over it, in
      // the line's colours; null while the clock or Xenon stands in, or it does not take them.
      alertsLook() {
        if (frame.hidden) return null;
        let mode = null;
        try { mode = frame.contentWindow?.pumpAlertsLook?.() || null; } catch { mode = null; }
        return mode ? { mode, ...lineColors(show) } : null;
      },
      alert(a) { try { frame.contentWindow?.pumpAlertTell?.(a); } catch { /* the page is going */ } },
      stop() { stand?.impl.stop?.(); frame.src = 'about:blank'; },
    };
  }

  Kit.add('face', 'widget', create);
})();
