"""Rebuild the Kaji SVGs: python -m pip install fonttools uharfbuzz; python source/build.py."""

from io import BytesIO
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont


ROOT = Path(__file__).resolve().parent.parent
BLUE = "#09318D"
WHITE = "#FFFFFF"

# Measured corners of the supplied cursor reference; the clipped trail is retained.
REFERENCE_HEAD = [(18.72, 129.32), (377.48, 32.85), (280.09, 395.43),
                  (212.96, 291.68), (212.96, 198), (121.42, 198)]
# Narrow the shoulders to remove 6% of total fill; retain the tip and inner notch.
HEAD = [(29.4274, 140.22158), (377.48, 32.85), (269.3826, 384.52842),
        (212.96, 291.68), (212.96, 198), (121.42, 198)]
TRAIL = [(0, 213), (11.96, 222.4), (22.11, 317.07),
         (116.4, 222.35), (188.4, 222.35), (188.4, 294.5),
         (93.44, 389.75), (188.4, 399.98), (198.5, 414), (0, 414)]


def area(points):
    return abs(sum(x * next_y - next_x * y for (x, y), (next_x, next_y)
                   in zip(points, points[1:] + points[:1]))) / 2


fill_reduction = 1 - (area(HEAD) + area(TRAIL)) / (area(REFERENCE_HEAD) + area(TRAIL))
assert abs(fill_reduction - 0.06) < 0.00001
for axis in [0, 1]:
    assert min(p[axis] for p in HEAD + TRAIL) == min(p[axis] for p in REFERENCE_HEAD + TRAIL)
    assert max(p[axis] for p in HEAD + TRAIL) == max(p[axis] for p in REFERENCE_HEAD + TRAIL)


def number(value):
    return f"{value:.3f}".rstrip("0").rstrip(".") or "0"


def mark(size=400, offset_x=0, offset_y=0):
    scale = size / 400
    # Keep the existing bounds centered on the 400-unit square.
    def polygon(points):
        pairs = [f"{number((x + 11.26) * scale + offset_x)} "
                 f"{number((y - 23.425) * scale + offset_y)}" for x, y in points]
        return "M" + " ".join(pairs) + "Z"
    return polygon(HEAD) + polygon(TRAIL)


def svg(name, width, height, body, label="Kaji"):
    document = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" '
                f'height="{height}" viewBox="0 0 {width} {height}" '
                f'role="img" aria-label="{label}">{body}</svg>\n')
    (ROOT / name).write_text(document, encoding="utf-8")


font = instantiateVariableFont(
    TTFont(ROOT / "source" / "Figtree[wght].ttf"), {"wght": 532}, inplace=True
)
assert font["OS/2"].usWeightClass == 532
glyph_set = font.getGlyphSet()
letter_bounds = BoundsPen(glyph_set)
glyph_set["K"].draw(letter_bounds)
# Hold the visible K edge at 106 units as its sidebearing changes with weight.
wordmark_x = 106 - letter_bounds.bounds[0] * 0.088
font_bytes = BytesIO()
font.save(font_bytes)
hb_font = hb.Font(hb.Face(font_bytes.getvalue()))
buffer = hb.Buffer()
buffer.add_str("Kaji")
buffer.guess_segment_properties()
hb.shape(hb_font, buffer)

# Figtree's original outlines and kerning, at 88 units per em.
pen = SVGPathPen(glyph_set, ntos=number)
advance = 0
for info, position in zip(buffer.glyph_infos, buffer.glyph_positions):
    transform = (0.088, 0, 0, -0.088,
                 wordmark_x + (advance + position.x_offset) * 0.088,
                 72 - position.y_offset * 0.088)
    glyph_set[font.getGlyphName(info.codepoint)].draw(TransformPen(pen, transform))
    advance += position.x_advance
wordmark = pen.getCommands()

for suffix, color in [("", BLUE), ("-dark", WHITE)]:
    svg(f"kaji-mark{suffix}.svg", 400, 400,
        f'<path fill="{color}" d="{mark()}"/>')
    svg(f"kaji-logo{suffix}.svg", 246, 96,
        f'<path fill="{color}" d="{mark(84, offset_y=6)}{wordmark}"/>')
    background, foreground = (WHITE, BLUE) if not suffix else (BLUE, WHITE)
    svg(f"kaji-app{suffix}.svg", 512, 512,
        f'<path fill="{background}" d="M0 0h512v512H0z"/>'
        f'<path fill="{foreground}" d="{mark(352, 80, 80)}"/>', "Kaji app")

svg("favicon-light.svg", 32, 32, f'<path fill="{BLUE}" d="{mark(32)}"/>')
svg("favicon-dark.svg", 32, 32, f'<path fill="{WHITE}" d="{mark(32)}"/>')
svg("favicon.svg", 32, 32,
    f'<style>path{{fill:{BLUE}}}@media(prefers-color-scheme:dark)'
    f'{{path{{fill:{WHITE}}}}}</style><path d="{mark(32)}"/>')

for path in sorted(ROOT.glob("*.svg")):
    print(f"{path.name}: {path.stat().st_size} bytes")
print(f"Symbol fill reduced {fill_reduction:.2%}; outer bounds unchanged; Figtree wght=532, em=88.")
