"""Turns the word "xenon" into fixed outlines for the logo.

The wordmark is artwork, not live text: a logo must look the same where the
font is missing (email clients, GitHub, image viewers). This reads Sofia Sans
Semi Condensed (OFL, docs/fonts/OFL.txt) at weight 800, applies the font's own
kerning and the logo's tracking, and writes tools/brand/wordmark.json. Run it
only when the wordmark changes; build.mjs reads the JSON.

    pip install fonttools brotli
    python tools/brand/extract-wordmark.py
"""

import json
import os
import sys

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, '..', '..', 'docs', 'fonts', 'sofiasans-sc-latin.woff2')
OUT = os.path.join(HERE, 'wordmark.json')
WORD = 'xenon'
WEIGHT = 800
TRACKING = -15  # thousandths of an em, the same -0.015em the mockups used


def short_number(value):
    """One decimal in font units (1/1000 em) is far below a screen pixel."""
    return ('%.1f' % value).rstrip('0').rstrip('.')


def pair_kerning(font, left, right):
    """Sum of the 'kern' feature's pair adjustments for two glyph names."""
    if 'GPOS' not in font:
        return 0
    gpos = font['GPOS'].table
    lookups = set()
    for rec in gpos.FeatureList.FeatureRecord:
        if rec.FeatureTag == 'kern':
            lookups.update(rec.Feature.LookupListIndex)
    total = 0
    for index in sorted(lookups):
        lookup = gpos.LookupList.Lookup[index]
        subtables = lookup.SubTable
        if lookup.LookupType == 9:
            subtables = [s.ExtSubTable for s in subtables]
        for sub in subtables:
            if getattr(sub, 'LookupType', 2) != 2 or left not in sub.Coverage.glyphs:
                continue
            value = None
            if sub.Format == 1:
                pair_set = sub.PairSet[sub.Coverage.glyphs.index(left)]
                for rec in pair_set.PairValueRecord:
                    if rec.SecondGlyph == right:
                        value = rec.Value1
                        break
            elif sub.Format == 2:
                c1 = sub.ClassDef1.classDefs.get(left, 0)
                c2 = sub.ClassDef2.classDefs.get(right, 0)
                value = sub.Class1Record[c1].Class2Record[c2].Value1
            if value is not None:
                total += getattr(value, 'XAdvance', 0) or 0
                break
    return total


def main():
    font = TTFont(FONT)
    font = instantiateVariableFont(font, {'wght': WEIGHT})
    cmap = font.getBestCmap()
    glyph_set = font.getGlyphSet()
    hmtx = font['hmtx']
    upm = font['head'].unitsPerEm
    ascender = font['OS/2'].sTypoAscender
    names = [cmap[ord(ch)] for ch in WORD]

    glyphs = []
    x = 0
    for i, name in enumerate(names):
        pen = SVGPathPen(glyph_set, ntos=short_number)
        # Font units grow upwards; SVG grows downwards from the baseline at y=0.
        glyph_set[name].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        glyphs.append({'char': WORD[i], 'x': x, 'd': pen.getCommands()})
        x += hmtx[name][0]
        if i < len(names) - 1:
            x += pair_kerning(font, name, names[i + 1]) + TRACKING
    # The ink box, so the builder can trim side bearings and align to the x-height.
    bounds_pen = BoundsPen(glyph_set)
    for i, name in enumerate(names):
        glyph_set[name].draw(TransformPen(bounds_pen, (1, 0, 0, 1, glyphs[i]['x'], 0)))
    x_min, y_min, x_max, y_max = bounds_pen.bounds

    data = {
        'source': 'Sofia Sans Semi Condensed (OFL), wght %d, tracking %d/1000 em' % (WEIGHT, TRACKING),
        'word': WORD,
        'unitsPerEm': upm,
        'ascender': ascender,
        'xHeight': font['OS/2'].sxHeight,
        'ink': {'left': x_min, 'right': x_max, 'top': -y_max, 'bottom': -y_min},
        'glyphs': glyphs,
    }
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        json.dump(data, fh, indent=2)
        fh.write('\n')
    print('wrote', os.path.relpath(OUT), 'ink width', x_max - x_min, file=sys.stderr)


if __name__ == '__main__':
    main()
