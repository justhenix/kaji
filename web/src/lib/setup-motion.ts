const installation = document.querySelector<HTMLOListElement>('.installation');

if (installation) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const control = document.querySelector<HTMLButtonElement>('.setup-pause');
  let visible = false;
  let userPaused = false;

  function syncPlayback() {
    if (control) {
      control.hidden = motion.matches;
      control.textContent = userPaused ? 'Play animation' : 'Pause animation';
    }
    if (motion.matches) {
      installation!.removeAttribute('data-demo-playing');
      installation!.removeAttribute('data-demo-paused');
    } else if (visible && !document.hidden) {
      installation!.setAttribute('data-demo-playing', '');
      installation!.toggleAttribute('data-demo-paused', userPaused);
    } else if (installation!.hasAttribute('data-demo-playing')) {
      installation!.setAttribute('data-demo-paused', '');
    }
  }

  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncPlayback();
  });
  observer.observe(installation);
  control?.addEventListener('click', () => { userPaused = !userPaused; syncPlayback(); });
  motion.addEventListener('change', syncPlayback);
  document.addEventListener('visibilitychange', syncPlayback);
  syncPlayback();
  window.addEventListener('pagehide', event => {
    if (event.persisted) return;
    observer.disconnect();
    motion.removeEventListener('change', syncPlayback);
    document.removeEventListener('visibilitychange', syncPlayback);
  });
}
