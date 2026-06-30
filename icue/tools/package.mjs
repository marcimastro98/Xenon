/*
 * Minimal iCUE widget packager for the Xenon native collection.
 *
 * Authoring stays DRY: a widget's index.html pulls shared code with ordinary
 * <script src="../../common/..."> and <link rel="stylesheet" href="styles/..">
 * tags, which work when you open the file in a browser during development.
 *
 * iCUE runs widgets from a file:// page where QtWebEngine silently blocks
 * external <script src>. So for distribution we inline every LOCAL script and
 * stylesheet into one self-contained index.html and copy the widget's
 * manifest / translation / resources alongside it.
 *
 * Usage:  node icue/tools/package.mjs [widgetName ...]
 *         (no args = package every widget under icue/widgets/)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, ".."); // icue/
const widgetsDir = join(root, "widgets");
const distDir = join(root, "dist");

// Replace local <script src> / <link rel=stylesheet> with inlined content.
function inlineAssets(html, htmlDir) {
  html = html.replace(/<script\b[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g, function (match, src) {
    if (/^https?:/i.test(src)) return match; // leave CDN/remote scripts untouched
    const code = readFileSync(resolve(htmlDir, src), "utf8");
    return "<script>\n" + code + "\n</script>";
  });

  html = html.replace(/<link\b[^>]*>/g, function (match) {
    if (!/rel="stylesheet"/i.test(match)) return match;
    const href = match.match(/href="([^"]+)"/i);
    if (!href || /^https?:/i.test(href[1])) return match;
    const css = readFileSync(resolve(htmlDir, href[1]), "utf8");
    return "<style>\n" + css + "\n</style>";
  });

  return html;
}

function validateManifest(manifest, name) {
  const required = ["author", "id", "name", "description", "version",
    "preview_icon", "min_framework_version", "os", "supported_devices"];
  const missing = required.filter(function (k) { return !(k in manifest); });
  if (missing.length) throw new Error("[" + name + "] manifest.json missing: " + missing.join(", "));
}

function packageWidget(name) {
  const srcDir = join(widgetsDir, name);
  const indexPath = join(srcDir, "index.html");
  if (!existsSync(indexPath)) throw new Error("[" + name + "] no index.html");

  validateManifest(JSON.parse(readFileSync(join(srcDir, "manifest.json"), "utf8")), name);

  let html = readFileSync(indexPath, "utf8");
  if (!/<title>/i.test(html)) throw new Error("[" + name + "] index.html has no <title>");
  html = inlineAssets(html, srcDir);
  if (/\ssrc="(?!https?:)[^"]+"/.test(html)) {
    console.warn("[" + name + "] warning: an un-inlined local src remains — it will not load inside iCUE.");
  }

  // Overwrite in place rather than removing the dir first: on Windows /
  // OneDrive a synced folder can hold a transient lock that breaks rmSync.
  const outDir = join(distDir, name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), html, "utf8");
  cpSync(join(srcDir, "manifest.json"), join(outDir, "manifest.json"));
  if (existsSync(join(srcDir, "translation.json"))) {
    cpSync(join(srcDir, "translation.json"), join(outDir, "translation.json"));
  }
  if (existsSync(join(srcDir, "resources"))) {
    cpSync(join(srcDir, "resources"), join(outDir, "resources"), { recursive: true });
  }
  console.log("[" + name + "] packaged -> " + relative(root, outDir));
}

const args = process.argv.slice(2);
const names = args.length ? args : readdirSync(widgetsDir).filter(function (n) {
  return existsSync(join(widgetsDir, n, "index.html"));
});

let failed = 0;
names.forEach(function (n) {
  try { packageWidget(n); } catch (e) { failed++; console.error(String((e && e.message) || e)); }
});
if (failed) process.exit(1);
