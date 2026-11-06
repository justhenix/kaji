import { listen } from '@tauri-apps/api/event';
import type { OverlayState } from '../shared/runtime';
import { OVERLAY_UPDATE_EVENT } from '../shared/runtime';
import { fetchRuntime } from './gui/ipc';

export interface OverlayGeometry {
  width: number;
  height: number;
  cursor: { left: number; top: number; width: number; height: number } | null;
  target: { left: number; top: number; width: number; height: number } | null;
}

export function overlayGeometry(state: OverlayState): OverlayGeometry | null {
  const viewport = state.viewport;
  if (!viewport || !Number.isFinite(viewport.scaleFactor) || viewport.scaleFactor <= 0) return null;
  const scale = viewport.scaleFactor;
  const spriteWidth = 24 * (state.monitorScaleFactor ?? scale) / scale;
  const spriteHeight = spriteWidth * 440 / 400;
  const cursor = state.point && state.cursorEnabled && state.mode === 'task' ? {
    left: (state.point.x - viewport.left) / scale - spriteWidth * 54 / 400,
    top: (state.point.y - viewport.top) / scale - spriteWidth * 34 / 400,
    width: spriteWidth,
    height: spriteHeight,
  } : null;
  const targetRect = state.target && state.target.right > state.target.left && state.target.bottom > state.target.top ? state.target : null;
  const target = targetRect && state.highlightEnabled && state.mode === 'task' ? {
    left: (targetRect.left - viewport.left) / scale,
    top: (targetRect.top - viewport.top) / scale,
    width: (targetRect.right - targetRect.left) / scale,
    height: (targetRect.bottom - targetRect.top) / scale,
  } : null;
  return { width: viewport.width / scale, height: viewport.height / scale, cursor, target };
}

export function renderOverlay(root: HTMLElement, state: OverlayState): void {
  const geometry = overlayGeometry(state);
  const surface = root.querySelector<HTMLElement>('.doppelganger-overlay');
  if (!surface || !geometry || state.mode === 'hidden') {
    if (surface) surface.hidden = true;
    return;
  }
  surface.hidden = !geometry.cursor && !geometry.target && state.dwellProgress <= 0;
  surface.dataset.mode = state.mode;
  surface.style.width = `${geometry.width}px`;
  surface.style.height = `${geometry.height}px`;
  const cursor = surface.querySelector<HTMLImageElement>('.doppelganger-cursor')!;
  cursor.hidden = !geometry.cursor;
  if (geometry.cursor) {
    cursor.style.transform = `translate3d(${geometry.cursor.left}px, ${geometry.cursor.top}px, 0)`;
    cursor.style.width = `${geometry.cursor.width}px`;
    cursor.style.height = `${geometry.cursor.height}px`;
    cursor.style.setProperty('--cursor-scale', String(geometry.cursor.width / 24));
  }
  const identity = surface.querySelector<HTMLElement>('.doppelganger-identity')!;
  identity.hidden = !geometry.cursor || state.mode !== 'task';
  if (geometry.cursor) {
    const labelLeft = Math.min(geometry.width - 46, Math.max(4, geometry.cursor.left + geometry.cursor.width + 5));
    const labelTop = Math.min(geometry.height - 22, Math.max(4, geometry.cursor.top + geometry.cursor.height - 8));
    identity.style.transform = `translate3d(${labelLeft}px, ${labelTop}px, 0)`;
  }
  const target = surface.querySelector<HTMLElement>('.doppelganger-target')!;
  target.hidden = !geometry.target;
  if (geometry.target) {
    target.style.left = `${geometry.target.left}px`;
    target.style.top = `${geometry.target.top}px`;
    target.style.width = `${geometry.target.width}px`;
    target.style.height = `${geometry.target.height}px`;
    target.style.setProperty('--dwell-progress', `${Math.max(0, Math.min(1, state.dwellProgress)) * 360}deg`);
  }
  const label = surface.querySelector<HTMLElement>('.doppelganger-label')!;
  label.hidden = !geometry.target || !state.targetLabel;
  if (geometry.target) {
    label.textContent = state.targetLabel;
    label.style.left = `${geometry.target.left}px`;
    label.style.top = `${Math.max(0, geometry.target.top - 26)}px`;
  }
  const ring = surface.querySelector<HTMLElement>('.doppelganger-dwell')!;
  ring.hidden = !state.point || state.dwellProgress <= 0;
  ring.style.setProperty('--dwell-progress', `${Math.max(0, Math.min(1, state.dwellProgress)) * 360}deg`);
  if (!ring.hidden && state.point && state.viewport) {
    const { left, top, scaleFactor } = state.viewport;
    const x = (state.point.x - left) / scaleFactor - 15;
    const y = (state.point.y - top) / scaleFactor - 15;
    ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }
}

async function initOverlay(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = '<div class="doppelganger-overlay" aria-hidden="true" hidden><div class="doppelganger-target"></div><span class="doppelganger-label"></span><div class="doppelganger-dwell"></div><img class="doppelganger-cursor" src="/art/cursor.png" alt="" /><span class="doppelganger-identity" hidden>Kaji</span></div>';
  let latest: OverlayState | undefined;
  let frame: number | undefined;
  const update = (state: OverlayState) => {
    latest = state;
    frame ??= requestAnimationFrame(() => {
      frame = undefined;
      if (latest) renderOverlay(root, latest);
    });
  };
  const unlisten = await listen<OverlayState>(OVERLAY_UPDATE_EVENT, (event) => update(event.payload)).catch(() => undefined);
  const initial = await fetchRuntime().catch(() => null);
  if (initial && !latest) update(initial.overlay);
  window.addEventListener('pagehide', () => {
    unlisten?.();
    if (frame !== undefined) cancelAnimationFrame(frame);
  }, { once: true });
}

if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded', () => { void initOverlay(); });
