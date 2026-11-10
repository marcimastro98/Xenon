// Bit on the 5.0 page. Each new thing has its own Bit, in its sheet's colours and
// with its own face; the faces are drawn in the page and this only moves them.
// A Bit on a picture (data-bit="full") blinks and looks toward the mouse while it
// is in view, hops once the first time it is wholly in view, and hops with a happy
// face when pointed at or tapped. A small Bit in the list (data-bit="mini") does
// the happy hop when its link is pointed at or focused. Under reduced motion
// nothing moves or changes: every Bit keeps the face it was drawn with.
(function () {
  const svgs = Array.prototype.slice.call(document.querySelectorAll('svg[data-bit]'));
  if (!svgs.length) return;
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (still || !('IntersectionObserver' in window)) return;

  const HOP_MS = 170;
  const REACT_MS = 900;
  const BLINK_MS = 130;
  const GREET_DELAY_MS = 250;

  function make(svg) {
    const face = svg.querySelector('.bf');
    const eyes = svg.querySelector('.bf-eyes');
    const mouth = svg.querySelector('.bf-mouth');
    if (!face || !eyes || !mouth) return null;
    const own = { eyes: eyes.getAttribute('d'), mouth: mouth.getAttribute('d') };
    const joy = { eyes: svg.getAttribute('data-react-eyes'), mouth: svg.getAttribute('data-react-mouth') };
    const shut = eyes.getAttribute('data-shut');
    const bit = { svg, face, full: svg.getAttribute('data-bit') === 'full', inView: false, greeted: false, back: 0, blinkTimer: 0 };
    const draw = (f) => { eyes.setAttribute('d', f.eyes); mouth.setAttribute('d', f.mouth); };

    bit.hop = () => {
      svg.classList.add('hop');
      setTimeout(() => svg.classList.remove('hop'), HOP_MS);
    };
    bit.react = () => {
      bit.hop();
      if (!joy.eyes || !joy.mouth) return;
      clearTimeout(bit.back);
      draw(joy);
      bit.back = setTimeout(() => { bit.back = 0; draw(own); }, REACT_MS);
    };
    // Blinks run only while this Bit is on screen and the tab is visible.
    const blink = () => {
      bit.blinkTimer = 0;
      if (!bit.inView) return;
      if (!bit.back && !document.hidden) {
        eyes.setAttribute('d', shut);
        setTimeout(() => { if (!bit.back) eyes.setAttribute('d', own.eyes); }, BLINK_MS);
      }
      bit.blinkTimer = setTimeout(blink, 2600 + Math.random() * 3600);
    };
    bit.seen = (inView) => {
      bit.inView = inView;
      if (!shut) return;
      if (inView && !bit.blinkTimer) bit.blinkTimer = setTimeout(blink, 1200 + Math.random() * 2400);
      if (!inView && bit.blinkTimer) { clearTimeout(bit.blinkTimer); bit.blinkTimer = 0; }
    };
    return bit;
  }

  const bits = svgs.map(make).filter(Boolean);
  const full = bits.filter((b) => b.full);
  const bySvg = new Map(full.map((b) => [b.svg, b]));

  const watch = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      const bit = bySvg.get(en.target);
      if (!bit) return;
      bit.seen(en.isIntersecting);
      if (!bit.greeted && en.intersectionRatio >= 0.98) {
        bit.greeted = true;
        setTimeout(bit.hop, GREET_DELAY_MS);
      }
    });
  }, { threshold: [0, 0.98] });

  full.forEach((bit) => {
    watch.observe(bit.svg);
    bit.svg.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') bit.react(); });
    bit.svg.addEventListener('click', bit.react);
  });
  bits.filter((b) => !b.full).forEach((bit) => {
    const link = bit.svg.closest('a');
    if (!link) return;
    link.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') bit.react(); });
    link.addEventListener('focus', bit.react);
  });

  // Eyes toward the mouse, one pixel at most, as the home's Bit does: a finger
  // has no position to follow between taps.
  let frame = 0;
  let px = 0;
  let py = 0;
  const look = () => {
    frame = 0;
    full.forEach((bit) => {
      if (!bit.inView) return;
      const r = bit.svg.getBoundingClientRect();
      const dx = px - (r.left + r.width / 2);
      const dy = py - (r.top + r.height / 2);
      const x = Math.abs(dx) < r.width ? 0 : Math.sign(dx);
      const y = dy < -r.height ? -1 : 0;
      bit.face.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
    });
  };
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    px = e.clientX;
    py = e.clientY;
    if (!frame) frame = requestAnimationFrame(look);
  }, { passive: true });
})();
