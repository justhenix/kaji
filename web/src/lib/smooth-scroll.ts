import type Lenis from 'lenis';

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const precisePointer = matchMedia('(hover: hover) and (pointer: fine)');
let lenis: Lenis | undefined;
let loading = false;
let active = true;

function shouldSmooth() {
  return active && !document.hidden && !reducedMotion.matches && precisePointer.matches;
}

async function syncScroll() {
  if (!shouldSmooth()) {
    lenis?.destroy();
    lenis = undefined;
    return;
  }
  if (lenis || loading) return;
  loading = true;
  try {
    const { default: Lenis } = await import('lenis');
    if (shouldSmooth() && !lenis) {
      lenis = new Lenis({ autoRaf: true, anchors: true, stopInertiaOnNavigate: true });
    }
  } catch {
    // Native scrolling remains available if the optional module cannot load.
  } finally {
    loading = false;
  }
}

reducedMotion.addEventListener('change', syncScroll);
precisePointer.addEventListener('change', syncScroll);
document.addEventListener('visibilitychange', syncScroll);
window.addEventListener('pagehide', () => { active = false; void syncScroll(); });
window.addEventListener('pageshow', () => { active = true; void syncScroll(); });
void syncScroll();
