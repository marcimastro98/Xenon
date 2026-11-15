// Keeps the map (tools/map/features.json) true across a move. A loose file is owned through a pattern that names
// it (`server/vitals-*.js`); once the file is in its feature's folder that pattern points at nothing, and the map's
// own test fails on such a pattern. So a move takes the pattern out and remembers where it stood, and the step that
// leaves the one line at the old path puts it back, because that line is a file of the same feature again.

import { assign, render } from '../map/map.mjs';

export const FEATURES = 'tools/map/features.json';
export const MAP = 'MAP.md';

const unusedIn = (map, files) => new Set(assign(files, map.features).unused);
export const mapText = (map) => `${JSON.stringify(map, null, 2)}\n`;
export const pageText = (map) => render(map);

/**
 * @param {{features: {id: string, files: string[]}[]}} map @param {string[]} files the repo after the move
 * @returns {{ map: object, dropped: {feature: string, glob: string, at: number}[] }} `at` is the place in the feature's list
 */
export function dropUnused(map, files) {
  const dead = unusedIn(map, files);
  const dropped = [];
  const features = map.features.map((feature) => ({
    ...feature,
    files: feature.files.filter((glob, at) => {
      if (!dead.has(`${feature.id}: ${glob}`)) return true;
      dropped.push({ feature: feature.id, glob, at });
      return false;
    }),
  }));
  return { map: { ...map, features }, dropped };
}

/**
 * @param {{features: {id: string, files: string[]}[]}} map @param {{feature: string, glob: string, at: number}[]} dropped
 * @param {string[]} files the repo now
 * @returns {{ map: object, still: object[] }} `still` are the patterns that would point at nothing even now
 */
export function putBack(map, dropped, files) {
  const features = map.features.map((feature) => {
    const list = [...feature.files];
    for (const entry of dropped.filter((one) => one.feature === feature.id).sort((a, b) => a.at - b.at)) list.splice(Math.min(entry.at, list.length), 0, entry.glob);
    return { ...feature, files: list };
  });
  const dead = unusedIn({ ...map, features }, files);
  const still = dropped.filter((entry) => dead.has(`${entry.feature}: ${entry.glob}`));
  const kept = features.map((feature) => ({ ...feature, files: feature.files.filter((glob) => !dead.has(`${feature.id}: ${glob}`)) }));
  return { map: { ...map, features: kept }, still };
}
