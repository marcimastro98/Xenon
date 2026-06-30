/*
 * Build the CORSAIR-facing deliverable for the Xenon native widget collection.
 *
 * Output (into icue/release/):
 *   - Xenon-Widgets.html  — one self-contained gallery page (icons embedded as
 *     base64 so it opens anywhere with no assets), grouped by roadmap phase, with
 *     each widget's native approach, status and honest native limitations.
 *   - copies of every dist/xenon-*.icuewidget                 (the installables)
 *   - README.md                                                (install + caveats)
 *
 * Run after packaging:  node icue/tools/gallery.mjs
 * Widget facts live in WIDGETS below — the single place to edit copy.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");                 // icue/
const widgetsDir = join(root, "widgets");
const distDir = join(root, "dist");
const outDir = join(root, "release");

// Single source of truth for the deliverable copy. `id` = widget folder name.
const WIDGETS = [
  { id: "clock", name: "Clock", approach: "Pure UI + Intl — locale-aware date, 12/24-hour, smooth tick.",
    limits: "No external dependency; works fully offline." , status: "ready" },
  { id: "system", name: "System Monitor", approach: "Sensors plugin — CPU / GPU / RAM load and temperature with live sparklines.",
    limits: "Disk, network, ping and used/total-GB RAM have no iCUE sensor, so they stay on the companion server.", status: "ready" },
  { id: "fps", name: "In-game FPS", approach: "Sensors plugin (fps type) — live framerate, performance-coloured, with a sparkline.",
    limits: "Shows an idle state until a running game feeds the fps sensor.", status: "ready" },
  { id: "notes", name: "Notes", approach: "Auto-saving scratchpad (500 ms debounce) with a clear save-status indicator.",
    limits: "Stored on the device; cross-device sync arrives with the Phase-4 companion bridge.", status: "ready" },
  { id: "tasks", name: "Tasks", approach: "To-do list with colour-coded priority and daily / weekly / custom recurrence.",
    limits: "Local persistence; recurring items reactivate when their interval elapses.", status: "ready" },
  { id: "timers", name: "Timers", approach: "Countdown timers with an SVG progress ring, pause / restart, and a Web-Audio chime + toast.",
    limits: "The alarm fires only while the widget is open (a widget has no background process).", status: "ready" },
  { id: "calendar", name: "Calendar", approach: "Month calendar with local events and reminders — tap a day to add, time and reminder via the shared dropdown.",
    limits: "External .ics sync needs the Phase-2 Network plugin; reminders fire only while the widget is open.", status: "ready" },
  { id: "media", name: "Media (preview)", approach: "Now-playing title / artist with play / previous / next transport via the Media plugin.",
    limits: "Reduced preview: no cover art, source identity, progress or play-state read-back until a richer Media plugin lands (Phase 2).", status: "preview" }
];

function iconDataUri(id) {
  const p = join(widgetsDir, id, "resources", "icon.png");
  if (!existsSync(p)) return "";
  return "data:image/png;base64," + readFileSync(p).toString("base64");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pkgInfo(id) {
  const file = "xenon-" + id + ".icuewidget";
  const p = join(distDir, file);
  if (!existsSync(p)) return { file: file, kb: null };
  return { file: file, kb: Math.max(1, Math.round(statSync(p).size / 1024)) };
}

const readyCards = WIDGETS.filter(function (w) { return w.status === "ready"; });
const previewCards = WIDGETS.filter(function (w) { return w.status === "preview"; });

function card(w) {
  const pk = pkgInfo(w.id);
  const pill = w.status === "ready"
    ? '<span class="pill pill-ready">Phase 1 · ready</span>'
    : '<span class="pill pill-preview">Phase 2 · preview</span>';
  const size = pk.kb ? (pk.kb + " KB") : "—";
  return [
    '<article class="card">',
    '  <div class="card-head">',
    '    <img class="ico" alt="" src="' + iconDataUri(w.id) + '">',
    '    <div class="card-head-text">',
    '      <h3>' + esc(w.name) + '</h3>',
    '      ' + pill,
    '    </div>',
    '  </div>',
    '  <p class="approach">' + esc(w.approach) + '</p>',
    '  <p class="limits"><span>Native scope</span>' + esc(w.limits) + '</p>',
    '  <div class="pkg"><code>' + esc(pk.file) + '</code><span class="pkg-size">' + size + '</span></div>',
    '</article>'
  ].join("\n");
}

const html = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="UTF-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<title>Xenon — Native iCUE Widgets</title>',
  '<style>',
  ':root{--bg:#0b0f10;--panel:#11181a;--line:rgba(255,255,255,.08);--text:#eef3f1;--muted:#9fb0ab;--dim:#6b7a76;--accent:#1ed760;}',
  '*{box-sizing:border-box;}',
  'body{margin:0;background:radial-gradient(120% 80% at 50% -10%,#101a1b 0%,var(--bg) 60%);color:var(--text);',
  'font-family:Inter,"Segoe UI",Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;}',
  '.wrap{max-width:1080px;margin:0 auto;padding:56px 28px 80px;}',
  'header.top{margin-bottom:40px;}',
  '.brand{display:flex;align-items:center;gap:14px;}',
  '.brand .dot{width:14px;height:14px;border-radius:50%;background:var(--accent);box-shadow:0 0 18px var(--accent);}',
  '.brand h1{font-size:30px;margin:0;letter-spacing:-.02em;font-weight:800;}',
  '.sub{color:var(--muted);margin:10px 0 0;font-size:17px;}',
  '.lead{color:var(--muted);max-width:760px;margin:22px 0 0;font-size:15px;}',
  '.lead strong{color:var(--text);font-weight:600;}',
  'h2.sec{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);font-weight:800;',
  'margin:46px 0 16px;display:flex;align-items:center;gap:12px;}',
  'h2.sec::after{content:"";flex:1;height:1px;background:var(--line);}',
  '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px;}',
  '.card{background:linear-gradient(180deg,var(--panel),#0d1314);border:1px solid var(--line);border-radius:18px;',
  'padding:20px;display:flex;flex-direction:column;gap:12px;}',
  '.card-head{display:flex;align-items:center;gap:14px;}',
  '.ico{width:52px;height:52px;border-radius:13px;flex:0 0 auto;}',
  '.card-head-text h3{margin:0 0 6px;font-size:18px;font-weight:700;}',
  '.pill{font-size:11px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;padding:3px 9px;border-radius:999px;}',
  '.pill-ready{color:var(--accent);background:color-mix(in srgb,var(--accent) 16%,transparent);border:1px solid color-mix(in srgb,var(--accent) 38%,transparent);}',
  '.pill-preview{color:#f2c14e;background:rgba(242,193,78,.13);border:1px solid rgba(242,193,78,.34);}',
  '.approach{margin:0;font-size:14.5px;color:#d6e1dd;}',
  '.limits{margin:0;font-size:13px;color:var(--muted);padding-top:10px;border-top:1px dashed var(--line);}',
  '.limits span{display:block;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);font-weight:800;margin-bottom:3px;}',
  '.pkg{margin-top:auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding-top:6px;}',
  '.pkg code{font-size:12px;color:var(--muted);background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:7px;padding:4px 8px;}',
  '.pkg-size{font-size:12px;color:var(--dim);}',
  '.notes{margin-top:48px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:24px 26px;}',
  '.notes h3{margin:0 0 6px;font-size:16px;}',
  '.notes p{color:var(--muted);font-size:14px;margin:8px 0 0;}',
  '.notes .warn{color:#f2c14e;}',
  '.phaselist{margin:14px 0 0;padding:0;list-style:none;display:grid;gap:8px;}',
  '.phaselist li{font-size:13.5px;color:var(--muted);}',
  '.phaselist b{color:var(--text);font-weight:600;}',
  'footer{margin-top:40px;color:var(--dim);font-size:12.5px;text-align:center;}',
  '</style>',
  '</head>',
  '<body>',
  '<div class="wrap">',
  '  <header class="top">',
  '    <div class="brand"><span class="dot"></span><h1>Xenon — Native iCUE Widgets</h1></div>',
  '    <p class="sub">Widget collection for the CORSAIR Xeneon Edge · Phase 1 deliverable</p>',
  '    <p class="lead">Each tile is a faithful native conversion of the production Xenon web dashboard, rebuilt as a ',
  '    standalone iCUE HTML widget. Build order follows <strong>native feasibility = roadmap phase</strong>: Phase 1 ships ',
  '    day-one at full fidelity with no SDK changes. Every widget shares one picker group (<strong>"Xenon"</strong>) and a ',
  '    common runtime library, is multilingual (EN / IT / KO / JA / ZH), and personalizes via the standard iCUE ',
  '    text / accent / background / transparency properties.</p>',
  '  </header>',
  '',
  '  <h2 class="sec">Phase 1 — ready today</h2>',
  '  <div class="grid">',
  readyCards.map(card).join("\n"),
  '  </div>',
  '',
  '  <h2 class="sec">Phase 2 — preview</h2>',
  '  <div class="grid">',
  previewCards.map(card).join("\n"),
  '  </div>',
  '',
  '  <div class="notes">',
  '    <h3>Installation</h3>',
  '    <p>Import each <code>.icuewidget</code> file through iCUE\'s widget import. All installed tiles appear together ',
  '    under the <b>Xenon</b> group in the widget picker.</p>',
  '    <h3 style="margin-top:18px;">Verification &amp; a known environmental blocker</h3>',
  '    <p>Every widget is verified at the three Xeneon Edge canvas sizes (bar 840×344, vertical-S 696×416, square 416×416) ',
  '    in the QtWebEngine-equivalent browser: layout, persistence, live data, localisation and interaction.</p>',
  '    <p class="warn">On-device verification inside iCUE is currently blocked: iCUE 5.47.101 crashes when adding <b>any</b> ',
  '    HTML widget to the Xeneon Edge — this reproduces with CORSAIR\'s own sample widgets, so it is an iCUE/Edge issue, not ',
  '    a widget defect. The widgets are ready to validate on-device as soon as that crash is resolved.</p>',
  '    <h3 style="margin-top:18px;">What the later phases unlock</h3>',
  '    <ul class="phaselist">',
  '      <li><b>Phase 2</b> (richer Media plugin · Network/HTTP plugin): full Media tile · Weather · Calendar .ics sync · Focus / lock display.</li>',
  '      <li><b>Phase 3</b> (Audio plugin · System/Action plugin): microphone · audio &amp; per-app mixer · Deck · app switcher · Performance.</li>',
  '      <li><b>Phase 4</b> (local companion bridge): Xenon AI · RGB lighting · streaming · remote control · browser &amp; second-screen tiles.</li>',
  '    </ul>',
  '  </div>',
  '',
  '  <footer>Generated from the live widget sources &amp; built packages — Xenon for CORSAIR Xeneon Edge.</footer>',
  '</div>',
  '</body>',
  '</html>'
].join("\n");

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "Xenon-Widgets.html"), html, "utf8");

// Copy the installable packages alongside the gallery.
let copied = 0;
WIDGETS.forEach(function (w) {
  const src = join(distDir, "xenon-" + w.id + ".icuewidget");
  if (existsSync(src)) { cpSync(src, join(outDir, "xenon-" + w.id + ".icuewidget")); copied++; }
  else console.warn("[gallery] missing package for " + w.id + " — run package.mjs first");
});

// README for the bundle.
const readme = [
  "# Xenon — Native iCUE Widgets (Phase 1 deliverable)",
  "",
  "Native iCUE HTML widgets for the CORSAIR Xeneon Edge, converted faithfully from the",
  "production Xenon web dashboard. Open **Xenon-Widgets.html** for the visual gallery.",
  "",
  "## Contents",
  "",
  WIDGETS.map(function (w) {
    const pk = pkgInfo(w.id);
    const tag = w.status === "ready" ? "Phase 1" : "Phase 2 preview";
    return "- `" + pk.file + "` — **" + w.name + "** (" + tag + ")";
  }).join("\n"),
  "",
  "## Install",
  "",
  "Import each `.icuewidget` through iCUE's widget import. All tiles appear under the",
  "**Xenon** group in the widget picker. Each widget personalizes via the standard iCUE",
  "text / accent / background / transparency properties and is multilingual (EN/IT/KO/JA/ZH).",
  "",
  "## Status note",
  "",
  "Widgets are verified at the three Xeneon Edge canvas sizes in the QtWebEngine-equivalent",
  "browser. On-device verification inside iCUE is currently blocked by an iCUE 5.47.101 crash",
  "when adding any HTML widget to the Xeneon Edge (reproduces with CORSAIR's own sample",
  "widgets) — an iCUE/Edge issue, not a widget defect.",
  ""
].join("\n");
writeFileSync(join(outDir, "README.md"), readme, "utf8");

console.log("[gallery] wrote release/Xenon-Widgets.html + README.md + " + copied + " packages -> " + outDir);
