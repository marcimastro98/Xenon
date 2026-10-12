// Silent product loops (<video data-loop>): they play only while on screen,
// so a page never downloads or decodes a clip nobody scrolled to, and never
// at all for a visitor who asked for reduced motion (the poster stays).
(function () {
  var clips = document.querySelectorAll('video[data-loop]');
  if (!clips.length) return;
  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !('IntersectionObserver' in window)) return;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var v = e.target;
      if (e.isIntersecting) {
        var p = v.play();
        if (p && p.catch) p.catch(function () { /* autoplay refused: the poster stays */ });
      } else {
        v.pause();
      }
    });
  }, { threshold: 0.3 });
  clips.forEach(function (v) { v.muted = true; io.observe(v); });
})();
