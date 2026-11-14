// The squarified treemap of the disk widget: how a list of sizes is laid out as rectangles that
// fill a box and stay close to square.
'use strict';

(() => {
  function squarify(items, x, y, w, h, out) {
    if (!items.length || w <= 0 || h <= 0) return;
    let row = [];
    let rest = items;
    const total = items.reduce((sum, item) => sum + item.area, 0);
    if (!total) return;
    const scale = (w * h) / total;
    const worst = (test) => {
      const sum = test.reduce((acc, item) => acc + item.area * scale, 0);
      const short = Math.min(w, h);
      let ratio = 0;
      for (const item of test) {
        const area = item.area * scale;
        ratio = Math.max(ratio, (short * short * area) / (sum * sum), (sum * sum) / (short * short * area));
      }
      return ratio;
    };
    while (rest.length) {
      const next = [...row, rest[0]];
      if (row.length && worst(next) > worst(row)) break;
      row = next;
      rest = rest.slice(1);
    }
    const sum = row.reduce((acc, item) => acc + item.area * scale, 0);
    if (w >= h) {
      const columnWidth = sum / h;
      let cy = y;
      for (const item of row) {
        const cellHeight = (item.area * scale) / columnWidth;
        out.push({ item, x, y: cy, w: columnWidth, h: cellHeight });
        cy += cellHeight;
      }
      squarify(rest, x + columnWidth, y, w - columnWidth, h, out);
    } else {
      const rowHeight = sum / w;
      let cx = x;
      for (const item of row) {
        const cellWidth = (item.area * scale) / rowHeight;
        out.push({ item, x: cx, y, w: cellWidth, h: rowHeight });
        cx += cellWidth;
      }
      squarify(rest, x, y + rowHeight, w, h - rowHeight, out);
    }
  }

  window.DiskWidgetTreemap = { squarify };
})();
