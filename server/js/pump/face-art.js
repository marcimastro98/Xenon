// The moving pictures Xenon draws itself for the Picture face (face-picture.js
// runs the loop): Aurora, Ember, Tide and Orbit. Each is cheap on purpose, a few
// paths a frame on a canvas no bigger than the pump. Joins window.PumpFaceKit.
(() => {
  'use strict';

  const Kit = window.PumpFaceKit;
  const TAU = Math.PI * 2;

  // Aurora: three ribbons of light drifting over a night sky.
  Kit.add('art', 'aurora', (ctx, w, h) => {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#02060a');
    sky.addColorStop(1, '#071712');
    const bands = [
      { color: '110, 231, 135', y: 0.38, amp: 0.09, speed: 0.11, phase: 0 },
      { color: '79, 209, 197', y: 0.5, amp: 0.07, speed: 0.08, phase: 2 },
      { color: '180, 160, 255', y: 0.6, amp: 0.06, speed: 0.06, phase: 4 },
    ];
    const step = Math.max(6, Math.round(w / 80));
    return {
      frame(t) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        for (const b of bands) {
          const g = ctx.createLinearGradient(0, h * (b.y - 0.25), 0, h * (b.y + 0.12));
          g.addColorStop(0, `rgba(${b.color}, 0)`);
          g.addColorStop(0.7, `rgba(${b.color}, 0.42)`);
          g.addColorStop(1, `rgba(${b.color}, 0)`);
          ctx.fillStyle = g;
          ctx.beginPath();
          for (let x = 0; x <= w + step; x += step) {
            const k = x / w;
            const y = h * (b.y + b.amp * Math.sin(k * 5 + t * b.speed * 6 + b.phase) + 0.03 * Math.sin(k * 13 - t * 0.7));
            if (x === 0) ctx.moveTo(x, y - h * 0.25); else ctx.lineTo(x, y - h * 0.25);
          }
          for (let x = w + step; x >= 0; x -= step) {
            const k = x / w;
            ctx.lineTo(x, h * (b.y + b.amp * Math.sin(k * 5 + t * b.speed * 6 + b.phase) + 0.03 * Math.sin(k * 13 - t * 0.7)) + h * 0.12);
          }
          ctx.fill();
        }
      },
    };
  });

  // A soft round light drawn once, so each spark is one picture copied, not a gradient a frame.
  function softLight(rgb) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    const fill = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    fill.addColorStop(0, `rgba(${rgb}, 1)`);
    fill.addColorStop(0.25, `rgba(${rgb}, 0.55)`);
    fill.addColorStop(1, `rgba(${rgb}, 0)`);
    g.fillStyle = fill;
    g.fillRect(0, 0, 64, 64);
    return c;
  }

  // Ember: sparks rising from a fire below, each a little light that dims as it climbs.
  Kit.add('art', 'ember', (ctx, w, h) => {
    const glow = ctx.createRadialGradient(w / 2, h * 1.08, 0, w / 2, h * 1.08, h * 1.05);
    glow.addColorStop(0, '#c2410c');
    glow.addColorStop(0.35, '#5a1a06');
    glow.addColorStop(1, '#080302');
    const hot = softLight('255, 196, 90');
    const sparks = Array.from({ length: 80 }, (_, i) => ({ seed: i * 7.31, life: (i * 0.137) % 1 }));
    return {
      frame(t) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = 'lighter';
        for (const s of sparks) {
          const k = (s.life + t * 0.07 * (0.6 + (s.seed % 1))) % 1;
          const x = w * (0.5 + 0.46 * Math.sin(s.seed) * (0.35 + k)) + Math.sin(t * 1.3 + s.seed) * w * 0.025;
          const y = h * (1.02 - k * 1.1);
          const fade = 1 - k;
          const r = w * (0.012 + 0.022 * fade) * (0.7 + 0.3 * Math.abs(Math.sin(s.seed * 3.1)));
          ctx.globalAlpha = 0.9 * fade;
          ctx.drawImage(hot, x - r, y - r, r * 2, r * 2);
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      },
    };
  });

  // Tide: waves rolling under a moon. The moon sits high and small with a soft light round it:
  // behind a face's numbers (a line's background) a big hard disc read as a grey ball.
  Kit.add('art', 'tide', (ctx, w, h) => {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#040814');
    sky.addColorStop(1, '#0b1f3a');
    const moon = ctx.createRadialGradient(w * 0.68, h * 0.2, 0, w * 0.68, h * 0.2, w * 0.16);
    moon.addColorStop(0, 'rgba(240, 240, 232, 0.95)');
    moon.addColorStop(0.3, 'rgba(240, 240, 232, 0.9)');
    moon.addColorStop(0.36, 'rgba(180, 200, 235, 0.22)');
    moon.addColorStop(1, 'rgba(180, 200, 235, 0)');
    const waves = [
      { y: 0.58, amp: 0.025, len: 3, speed: 0.35, color: '#16365f' },
      { y: 0.66, amp: 0.03, len: 2.4, speed: -0.45, color: '#1d4c80' },
      { y: 0.75, amp: 0.035, len: 2, speed: 0.55, color: '#2a69a8' },
      { y: 0.85, amp: 0.04, len: 1.6, speed: -0.65, color: '#3f8ad0' },
    ];
    const step = Math.max(6, Math.round(w / 80));
    return {
      frame(t) {
        ctx.fillStyle = sky;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = moon;
        ctx.fillRect(w * 0.52, h * 0.04, w * 0.32, w * 0.32);
        for (const v of waves) {
          ctx.fillStyle = v.color;
          ctx.beginPath();
          ctx.moveTo(0, h);
          for (let x = 0; x <= w + step; x += step) {
            ctx.lineTo(x, h * (v.y + v.amp * Math.sin((x / w) * TAU * v.len + t * v.speed)));
          }
          ctx.lineTo(w, h);
          ctx.fill();
        }
      },
    };
  });

  // Orbit: three bodies round a small sun, their paths drawn faintly, with trails, under
  // stars that twinkle.
  Kit.add('art', 'orbit', (ctx, w, h) => {
    const bodies = [
      { rx: 0.4, ry: 0.16, tilt: -0.5, speed: 0.5, size: 0.018, color: '110, 231, 135' },
      { rx: 0.3, ry: 0.22, tilt: 0.7, speed: -0.7, size: 0.014, color: '138, 180, 248' },
      { rx: 0.2, ry: 0.12, tilt: 1.9, speed: 1.1, size: 0.012, color: '255, 215, 94' },
    ];
    const space = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.72);
    space.addColorStop(0, '#13204a');
    space.addColorStop(0.55, '#070b1c');
    space.addColorStop(1, '#020309');
    const sun = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.13);
    sun.addColorStop(0, 'rgba(255, 244, 214, 1)');
    sun.addColorStop(0.28, 'rgba(255, 214, 140, 0.9)');
    sun.addColorStop(1, 'rgba(255, 170, 80, 0)');
    const stars = Array.from({ length: 90 }, (_, i) => ({ x: (Math.sin(i * 12.99) * 0.5 + 0.5) * w, y: (Math.sin(i * 78.23) * 0.5 + 0.5) * h, seed: i * 1.7 }));
    const at = (b, a) => {
      const x0 = Math.cos(a) * b.rx * w;
      const y0 = Math.sin(a) * b.ry * h;
      return [w / 2 + x0 * Math.cos(b.tilt) - y0 * Math.sin(b.tilt), h / 2 + x0 * Math.sin(b.tilt) + y0 * Math.cos(b.tilt)];
    };
    return {
      frame(t) {
        ctx.fillStyle = space;
        ctx.fillRect(0, 0, w, h);
        const dot = Math.max(1, w * 0.003);
        for (const s of stars) {
          ctx.fillStyle = `rgba(220, 230, 255, ${(0.35 + 0.3 * Math.sin(t * 0.8 + s.seed)).toFixed(3)})`;
          ctx.fillRect(s.x, s.y, dot, dot);
        }
        ctx.lineWidth = Math.max(1, w * 0.002);
        for (const b of bodies) {
          ctx.strokeStyle = `rgba(${b.color}, 0.18)`;
          ctx.beginPath();
          ctx.ellipse(w / 2, h / 2, b.rx * w, b.ry * h, b.tilt, 0, TAU);
          ctx.stroke();
        }
        ctx.fillStyle = sun;
        ctx.fillRect(w * 0.37, h * 0.37, w * 0.26, h * 0.26);
        for (const b of bodies) {
          for (let i = 7; i >= 0; i -= 1) {
            const [x, y] = at(b, t * b.speed - Math.sign(b.speed) * i * 0.06);
            ctx.fillStyle = `rgba(${b.color}, ${(i ? 0.5 * (1 - i / 8) : 1).toFixed(3)})`;
            ctx.beginPath();
            ctx.arc(x, y, b.size * w * (1 - i * 0.08), 0, TAU);
            ctx.fill();
          }
        }
      },
    };
  });
})();
