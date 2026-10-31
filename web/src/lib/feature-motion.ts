const motionPreference = matchMedia('(prefers-reduced-motion: reduce)');
const sections = Array.from(document.querySelectorAll<HTMLElement>('.feature'));
const observers: IntersectionObserver[] = [];
const visible = new Set<HTMLElement>();

function animations(section: HTMLElement) {
  return section.querySelector('.product-demo')?.getAnimations({ subtree: true }) ?? [];
}

function stopObservers() {
  observers.forEach(observer => observer.disconnect());
  observers.length = 0;
}

function observeSections() {
  stopObservers();
  visible.clear();
  sections.forEach(section => {
    const demo = section.querySelector<HTMLElement>('.product-demo');
    if (!demo) return;

    // A tall mobile section cannot fit 60% of itself into a short viewport.
    const target = section.offsetHeight * .6 > innerHeight * .9 ? demo : section;
    let entered = false;
    const trigger = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && entry.intersectionRatio >= .6 && !entered && !motionPreference.matches) {
        entered = true;
        animations(section).forEach(animation => animation.cancel());
        demo.classList.remove('is-playing');
        void demo.offsetWidth;
        demo.classList.add('is-playing');
        if (document.hidden) animations(section).forEach(animation => animation.pause());
      }
    }, { threshold: [.6] });
    const boundary = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        visible.add(section);
      } else {
        visible.delete(section);
        entered = false;
        animations(section).forEach(animation => animation.pause());
      }
    }, { threshold: [0] });
    trigger.observe(target);
    boundary.observe(section);
    observers.push(trigger, boundary);
  });
}

function onVisibilityChange() {
  sections.forEach(section => {
    animations(section).forEach(animation => {
      if (document.hidden || !visible.has(section)) animation.pause();
      else if (animation.playState === 'paused') animation.play();
    });
  });
}

function onMotionChange() {
  sections.forEach(section => {
    animations(section).forEach(animation => animation.cancel());
    section.querySelector('.product-demo')?.classList.remove('is-playing');
  });
  observeSections();
}

observeSections();
motionPreference.addEventListener('change', onMotionChange);
document.addEventListener('visibilitychange', onVisibilityChange);
window.addEventListener('resize', observeSections);
window.addEventListener('pagehide', event => {
  if (event.persisted) return;
  stopObservers();
  motionPreference.removeEventListener('change', onMotionChange);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('resize', observeSections);
});
