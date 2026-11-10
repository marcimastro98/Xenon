'use strict';
// Canvas Ambient editor — what can be changed, and the form that changes it.
//
// The option lists mirror js/ambient-scene.js (the normalizer is still the
// boundary: whatever the form writes is normalized again before it is drawn or
// saved). A field is { path, label, kind, ... }:
//   pick  options [[value, labelKey]]      bool  a switch
//   range min/max/step/unit (a slider)     num   min/max (a number box)
//   color a colour well                    text  a multi-line box
//   time  minutes from midnight            days  weekday toggles
//   stops gradient colours                 image  a picture from this PC
// `when(obj)` hides a field that does not apply; `live` fields (geometry)
// repaint without a rebuild.

(function () {
  if (typeof window === 'undefined') return;

  const o = (...values) => values.map(v => [v, 'ace_o_' + String(v).replace(/-/g, '_')]);
  const ALIGN = { path: 'props.align', label: 'ace_f_align', kind: 'pick', options: o('left', 'center', 'right') };
  const WEIGHT = (path) => ({ path, label: 'ace_f_weight', kind: 'range', min: 100, max: 900, step: 100 });
  const COUNT = (max) => ({ path: 'props.count', label: 'ace_f_count', kind: 'range', min: 1, max, step: 1 });
  const CONTROLS = { path: 'props.controls', label: 'ace_f_controls', kind: 'bool' };
  const notAnalog = (c) => c.props.style !== 'analog';

  // Per element type, the options group. Labels for the type itself: ace_t_<type>.
  const BY_TYPE = {
    clock: [
      { path: 'props.style', label: 'ace_f_style', kind: 'pick', options: o('digital', 'stacked', 'analog') },
      { path: 'props.format', label: 'ace_f_format', kind: 'pick', options: [['auto', 'ace_o_auto'], ['24', 'ace_o_24h'], ['12', 'ace_o_12h']], when: notAnalog },
      { path: 'props.seconds', label: 'ace_f_seconds', kind: 'bool' },
      { path: 'props.ampm', label: 'ace_f_ampm', kind: 'bool', when: notAnalog },
      { path: 'props.blink', label: 'ace_f_blink', kind: 'bool', when: notAnalog },
      { path: 'props.marks', label: 'ace_f_marks', kind: 'bool', when: (c) => c.props.style === 'analog' },
      Object.assign(WEIGHT('props.weight'), { when: notAnalog }),
      ALIGN,
    ],
    date: [
      { path: 'props.variant', label: 'ace_f_variant', kind: 'pick', options: o('full', 'long', 'weekday', 'day', 'short', 'numeric') },
      { path: 'props.uppercase', label: 'ace_f_uppercase', kind: 'bool' },
      ALIGN,
    ],
    weather: [
      { path: 'props.icon', label: 'ace_f_icon', kind: 'bool' },
      { path: 'props.cond', label: 'ace_f_cond', kind: 'bool' },
      { path: 'props.place', label: 'ace_f_place', kind: 'bool' },
      { path: 'props.layout', label: 'ace_f_layout', kind: 'pick', options: o('stack', 'row') },
      ALIGN,
    ],
    media: [
      { path: 'props.art', label: 'ace_f_art', kind: 'bool' },
      { path: 'props.artist', label: 'ace_f_artist', kind: 'bool' },
      { path: 'props.layout', label: 'ace_f_layout', kind: 'pick', options: [['row', 'ace_o_side'], ['stack', 'ace_o_stack']] },
      CONTROLS,
    ],
    agenda: [COUNT(6), { path: 'props.time', label: 'ace_f_time', kind: 'bool' }],
    tasks: [COUNT(8), { path: 'props.showDone', label: 'ace_f_show_done', kind: 'bool' }, CONTROLS],
    notifications: [COUNT(6), { path: 'props.body', label: 'ace_f_body', kind: 'bool' }, CONTROLS],
    volume: [{ path: 'props.step', label: 'ace_f_step', kind: 'range', min: 1, max: 20, step: 1, unit: '%' }, CONTROLS],
    notes: [ALIGN],
    system: [
      { path: 'props.metric', label: 'ace_f_metric', kind: 'pick', options: [['all', 'ace_o_all'], ['cpu', 'ace_o_cpu'], ['gpu', 'ace_o_gpu'], ['ram', 'ace_o_ram']] },
      { path: 'props.style', label: 'ace_f_style', kind: 'pick', options: o('text', 'bars', 'rings') },
    ],
    network: [
      { path: 'props.show', label: 'ace_f_show', kind: 'pick', options: o('both', 'down', 'up') },
      ALIGN,
    ],
    text: [
      { path: 'props.text', label: 'ace_f_text', kind: 'text' },
      { path: 'props.size', label: 'ace_f_text_size', kind: 'range', min: 8, max: 480, step: 1, unit: 'px' },
      WEIGHT('props.weight'),
      { path: 'props.color', label: 'ace_f_color', kind: 'color' },
      ALIGN,
      { path: 'props.valign', label: 'ace_f_valign', kind: 'pick', options: o('top', 'center', 'bottom') },
      { path: 'props.italic', label: 'ace_f_italic', kind: 'bool' },
      { path: 'props.uppercase', label: 'ace_f_uppercase', kind: 'bool' },
      { path: 'props.spacing', label: 'ace_f_spacing', kind: 'range', min: -10, max: 50, step: 1 },
      { path: 'props.lineHeight', label: 'ace_f_line_height', kind: 'range', min: 80, max: 250, step: 5, unit: '%' },
      { path: 'props.glow', label: 'ace_f_glow', kind: 'range', min: 0, max: 40, step: 1, unit: 'px' },
    ],
    image: [
      { path: 'props.url', label: 'ace_f_picture', kind: 'image' },
      { path: 'props.fit', label: 'ace_f_fit', kind: 'pick', options: o('cover', 'contain', 'fill') },
      { path: 'props.radius', label: 'ace_f_radius', kind: 'range', min: 0, max: 50, step: 1, unit: 'px' },
      { path: 'props.grayscale', label: 'ace_f_grayscale', kind: 'bool' },
      { path: 'props.focusX', label: 'ace_f_focus_x', kind: 'range', min: 0, max: 100, step: 1, unit: '%' },
      { path: 'props.focusY', label: 'ace_f_focus_y', kind: 'range', min: 0, max: 100, step: 1, unit: '%' },
    ],
    shape: [
      { path: 'props.kind', label: 'ace_f_kind', kind: 'pick', options: o('rect', 'ellipse', 'pill', 'ring', 'line') },
      { path: 'props.color', label: 'ace_f_color', kind: 'color' },
      { path: 'props.grad', label: 'ace_f_gradient', kind: 'stops', when: (c) => c.props.kind !== 'ring' },
      { path: 'props.radius', label: 'ace_f_radius', kind: 'range', min: 0, max: 50, step: 1, unit: 'px', when: (c) => c.props.kind === 'rect' },
      { path: 'props.borderColor', label: 'ace_f_border_color', kind: 'color' },
      { path: 'props.borderWidth', label: 'ace_f_border', kind: 'range', min: 0, max: 20, step: 1, unit: 'px' },
      { path: 'props.blur', label: 'ace_f_soft', kind: 'range', min: 0, max: 80, step: 1, unit: 'px' },
    ],
    sdk: [],
  };

  // Every element: where it sits, how it looks, how it moves, when it shows.
  const PLACE = [
    { path: 'x', label: 'ace_f_x', kind: 'num', min: 0, max: 100, live: true },
    { path: 'y', label: 'ace_f_y', kind: 'num', min: 0, max: 100, live: true },
    { path: 'w', label: 'ace_f_w', kind: 'num', min: 2, max: 100, live: true },
    { path: 'h', label: 'ace_f_h', kind: 'num', min: 2, max: 100, live: true },
    { path: 'rot', label: 'ace_f_rot', kind: 'range', min: -180, max: 180, step: 1, unit: '°' },
  ];
  const SCALED = (c) => !['text', 'image', 'shape', 'sdk'].includes(c.type);
  const LOOK = [
    { path: 'opacity', label: 'ace_f_opacity', kind: 'range', min: 0, max: 100, step: 5, unit: '%', fallback: 100 },
    { path: 'scale', label: 'ace_f_scale', kind: 'range', min: 50, max: 300, step: 10, unit: '%', fallback: 100, when: SCALED },
  ];
  const MOTION = [
    { path: 'anim.in', label: 'ace_f_in', kind: 'pick', options: o('none', 'fade', 'rise', 'drop', 'zoom', 'pop', 'slide-left', 'slide-right'), fallback: 'none' },
    { path: 'anim.loop', label: 'ace_f_loop', kind: 'pick', options: o('none', 'float', 'breathe', 'pulse', 'sway', 'drift', 'spin', 'blink'), fallback: 'none' },
    { path: 'anim.speed', label: 'ace_f_speed', kind: 'range', min: 0.25, max: 4, step: 0.25, unit: '×', fallback: 1, when: (c) => !!c.anim },
    { path: 'anim.delay', label: 'ace_f_delay', kind: 'range', min: 0, max: 10, step: 0.5, unit: 's', fallback: 0, when: (c) => !!(c.anim && c.anim.in !== 'none') },
  ];
  const WHEN = [
    { path: 'page', label: 'ace_f_page', kind: 'page' },
    { path: 'show', label: 'ace_f_hours', kind: 'time' },
    { path: 'show.days', label: 'ace_f_days', kind: 'days' },
  ];
  function elementGroups(comp) {
    const groups = [];
    const opts = BY_TYPE[comp.type] || [];
    if (opts.length) groups.push({ title: 'ace_sec_options', fields: opts });
    groups.push({ title: 'ace_sec_place', fields: PLACE });
    groups.push({ title: 'ace_sec_look', fields: LOOK });
    groups.push({ title: 'ace_sec_motion', fields: MOTION });
    groups.push({ title: 'ace_sec_when', fields: WHEN });
    return groups;
  }

  // The scene itself: name, background, pages.
  const hasGrad = (s) => s.bg.type === 'gradient' || s.bg.type === 'wallpaper';
  function sceneGroups() {
    return [
      { title: '', fields: [{ path: 'name', label: 'ace_f_name', kind: 'line' }] },
      { title: 'ace_sec_bg', fields: [
        { path: 'bg.type', label: 'ace_f_bg_type', kind: 'pick', options: [['color', 'ace_o_color'], ['gradient', 'ace_o_gradient'], ['image', 'ace_o_picture'], ['wallpaper', 'ace_o_wallpaper']] },
        { path: 'bg.color', label: 'ace_f_color', kind: 'color', when: (s) => s.bg.type === 'color' || (s.bg.type === 'wallpaper' && !s.bg.grad) },
        { path: 'bg.grad', label: 'ace_f_gradient', kind: 'stops', when: hasGrad },
        { path: 'bg.url', label: 'ace_f_picture', kind: 'image', when: (s) => s.bg.type === 'image' },
        { path: 'bg.dim', label: 'ace_f_dim', kind: 'range', min: 0, max: 100, step: 5, unit: '%' },
        { path: 'bg.blur', label: 'ace_f_blur', kind: 'range', min: 0, max: 30, step: 1, unit: 'px' },
        { path: 'bg.motion', label: 'ace_f_motion', kind: 'pick', options: o('none', 'drift', 'zoom', 'pan'), fallback: 'none' },
      ] },
      { title: 'ace_sec_pages', fields: [
        { path: 'pages.count', label: 'ace_f_pages', kind: 'range', min: 1, max: 6, step: 1, fallback: 1 },
        { path: 'pages.every', label: 'ace_f_every', kind: 'range', min: 5, max: 300, step: 5, unit: 's', fallback: 30, when: (s) => !!s.pages },
        { path: 'pages.transition', label: 'ace_f_transition', kind: 'pick', options: o('fade', 'slide', 'none'), fallback: 'fade', when: (s) => !!s.pages },
      ] },
    ];
  }

  // A new element's size (percent of the stage) and starting props.
  const NEW_SIZE = {
    clock: [24, 34], date: [26, 10], weather: [16, 28], media: [28, 24], agenda: [22, 36],
    tasks: [22, 36], notes: [22, 36], system: [20, 32], network: [16, 18], notifications: [24, 40],
    volume: [18, 22], text: [30, 16], image: [18, 40], shape: [16, 30], sdk: [24, 44],
  };
  const NEW_PROPS = { text: { text: 'Text', size: 40 }, shape: { color: '#2a3350' } };
  const ADD_ORDER = ['clock', 'date', 'weather', 'media', 'agenda', 'tasks', 'notes', 'system', 'network', 'notifications', 'volume', 'text', 'image', 'shape'];

  window.AmbientEditorFields = { elementGroups, sceneGroups, NEW_SIZE, NEW_PROPS, ADD_ORDER };
})();
