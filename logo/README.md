# Kaji logo assets

The cursor and launch trail follow the first supplied image, with the upper triangle's shoulders narrowed to reduce the symbol's total filled area by 6%. The outer dimensions, tip, inner notch, and lower-left launch trail are retained. The second board supplies the horizontal lockup and app-icon direction.

| File | Appearance | Use |
| --- | --- | --- |
| `kaji-mark.svg` | Blue, transparent | Light backgrounds |
| `kaji-mark-dark.svg` | White, transparent | Dark backgrounds |
| `kaji-logo.svg` | Blue symbol and outlined wordmark | Light backgrounds |
| `kaji-logo-dark.svg` | White symbol and outlined wordmark | Dark backgrounds |
| `kaji-app.svg` | Blue symbol on white | App icon, 512 × 512 |
| `kaji-app-dark.svg` | White symbol on blue | App icon, 512 × 512 |
| `favicon.svg` | Blue in light mode, white in dark mode | Browser favicon, 16–32px |
| `favicon-light.svg` | Blue, transparent | Fixed light browser theme |
| `favicon-dark.svg` | White, transparent | Fixed dark browser theme |

Color: `#09318D` and `#FFFFFF`. All artwork is vector paths. The horizontal logos contain actual Figtree variable outlines at `wght=532` with the font's kerning. The main vertical stem is approximately 6% thicker than at Medium 500; no installed font or network request is required. Keep the SVG aspect ratio when resizing.

The mark has a square canvas with about 3% edge allowance. The horizontal lockup keeps the 84-unit mark beside an 88-unit Figtree wordmark, with the existing 24.365-unit visible separation. The font size, baseline, symbol dimensions, and gap are unchanged by the weight adjustment. App icons use a square background with no baked-in corner mask.

## Astro

Copy `favicon.svg` to the Astro project's `public/favicon.svg`, then add this inside the shared layout's `<head>`:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
```

For a deployment under a subpath:

```astro
<link rel="icon" type="image/svg+xml" href={`${import.meta.env.BASE_URL}favicon.svg`} />
```

An external image can use `kaji-logo.svg` directly, with an accessible name:

```html
<img src="/kaji-logo.svg" alt="Kaji" width="246" height="96" />
```

## Source

`source/build.py` contains the two manually constructed polygons and the wordmark outline exporter. It requires Python, `fonttools`, and `uharfbuzz`. Run `python source/build.py` from this directory to rebuild the SVGs.

The original Figtree variable font and its SIL Open Font License are included in `source/`. Font source: [Google Fonts / Figtree](https://github.com/google/fonts/tree/main/ofl/figtree), version 2.002, instantiated at `wght=532`.
