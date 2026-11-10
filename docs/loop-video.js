// Silent product loops (<video data-loop>): they play only while on screen,
// so a page never downloads or decodes a clip nobody scrolled to, and never
// at all for a visitor who asked for reduced motion (the poster stays).
// A clip longer than five seconds has a pause key beside it
// (button[data-loop-pause] in the same parent, WCAG 2.2.2); it stays hidden
// when the clip never moves.
(function () {
  const clips = document.querySelectorAll('video[data-loop]');
  if (!clips.length) return;
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !('IntersectionObserver' in window)) return;
  clips.forEach((video) => {
    let inView = false;
    let held = false;
    const sync = () => {
      if (!inView || held) { video.pause(); return; }
      const p = video.play();
      if (p && p.catch) p.catch(() => { /* autoplay refused: the poster stays */ });
    };
    const key = video.parentElement && video.parentElement.querySelector('[data-loop-pause]');
    if (key) {
      key.hidden = false;
      key.addEventListener('click', () => {
        held = key.getAttribute('aria-pressed') !== 'true';
        key.setAttribute('aria-pressed', String(held));
        sync();
      });
    }
    video.muted = true;
    new IntersectionObserver((entries) => { inView = entries[0].isIntersecting; sync(); }, { threshold: 0.3 }).observe(video);
  });
})();
