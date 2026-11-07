# Kaji

A Windows companion for on-screen guidance and hands-free navigation.

Bun monorepo:

- `web/` — Astro, Svelte, and TypeScript landing website.
- `app/` — desktop application workspace.
- `logo/` — shared, original SVG brand assets.

The Windows interaction engine lives in [`app/`](app/README.md): Tauri v2, local MediaPipe head tracking, Rust-owned Win32 execution, and isolated UI Automation inspection. See its [current verification report](app/docs/LIVE-TRACKING-FIX.md) for executed checks and incomplete human acceptance.

An optional [collaborative Pi harness](app/docs/COLLABORATIVE-HARNESS.md) uses a separate logical cursor and native semantic actions so other-window activity can continue.

## Website

Use Bun 1.4.2 or newer. From the repository root:

```sh
bun install
bun run dev
bun run check
bun run test
bun run build
bun run preview
```

The production website is generated in `web/dist/`. Logo imports resolve directly from the shared `logo/` directory and are bundled with the site. Keep `logo/` beside `web/` in build environments. The favicon and deterministic dither PNGs are prepared automatically before development, checks, and builds.

To enable automatic installer downloads and thank-you copy, set `PUBLIC_WINDOWS_INSTALLER_URL` to the verified public HTTPS `.exe` or `.msi` URL before building. Until then, the download page links to the repository's Releases page. See `web/.env.example`.

The feature illustrations are static HTML/CSS compositions rendered by Astro. Svelte handles the interactive dither artwork.

## Deployment

Build from the repository root with `bun install --frozen-lockfile && bun run build`, and serve `web/dist/`. Configure the host's missing-page response to use `404.html` with status 404. Use `500.html` for server error responses where the host supports custom error documents. A static site cannot intercept an upstream host failure itself.

## Browser verification

With the production preview running on port 4321:

```sh
bunx playwright install chromium --only-shell
bun run test:browser
```

The browser checks cover responsive layouts, accessibility, links, static feature illustrations, reduced motion, static fallbacks, and dither displacement and recovery.
