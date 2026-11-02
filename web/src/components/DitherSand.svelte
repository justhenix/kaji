<script lang="ts">
  import { onMount } from 'svelte';
  import { springGrain, type Artwork } from '../lib/dither';

  let { kind, cursor = false, eager = false, mirrored = false }: { kind: Artwork; cursor?: boolean; eager?: boolean; mirrored?: boolean } = $props();
  let host: HTMLDivElement;
  let canvas: HTMLCanvasElement;
  let picture: HTMLImageElement;
  let ready = $state(false);

  onMount(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const fine = matchMedia('(hover: hover) and (pointer: fine)');
    const context = canvas.getContext('2d');
    if (!context) return;
    const base = document.createElement('canvas');
    const baseContext = base.getContext('2d', { willReadFrequently: true });
    if (!baseContext) return;
    type Grain = { ox: number; oy: number; x: number; y: number; vx: number; vy: number; color: string };
    const grains = new Map<number, Grain>();
    let pixels: Uint8ClampedArray;
    let frame = 0;
    let previous = 0;
    let width = 0;
    let height = 0;
    let pointer = { x: -1000, y: -1000 };
    let visible = true;
    const radius = 64;

    function paint() {
      context!.clearRect(0, 0, width, height);
      context!.drawImage(base, 0, 0);
      for (const p of grains.values()) context!.clearRect(p.ox, p.oy, 2, 2);
      for (const p of grains.values()) {
        context!.fillStyle = p.color;
        context!.fillRect(Math.round(p.x), Math.round(p.y), 2, 2);
      }
    }

    function stop() {
      cancelAnimationFrame(frame);
      frame = 0;
      previous = 0;
      grains.clear();
      pointer = { x: -1000, y: -1000 };
      if (width) paint();
    }

    function resize() {
      if (!picture.complete || !picture.naturalWidth) return;
      stop();
      if (!host.clientWidth) return;
      // Bound work to the original raster; ultrawide screens do not multiply grains.
      width = Math.min(picture.naturalWidth, Math.ceil(host.clientWidth / 2) * 2);
      height = Math.ceil(width * picture.naturalHeight / picture.naturalWidth / 2) * 2;
      canvas.width = base.width = width;
      canvas.height = base.height = height;
      baseContext!.imageSmoothingEnabled = false;
      baseContext!.clearRect(0, 0, width, height);
      baseContext!.drawImage(picture, 0, 0, width, height);
      pixels = baseContext!.getImageData(0, 0, width, height).data;
      paint();
      ready = true;
    }

    function tick(time: number) {
      if (motion.matches || !visible || document.hidden) { stop(); return; }
      const dt = Math.min((time - (previous || time - 16.67)) / 1000, .032);
      previous = time;
      if (pointer.x > -100) {
        for (let y = Math.max(0, Math.floor((pointer.y - radius) / 2) * 2); y < Math.min(height, pointer.y + radius); y += 2) {
          for (let x = Math.max(0, Math.floor((pointer.x - radius) / 2) * 2); x < Math.min(width, pointer.x + radius); x += 2) {
            const key = y * width + x;
            const index = key * 4;
            if (pixels[index + 3] > 128 && !grains.has(key) && Math.hypot(x - pointer.x, y - pointer.y) < radius) {
              grains.set(key, { ox: x, oy: y, x, y, vx: 0, vy: 0, color: `rgb(${pixels[index]},${pixels[index + 1]},${pixels[index + 2]})` });
            }
          }
        }
      }
      for (const [key, p] of grains) {
        const dx = p.x - pointer.x;
        const dy = p.y - pointer.y;
        const distance = Math.hypot(dx, dy);
        const push = Math.max(0, 1 - distance / radius) * 2200;
        const nextX = springGrain(p.x, p.vx, p.ox, dx / Math.max(1, distance) * push, dt);
        const nextY = springGrain(p.y, p.vy, p.oy, dy / Math.max(1, distance) * push + push * .18, dt);
        p.x = nextX.position; p.vx = nextX.velocity;
        p.y = nextY.position; p.vy = nextY.velocity;
        if (push === 0 && Math.hypot(p.x - p.ox, p.y - p.oy) < .08 && Math.hypot(p.vx, p.vy) < .2) grains.delete(key);
      }
      paint();
      if (grains.size) frame = requestAnimationFrame(tick);
      else { frame = 0; previous = 0; }
    }

    function move(event: PointerEvent) {
      if (motion.matches || !fine.matches || !visible || !ready || event.pointerType === 'touch') return;
      const rect = host.getBoundingClientRect();
      const x = (mirrored ? rect.right - event.clientX : event.clientX - rect.left) / rect.width * width;
      const y = (event.clientY - rect.top) / rect.height * height;
      pointer = x >= 0 && x <= width && y >= 0 && y <= height ? { x, y } : { x: -1000, y: -1000 };
      if (!frame && pointer.x >= 0) frame = requestAnimationFrame(tick);
    }
    function leave() { pointer = { x: -1000, y: -1000 }; }
    const observer = new ResizeObserver(resize);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; if (!visible) stop(); });
    observer.observe(host);
    intersection.observe(host);
    picture.addEventListener('load', resize);
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', stop);
    motion.addEventListener('change', stop);
    resize();
    return () => {
      stop(); observer.disconnect(); intersection.disconnect();
      picture.removeEventListener('load', resize);
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', stop);
      motion.removeEventListener('change', stop);
    };
  });
</script>

<div bind:this={host} class:cursor class:mirrored class="sand" aria-hidden="true" data-dither={kind}>
  <img bind:this={picture} src={`/art/${kind}.png`} alt="" width={kind === 'sweep' ? 960 : 400} height={kind === 'sweep' ? 640 : 440} loading={eager ? 'eager' : 'lazy'} decoding="async" class:ready />
  <canvas bind:this={canvas} class:ready></canvas>
</div>

<style>
  .sand { width: 100%; pointer-events: none; position: relative; }
  .mirrored { transform: scaleX(-1); }
  img { width: 100%; height: auto; display: block; image-rendering: pixelated; }
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; image-rendering: pixelated; }
  canvas.ready { opacity: 1; }
  img.ready { opacity: 0; }
</style>
