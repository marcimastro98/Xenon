'use strict';

// ── No-code widget templates ─────────────────────────────────────────────────
// Pure, side-effect-free generator behind the in-app "Create widget" wizard. It
// turns a template id + a bag of user options into EXACTLY the payload the server
// install path already accepts — { id, files:[{ path, data(base64) }] } — so the
// security boundary is untouched (validateWidgetPayload/normalizeManifest stay the
// only gate; the sandbox CSP and grant flow are unchanged).
//
// The user never writes code. Each template's widget.js is a FIXED, audited string
// that reads a config object. Options travel as a JSON string injected with the
// same escape used for the animated background (custom-bg.js encodeForJsString):
// "<", ">" and the JS line terminators become \uXXXX, so "</script>" can never
// appear and the config can't break out of its string/JSON context. Free text
// (titles/labels) lives inside that config as DATA and only ever reaches the DOM
// via textContent — so a title of "<img onerror=…>" is inert.
//
// Dual-exported: window.WidgetTemplates in the browser, module.exports for tests.
(function () {
  'use strict';

  // Mirrors the server's WIDGET_ID_RE (sdk-widgets.js) so a generated id is
  // accepted on install without a round-trip.
  const WIDGET_ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

  // Font choices are a FIXED allowlist of CSS-safe stacks — never raw user text
  // into CSS. The option stores a key; css() maps it to the stack.
  const FONTS = {
    inter: 'Inter, "Segoe UI", system-ui, sans-serif',
    mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
    serif: 'Georgia, "Times New Roman", serif',
    round: '"Segoe UI Rounded", "Nunito", "Segoe UI", system-ui, sans-serif',
  };
  const FONT_KEYS = Object.keys(FONTS);
  const fontStack = (k) => FONTS[k] || FONTS.inter;

  const WARN_AT = 85; // meter threshold (%) at which a bar/ring turns to the warn colour

  // ── Encoding helpers ────────────────────────────────────────────────────────
  // Copy of custom-bg.js's encoder: JSON.stringify then escape <, > and the JS
  // line/paragraph separators to \uXXXX. Returns a quoted JS string literal.
  function encodeForJsString(code) {
    const json = JSON.stringify(String(code == null ? '' : code));
    let out = '';
    for (let i = 0; i < json.length; i++) {
      const cc = json.charCodeAt(i);
      if (cc === 0x3c || cc === 0x3e || cc === 0x2028 || cc === 0x2029) {
        out += '\\u' + ('000' + cc.toString(16)).slice(-4);
      } else {
        out += json[i];
      }
    }
    return out;
  }
  // UTF-8-safe base64, in Node (Buffer) or the browser (TextEncoder + btoa).
  function toBase64(str) {
    const s = String(str == null ? '' : str);
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(s, 'utf8').toString('base64');
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    ));
  }
  function slugId(raw) {
    let s = String(raw || '').toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!/^[a-z0-9]/.test(s)) s = 'w' + s;
    if (s.length < 2) s = (s + '-widget').slice(0, 40);
    return s;
  }

  // ── Shared widget-runtime scaffold ─────────────────────────────────────────
  // Every generated widget.js is: 'use strict' + the frozen CFG + this IIFE. The
  // template body defines onReady()/onStream(); the scaffold wires the SDK bridge.
  const SHARED_HEAD = [
    'var root=document.documentElement;',
    'function $(id){return document.getElementById(id);}',
    'function esc(v){return v==null?"":String(v);}',
    'function send(m){try{parent.postMessage(Object.assign({xenonSdk:1},m),"*");}catch(e){}}',
    // The widget keeps its OWN accent (CFG.accent); the theme only drives
    // background/text/appearance so it reads well in light and dark.
    'function applyTheme(t){if(!t||typeof t!=="object")return;if(t.background)root.style.setProperty("--bg",t.background);if(t.text)root.style.setProperty("--text",t.text);root.dataset.appearance=(t.appearance==="light")?"light":"dark";}',
  ];
  const SHARED_TAIL = [
    'var _ready=false;',
    'function ready(){if(_ready)return;_ready=true;if(typeof onReady==="function")onReady();}',
    'window.addEventListener("message",function(e){var m=e&&e.data;if(!m||typeof m!=="object"||m.xenonSdk!==1)return;if(m.type==="init"){applyTheme(m.theme);ready();}else if(m.type==="theme"){applyTheme(m.theme);}else if(m.type==="data"){if(typeof onStream==="function")onStream(m.stream,m.data);}});',
    // Render even if init is slow (stream-less widgets shouldn't wait on the host).
    'setTimeout(ready,400);',
    'send({type:"hello"});',
  ];
  function composeJs(cfg, bodyLines) {
    return "'use strict';\n"
      + 'var CFG=JSON.parse(' + encodeForJsString(JSON.stringify(cfg)) + ');\n'
      + '(function(){\n'
      + SHARED_HEAD.join('\n') + '\n'
      + bodyLines.join('\n') + '\n'
      + SHARED_TAIL.join('\n') + '\n'
      + '})();\n';
  }

  // Common CSS prefix: theme vars, reset, and the container so cqmin sizing works.
  function baseCss(cfg) {
    return ':root{--accent:' + (cfg.accent || '#7c5cff') + ';--bg:#07080c;--text:#eef1f6;--panel:rgba(255,255,255,0.05);--line:rgba(255,255,255,0.10);}\n'
      + ':root[data-appearance="light"]{--panel:rgba(0,0,0,0.05);--line:rgba(0,0,0,0.09);}\n'
      + '*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%}\n'
      + 'body{font-family:' + fontStack(cfg.font) + ';color:var(--text);background:transparent;overflow:hidden;display:flex;container-type:size;}\n';
  }

  const CLOCK_SIZE = { 1: 'clamp(1.5rem,14cqmin,2.4rem)', 2: 'clamp(2.1rem,24cqmin,3.6rem)', 3: 'clamp(2.6rem,34cqmin,5rem)' };
  const TEXT_SIZE = { 1: 'clamp(1.1rem,10cqmin,1.7rem)', 2: 'clamp(1.5rem,18cqmin,2.6rem)', 3: 'clamp(2rem,26cqmin,3.6rem)' };
  const METRIC_LABEL = { cpu: 'CPU', ram: 'RAM', gpu: 'GPU' };

  // ── Templates ───────────────────────────────────────────────────────────────
  const TEMPLATES = {
    // 1) Clock — no stream needed.
    clock: {
      id: 'clock', icon: '🕐',
      i18n: { name: 'wc_tpl_clock', desc: 'wc_tpl_clock_desc' },
      streams: () => [], actions: () => [],
      options: [
        { key: 'title', type: 'text', default: '', maxLength: 40, i18n: 'wc_opt_title' },
        { key: 'format24', type: 'toggle', default: true, i18n: 'wc_opt_24h' },
        { key: 'showSeconds', type: 'toggle', default: false, i18n: 'wc_opt_seconds' },
        { key: 'showDate', type: 'toggle', default: false, i18n: 'wc_opt_date' },
        { key: 'accent', type: 'color', default: '#7c5cff', i18n: 'wc_opt_accent' },
        { key: 'size', type: 'range', min: 1, max: 3, default: 2, i18n: 'wc_opt_size' },
        { key: 'font', type: 'font', default: 'inter', i18n: 'wc_opt_font' },
      ],
      body: () => '<main class="wc"><div class="wc-title" id="t"></div><div class="wc-time" id="c">--:--</div><div class="wc-date" id="d"></div></main>',
      css: (cfg) => baseCss(cfg)
        + '.wc{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;text-align:center;padding:8px}'
        + '.wc-title{font-size:0.78rem;font-weight:700;opacity:0.7;text-transform:uppercase;letter-spacing:0.08em}'
        + '.wc-time{font-weight:800;line-height:1;color:var(--accent);font-size:' + (CLOCK_SIZE[cfg.size] || CLOCK_SIZE[2]) + '}'
        + '.wc-date{font-size:0.85rem;opacity:0.65}',
      js: (cfg) => composeJs(cfg, [
        'function two(n){return (n<10?"0":"")+n;}',
        'function onReady(){',
        ' var tEl=$("t");tEl.textContent=esc(CFG.title);tEl.style.display=CFG.title?"block":"none";',
        ' var dEl=$("d");dEl.style.display=CFG.showDate?"block":"none";',
        ' function tick(){var n=new Date();var h=n.getHours();var ap="";',
        '  if(!CFG.format24){ap=h<12?" AM":" PM";h=h%12;if(h===0)h=12;}',
        '  var s=two(h)+":"+two(n.getMinutes());if(CFG.showSeconds)s+=":"+two(n.getSeconds());',
        '  $("c").textContent=s+ap;',
        '  if(CFG.showDate)dEl.textContent=n.toLocaleDateString();}',
        ' tick();setInterval(tick,CFG.showSeconds?1000:5000);',
        '}',
      ]),
    },

    // 2) System meter — CPU / RAM / GPU from the `system` stream.
    meter: {
      id: 'meter', icon: '📊',
      i18n: { name: 'wc_tpl_meter', desc: 'wc_tpl_meter_desc' },
      streams: () => ['system'], actions: () => [],
      options: [
        { key: 'title', type: 'text', default: 'System', maxLength: 40, i18n: 'wc_opt_title' },
        { key: 'metrics', type: 'multi', values: ['cpu', 'ram', 'gpu'], default: ['cpu', 'ram', 'gpu'], i18n: 'wc_opt_metrics' },
        { key: 'style', type: 'select', values: ['bar', 'ring'], default: 'bar', i18n: 'wc_opt_meterstyle' },
        { key: 'accent', type: 'color', default: '#1ed760', i18n: 'wc_opt_accent' },
        { key: 'warn', type: 'color', default: '#ff5a4a', i18n: 'wc_opt_warn' },
      ],
      body: (cfg) => {
        const ring = cfg.style === 'ring';
        const rows = (cfg.metrics && cfg.metrics.length ? cfg.metrics : ['cpu']).map((m) => (ring
          ? '<div class="wm-ring" data-m="' + m + '"><div class="wm-dial" id="dial-' + m + '"><span class="wm-rv" id="val-' + m + '">--</span></div><span class="wm-rk">' + METRIC_LABEL[m] + '</span></div>'
          : '<div class="wm-row" data-m="' + m + '"><span class="wm-k">' + METRIC_LABEL[m] + '</span><span class="wm-track"><i id="bar-' + m + '"></i></span><span class="wm-v" id="val-' + m + '">--%</span></div>'
        )).join('');
        return '<main class="wm ' + (ring ? 'is-ring' : 'is-bar') + '"><div class="wm-title" id="mt"></div><div class="wm-rows">' + rows + '</div></main>';
      },
      css: (cfg) => baseCss(cfg)
        + '.wm{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;padding:8px 4px;justify-content:center}'
        + '.wm-title{font-size:0.72rem;font-weight:800;opacity:0.6;text-transform:uppercase;letter-spacing:0.06em}'
        + '.wm-rows{display:flex;flex-direction:column;gap:8px}'
        + '.wm.is-ring .wm-rows{flex-direction:row;justify-content:space-around;align-items:center}'
        + '.wm-row{display:flex;align-items:center;gap:8px}'
        + '.wm-k{font-size:0.62rem;font-weight:800;opacity:0.6;width:30px}'
        + '.wm-track{flex:1;height:8px;border-radius:999px;background:var(--panel);overflow:hidden}'
        + '.wm-track i{display:block;height:100%;width:0;background:var(--accent);border-radius:999px;transition:width .4s ease}'
        + '.wm-v{font-size:0.8rem;font-weight:800;width:38px;text-align:right}'
        + '.wm-ring{display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}'
        + '.wm-dial{position:relative;width:clamp(46px,24cqmin,84px);aspect-ratio:1;display:flex;align-items:center;justify-content:center}'
        // The ring lives on ::before (masked to a donut so the centre is truly
        // transparent — it shows the tile behind, not a coloured hole). JS drives
        // --dp (fill degrees) and --dc (colour) so the arc animates.
        + '.wm-dial::before{content:"";position:absolute;inset:0;border-radius:50%;background:conic-gradient(var(--dc,var(--accent)) calc(var(--dp,0) * 1deg),var(--panel) 0);-webkit-mask:radial-gradient(closest-side,transparent 62%,#000 63%);mask:radial-gradient(closest-side,transparent 62%,#000 63%)}'
        + '.wm-rv{position:relative;font-size:0.8rem;font-weight:800}'
        + '.wm-rk{font-size:0.6rem;font-weight:800;opacity:0.6}',
      js: (cfg) => composeJs(cfg, [
        'var WARN=' + WARN_AT + ';',
        'function onReady(){var m=$("mt");m.textContent=esc(CFG.title);m.style.display=CFG.title?"block":"none";}',
        'function set(m,v){var n=Number(v);var has=Number.isFinite(n)&&v!==null;var p=has?Math.max(0,Math.min(100,Math.round(n))):0;',
        ' var vEl=$("val-"+m);if(vEl)vEl.textContent=has?p+"%":"--";',
        ' var bar=$("bar-"+m);if(bar){bar.style.width=p+"%";bar.style.background=(p>=WARN)?CFG.warn:"var(--accent)";}',
        ' var dial=$("dial-"+m);if(dial){dial.style.setProperty("--dp",p*3.6);dial.style.setProperty("--dc",(p>=WARN)?CFG.warn:"var(--accent)");}}',
        'function onStream(s,d){if(s!=="system"||!d||typeof d!=="object")return;set("cpu",d.cpu);set("ram",d.memory&&d.memory.percent);set("gpu",d.gpu);}',
      ]),
    },

    // 3) Now playing — from the `media` stream, optional transport keys.
    nowplaying: {
      id: 'nowplaying', icon: '🎵',
      i18n: { name: 'wc_tpl_nowplaying', desc: 'wc_tpl_nowplaying_desc' },
      streams: () => ['media'],
      actions: (cfg) => (cfg.showControls ? ['media'] : []),
      options: [
        { key: 'title', type: 'text', default: '', maxLength: 40, i18n: 'wc_opt_title' },
        { key: 'showArt', type: 'toggle', default: true, i18n: 'wc_opt_art' },
        { key: 'showControls', type: 'toggle', default: false, i18n: 'wc_opt_controls' },
        { key: 'accent', type: 'color', default: '#1db954', i18n: 'wc_opt_accent' },
      ],
      body: () => '<main class="wn"><div class="wn-title" id="nt"></div><div class="wn-main"><img class="wn-art" id="art" alt="" hidden><div class="wn-info"><div class="wn-track" id="track">—</div><div class="wn-artist" id="artist"></div></div></div><div class="wn-keys" id="keys" hidden><button id="prev" type="button" aria-label="Previous">⏮</button><button id="play" type="button" aria-label="Play/Pause">⏯</button><button id="next" type="button" aria-label="Next">⏭</button></div></main>',
      css: (cfg) => baseCss(cfg)
        + '.wn{flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;padding:8px 4px;justify-content:center}'
        + '.wn-title{font-size:0.72rem;font-weight:800;opacity:0.6;text-transform:uppercase;letter-spacing:0.06em}'
        + '.wn-main{display:flex;align-items:center;gap:10px;min-width:0}'
        + '.wn-art{width:clamp(38px,22cqmin,64px);aspect-ratio:1;border-radius:10px;object-fit:cover;flex:none;box-shadow:0 3px 10px rgba(0,0,0,0.35)}'
        + '.wn-info{min-width:0}'
        + '.wn-track{font-size:0.92rem;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '.wn-artist{font-size:0.72rem;font-weight:600;opacity:0.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--accent)}'
        + '.wn-keys{display:flex;gap:6px;justify-content:center}'
        + '.wn-keys button{font:inherit;font-size:0.9rem;width:34px;height:30px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--text);cursor:pointer}'
        + '.wn-keys button:hover{background:var(--accent);color:#08110b}',
      js: (cfg) => composeJs(cfg, [
        'var rid=0;',
        'function onReady(){var t=$("nt");t.textContent=esc(CFG.title);t.style.display=CFG.title?"block":"none";',
        ' if(!CFG.showArt){var a=$("art");if(a)a.remove();}',
        ' if(CFG.showControls){var k=$("keys");if(k)k.hidden=false;',
        '  function key(cmd){send({type:"action",id:++rid,action:{type:"media",cmd:cmd}});}',
        '  $("prev").addEventListener("click",function(){key("previous");});',
        '  $("play").addEventListener("click",function(){key("playpause");});',
        '  $("next").addEventListener("click",function(){key("next");});}}',
        'function onStream(s,d){if(s!=="media"||!d||typeof d!=="object")return;',
        ' var title=typeof d.title==="string"?d.title:"";var artist=typeof d.artist==="string"?d.artist:"";',
        ' $("track").textContent=title||"—";$("artist").textContent=artist;',
        ' if(CFG.showArt){var a=$("art");if(a){var th=typeof d.thumbnail==="string"?d.thumbnail:"";if(th.slice(0,5)==="data:"){a.src=th;a.hidden=false;}else{a.hidden=true;}}}}',
      ]),
    },

    // 4) Label — static text card, optional mic/gaming badge from `status`.
    label: {
      id: 'label', icon: '🏷️',
      i18n: { name: 'wc_tpl_label', desc: 'wc_tpl_label_desc' },
      streams: (cfg) => (cfg.showStatus ? ['status'] : []), actions: () => [],
      options: [
        { key: 'text', type: 'text', default: 'Hello', maxLength: 60, i18n: 'wc_opt_text' },
        { key: 'subtitle', type: 'text', default: '', maxLength: 60, i18n: 'wc_opt_subtitle' },
        { key: 'align', type: 'select', values: ['left', 'center', 'right'], default: 'center', i18n: 'wc_opt_align' },
        { key: 'showStatus', type: 'toggle', default: false, i18n: 'wc_opt_statusbadge' },
        { key: 'accent', type: 'color', default: '#7c5cff', i18n: 'wc_opt_accent' },
        { key: 'size', type: 'range', min: 1, max: 3, default: 2, i18n: 'wc_opt_size' },
        { key: 'font', type: 'font', default: 'inter', i18n: 'wc_opt_font' },
      ],
      body: () => '<main class="wl"><div class="wl-text" id="lt"></div><div class="wl-sub" id="ls"></div><div class="wl-badge" id="lb" hidden></div></main>',
      css: (cfg) => baseCss(cfg)
        + '.wl{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;padding:10px;justify-content:center;align-items:' + (cfg.align === 'left' ? 'flex-start' : cfg.align === 'right' ? 'flex-end' : 'center') + ';text-align:' + (cfg.align || 'center') + '}'
        + '.wl-text{font-weight:800;line-height:1.05;color:var(--accent);font-size:' + (TEXT_SIZE[cfg.size] || TEXT_SIZE[2]) + '}'
        + '.wl-sub{font-size:0.85rem;font-weight:600;opacity:0.7}'
        + '.wl-badge{margin-top:4px;font-size:0.66rem;font-weight:800;letter-spacing:0.06em;padding:3px 8px;border-radius:999px;background:var(--accent);color:#08110b}',
      js: (cfg) => composeJs(cfg, [
        'function onReady(){$("lt").textContent=esc(CFG.text);var s=$("ls");s.textContent=esc(CFG.subtitle);s.style.display=CFG.subtitle?"block":"none";}',
        'function onStream(st,d){if(st!=="status"||!CFG.showStatus||!d||typeof d!=="object")return;var b=$("lb");',
        ' if(d.muted){b.textContent="MUTED";b.hidden=false;}else if(d.gaming){b.textContent="GAMING";b.hidden=false;}else{b.hidden=true;}}',
      ]),
    },

    // 5) Countdown — no stream, ticks to a target datetime.
    countdown: {
      id: 'countdown', icon: '⏳',
      i18n: { name: 'wc_tpl_countdown', desc: 'wc_tpl_countdown_desc' },
      streams: () => [], actions: () => [],
      options: [
        { key: 'title', type: 'text', default: '', maxLength: 40, i18n: 'wc_opt_title' },
        { key: 'target', type: 'datetime', default: '', i18n: 'wc_opt_target' },
        { key: 'doneText', type: 'text', default: 'Done!', maxLength: 40, i18n: 'wc_opt_donetext' },
        { key: 'accent', type: 'color', default: '#ff9f43', i18n: 'wc_opt_accent' },
        { key: 'size', type: 'range', min: 1, max: 3, default: 2, i18n: 'wc_opt_size' },
      ],
      body: () => '<main class="wcd"><div class="wcd-title" id="ct"></div><div class="wcd-time" id="cv">--</div></main>',
      css: (cfg) => baseCss(cfg)
        + '.wcd{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;padding:8px;align-items:center;justify-content:center;text-align:center}'
        + '.wcd-title{font-size:0.78rem;font-weight:700;opacity:0.7;text-transform:uppercase;letter-spacing:0.06em}'
        + '.wcd-time{font-weight:800;line-height:1;color:var(--accent);font-variant-numeric:tabular-nums;font-size:' + (CLOCK_SIZE[cfg.size] || CLOCK_SIZE[2]) + '}',
      js: (cfg) => composeJs(cfg, [
        'function two(n){return (n<10?"0":"")+n;}',
        'function onReady(){var t=$("ct");t.textContent=esc(CFG.title);t.style.display=CFG.title?"block":"none";',
        ' var target=CFG.target?new Date(CFG.target.replace(" ","T")):null;',
        ' if(!target||isNaN(target.getTime())){$("cv").textContent="--";return;}',
        ' function tick(){var ms=target.getTime()-Date.now();',
        '  if(ms<=0){$("cv").textContent=esc(CFG.doneText);return;}',
        '  var s=Math.floor(ms/1000),d=Math.floor(s/86400),h=Math.floor(s%86400/3600),mi=Math.floor(s%3600/60),se=s%60;',
        '  $("cv").textContent=(d>0?d+"d ":"")+two(h)+":"+two(mi)+":"+two(se);}',
        ' tick();setInterval(tick,1000);',
        '}',
      ]),
    },
  };

  // ── Public generation API ───────────────────────────────────────────────────
  function listTemplates() {
    return Object.keys(TEMPLATES).map((id) => ({
      id, icon: TEMPLATES[id].icon, i18n: TEMPLATES[id].i18n,
      options: TEMPLATES[id].options.map((o) => ({ ...o })),
    }));
  }
  function defaultOptions(templateId) {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return {};
    const out = {};
    tpl.options.forEach((o) => { out[o.key] = Array.isArray(o.default) ? o.default.slice() : o.default; });
    return out;
  }
  function normField(opt, v) {
    switch (opt.type) {
      case 'text': {
        const s = (v == null) ? '' : String(v);
        return s.slice(0, opt.maxLength || 60);
      }
      case 'color':
        return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v.trim())) ? v.trim().toLowerCase() : opt.default;
      case 'toggle':
        return (v == null) ? !!opt.default : !!v;
      case 'select':
        return opt.values.includes(v) ? v : opt.default;
      case 'font':
        return FONT_KEYS.includes(v) ? v : opt.default;
      case 'range': {
        const n = Number(v);
        if (!Number.isFinite(n)) return opt.default;
        return Math.min(opt.max, Math.max(opt.min, Math.round(n)));
      }
      case 'multi': {
        const arr = Array.isArray(v) ? v.filter((x) => opt.values.includes(x)) : [];
        return arr.length ? arr : opt.default.slice();
      }
      case 'datetime':
        return (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}$/.test(v)) ? v.slice(0, 16) : '';
      default:
        return opt.default;
    }
  }
  function normalizeOptions(templateId, raw) {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return {};
    const r = (raw && typeof raw === 'object') ? raw : {};
    const out = {};
    tpl.options.forEach((opt) => { out[opt.key] = normField(opt, r[opt.key]); });
    return out;
  }

  function wrapFileHtml(bodyInner, name) {
    return '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + '<meta name="viewport" content="width=device-width, initial-scale=1">'
      + '<title>' + escHtml(name || 'Widget') + '</title>'
      + '<link rel="stylesheet" href="widget.css"></head><body>\n'
      + bodyInner + '\n<script src="widget.js"></scr' + 'ipt>\n</body></html>';
  }

  // Build the installable payload. `spec.id` is used as-is when valid (the wizard
  // derives + dedupes it); otherwise it's slugged from the name/template.
  function buildWidgetPayload(spec) {
    const s = spec || {};
    const tpl = TEMPLATES[s.templateId];
    if (!tpl) return null;
    const id = WIDGET_ID_RE.test(String(s.id || '')) ? s.id : slugId(s.id || s.name || tpl.id);
    if (!WIDGET_ID_RE.test(id)) return null;
    const name = (String(s.name || '').trim() || tpl.id).slice(0, 60);
    const author = String(s.author || '').trim().slice(0, 60);
    const cfg = normalizeOptions(s.templateId, s.options || {});
    const manifest = {
      api: 1, id, name, version: '1.0.0',
      author, description: String(s.description || '').slice(0, 200),
      entry: 'index.html',
      streams: tpl.streams(cfg),
      actions: tpl.actions(cfg),
    };
    const xgen = { v: 1, template: s.templateId, options: cfg };
    const files = [
      { path: 'manifest.json', text: JSON.stringify(manifest, null, 2) },
      { path: 'index.html', text: wrapFileHtml(tpl.body(cfg), name) },
      { path: 'widget.css', text: tpl.css(cfg) },
      { path: 'widget.js', text: tpl.js(cfg) },
      { path: 'xgen.json', text: JSON.stringify(xgen) },
    ];
    return { id, files: files.map((f) => ({ path: f.path, data: toBase64(f.text) })) };
  }

  // Self-contained srcdoc for the LIVE PREVIEW iframe (sandbox allow-scripts,
  // null-origin, connect-src 'none'). script-src 'unsafe-inline' is used ONLY for
  // this preview document (mirrors custom-bg.js) and never ships — the installed
  // widget always gets the server's strict CSP. A mock host (widget-creator.js)
  // feeds it init + sample data.
  const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
  function buildPreviewDoc(templateId, options) {
    const tpl = TEMPLATES[templateId];
    if (!tpl) return '';
    const cfg = normalizeOptions(templateId, options);
    return '<!doctype html><html><head><meta charset="utf-8">'
      + '<meta http-equiv="Content-Security-Policy" content="' + PREVIEW_CSP + '">'
      + '<style>' + tpl.css(cfg) + '</style></head><body>'
      + tpl.body(cfg)
      + '<script>' + tpl.js(cfg) + '</scr' + 'ipt></body></html>';
  }

  const api = {
    TEMPLATES, FONTS, FONT_KEYS, WIDGET_ID_RE,
    listTemplates, defaultOptions, normalizeOptions,
    buildWidgetPayload, buildPreviewDoc, slugId, encodeForJsString,
  };
  if (typeof window !== 'undefined') window.WidgetTemplates = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
