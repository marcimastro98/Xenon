// The map: areas as zones and features as blocks, each sized by its files.
// Squarified layout (Bruls, Huizing, van Wijk) so blocks stay close to square
// and their names fit.

const ZONE_HEAD = 28;
const GAP = 3;

/**
 * @param {{ value: number }[]} items sorted largest first
 * @param {{ x: number, y: number, w: number, h: number }} box
 * @returns {{ item: any, x: number, y: number, w: number, h: number }[]}
 */
function squarify(items, box) {
  const out = [];
  const total = items.reduce((s, it) => s + it.value, 0);
  if (total <= 0 || box.w <= 0 || box.h <= 0) return out;
  const scale = (box.w * box.h) / total;
  let rest = items.map((item) => ({ item, area: item.value * scale }));
  let { x, y, w, h: ht } = box;
  while (rest.length > 0) {
    const side = Math.min(w, ht);
    let row = [rest[0]];
    let best = worst(row, side);
    for (let i = 1; i < rest.length; i += 1) {
      const next = worst([...row, rest[i]], side);
      if (next > best) break;
      row = [...row, rest[i]];
      best = next;
    }
    const sum = row.reduce((s, r) => s + r.area, 0);
    if (w >= ht) {
      const width = sum / ht;
      let yy = y;
      for (const r of row) { const hh = r.area / width; out.push({ item: r.item, x, y: yy, w: width, h: hh }); yy += hh; }
      x += width; w -= width;
    } else {
      const height = sum / w;
      let xx = x;
      for (const r of row) { const ww = r.area / height; out.push({ item: r.item, x: xx, y, w: ww, h: height }); xx += ww; }
      y += height; ht -= height;
    }
    rest = rest.slice(row.length);
  }
  return out;
}

/** The worst aspect ratio in a row laid along `side`. */
function worst(row, side) {
  const sum = row.reduce((s, r) => s + r.area, 0);
  const max = Math.max(...row.map((r) => r.area));
  const min = Math.min(...row.map((r) => r.area));
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/** Square roots keep a 1,700-file test folder from swallowing the map, and the floor keeps a small feature big enough to read its name. */
const weight = (files) => Math.sqrt(Math.max(1, files)) + 6;

/** @param {HTMLElement} holder */
function drawMap(holder) {
  const width = holder.clientWidth;
  if (width === 0) return;
  holder.replaceChildren();
  const zones = DATA.areas.map((area) => {
    const features = FEATURES.filter((f) => f.area === area.id).map((f) => ({ f, value: weight(filesOf.get(f.id).length) }));
    return { area, features: features.sort((a, b) => b.value - a.value), value: features.reduce((s, x) => s + x.value, 0) };
  }).filter((z) => z.value > 0).sort((a, b) => b.value - a.value);
  const narrow = width < 700;
  const wide = Math.round(width * 0.66);
  // On a phone the zones stack, each as tall as its blocks need, so every name stays readable.
  let top = 0;
  const laid = narrow
    ? zones.map((zone) => {
      const ht = ZONE_HEAD + Math.ceil(zone.features.length / 2) * 84 + 8;
      const box = { item: zone, x: 0, y: top, w: width, h: ht };
      top += ht;
      return box;
    })
    : squarify(zones, { x: 0, y: 0, w: width, h: wide });
  holder.style.height = `${narrow ? top : wide}px`;
  for (const zone of laid) {
    const { area, features } = zone.item;
    const files = features.reduce((s, x) => s + filesOf.get(x.f.id).length, 0);
    const el = h('div', { class: 'zone', hue: hueOf(area.id), title: `${say(area.name)}: ${say(area.what)}` }, h('b', null, `${say(area.name)} · ${t('files', num(files))}`));
    place(el, zone.x + GAP / 2, zone.y + GAP / 2, zone.w - GAP, zone.h - GAP);
    holder.append(el);
    const inner = { x: 4, y: ZONE_HEAD, w: zone.w - GAP - 8, h: zone.h - GAP - ZONE_HEAD - 4 };
    for (const cell of squarify(features, inner)) el.append(featureBlock(cell));
  }
}

function featureBlock(cell) {
  const { f } = cell.item;
  const count = filesOf.get(f.id).length;
  const roomy = cell.w > 150 && cell.h > 92;
  const fits = cell.w > 64 && cell.h > 34;
  const el = h('a', { class: 'cell', href: `#f-${f.id}`, hue: hueOf(f.area), title: `${say(f.name)}: ${say(f.what)} (${t('files', num(count))})` },
    fits ? h('b', null, say(f.name)) : null,
    roomy ? h('span', { class: 'w' }, say(f.what)) : null,
    fits && cell.h > 52 ? h('span', { class: 'n' }, t('files', num(count))) : null);
  el.setAttribute('aria-label', `${say(f.name)}, ${t('files', num(count))}`);
  place(el, cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
  return el;
}

function place(el, x, y, w, ht) {
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  el.style.width = `${Math.max(0, w)}px`;
  el.style.height = `${Math.max(0, ht)}px`;
}
