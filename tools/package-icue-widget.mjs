#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(repoRoot, "widget");
const buildRoot = join(tmpdir(), `xenonedgehub-icue-package-${process.pid}`);
const buildDir = join(buildRoot, "xenonedgehub");
const packageOutput = join(repoRoot, "xenonedgehub.icuewidget");

const copiedPaths = [
  "manifest.json",
  "translation.json",
  "resources",
  "styles",
  "modules",
  "common"
];

function readSource(relativePath) {
  return readFileSync(join(sourceDir, relativePath), "utf8");
}

function resolveComponentMarkup(markup) {
  return markup.replace(/<div data-component-path="([^"]+)"><\/div>/g, (_match, componentPath) => {
    return resolveComponentMarkup(readSource(componentPath).trim());
  });
}

function createBundledIndex() {
  const dashboardMarkup = resolveComponentMarkup(readSource("components/dashboard.html").trim());
  const overlayMarkup = resolveComponentMarkup(readSource("components/overlays.html").trim());
  const sourceIndex = readSource("index.html");
  const runtimeMount = [
    `<div id="xenonedge-root">`,
    dashboardMarkup,
    `</div>`,
    `<div id="xenonedge-overlays">`,
    overlayMarkup,
    `</div>`,
    `<script src="modules/app.js"></script>`
  ].join("\n");

  const bundledIndex = sourceIndex.replace(
    /<div id="xenonedge-root"><\/div>\s*<div id="xenonedge-overlays"><\/div>\s*<script src="modules\/components\/loader\.js"><\/script>/,
    runtimeMount
  );

  if (bundledIndex === sourceIndex) {
    throw new Error("Could not find the component loader mount point in index.html");
  }
  if (bundledIndex.includes("data-component-path")) {
    throw new Error("Bundled index still contains unresolved component placeholders");
  }

  return bundledIndex;
}

function run(command, args) {
  const executable = process.platform === "win32" && command === "icuewidget"
    ? "icuewidget.exe"
    : command;
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    stdio: "inherit"
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function prepareBuildDirectory() {
  rmSync(buildRoot, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  for (const relativePath of copiedPaths) {
    cpSync(join(sourceDir, relativePath), join(buildDir, relativePath), { recursive: true });
  }

  // Inline the shared @xenon/core modules into the package. In dev these resolve
  // through the widget/shared junction (packages/core); at package time we copy
  // packages/core/src to shared/src so the widget carries its single source of
  // truth for pure helpers without the junction. index.html already references
  // shared/src/constants.js and shared/src/format.js.
  cpSync(join(repoRoot, "packages", "core", "src"), join(buildDir, "shared", "src"), { recursive: true });

  rmSync(join(buildDir, "modules", "components"), { recursive: true, force: true });
  writeFileSync(join(buildDir, "index.html"), createBundledIndex(), "utf8");
}

try {
  if (!existsSync(sourceDir)) throw new Error("widget source directory was not found");
  prepareBuildDirectory();
  run("icuewidget", ["validate", buildDir]);
  run("icuewidget", ["package", buildDir, "--output", packageOutput]);
} finally {
  if (!process.env.KEEP_ICUE_BUILD) {
    rmSync(buildRoot, { recursive: true, force: true });
  }
}
