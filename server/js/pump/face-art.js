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

  // Ember: sparks rising from a warm glow.
  Kit.add('art', 'ember', (ctx, w, h) => {
    const glow = ctx.createRadialGradient(w / 2, h * 1.05, 0, w / 2, h * 1.05, h * 0.9);
    glow.addColorStop(0, '#5a1d06');
    glow.addColorStop(1, '#070302');
    const sparks = Array.from({ length: 70 }, (_, i) => ({ seed: i * 7.31, life: (i * 0.137) % 1 }));
    return {
      frame(t) {
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
        for (const s of sparks) {
          const k = (s.life + t * 0.07 * (0.6 + (s.seed % 1))) % 1;
          const x = w * (0.5 + 0.42 * Math.sin(s.seed) * (0.4 + k)) + Math.sin(t * 1.3 + s.seed) * w * 0.02;
          const y = h * (1.02 - k * 1.1);
          const fade = 1 - k;
          ctx.fillStyle = `rgba(255, ${Math.round(120 + 110 * fade)}, ${Math.round(40 * fade)}, ${(0.85 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(x, y, w * (0.004 + 0.006 * fade), 0, TAU);
          ctx.fill();
        }
      },
    };
  });

  // Tide: waves rolling under a low moon.
  Kit.add('art', 'tide', (ctx, w, h) => {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#040814');
    sky.addColorStop(1, '#0b1f3a');
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
        ctx.fillStyle = 'rgba(237, 237, 237, 0.85)';
        ctx.beginPath();
        ctx.arc(w * 0.66, h * 0.3, w * 0.07, 0, TAU);
        ctx.fill();
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

  // Orbit: three bodies on tilted orbits, leaving short trails.
  Kit.add('art', 'orbit', (ctx, w, h) => {
    const bodies = [
      { rx: 0.4, ry: 0.16, tilt: -0.5, speed: 0.5, size: 0.016, color: '#6ee787' },
      { rx: 0.3, ry: 0.22, tilt: 0.7, speed: -0.7, size: 0.012, color: '#8ab4f8' },
      { rx: 0.2, ry: 0.12, tilt: 1.9, speed: 1.1, size: 0.01, color: '#ffd75e' },
    ];
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    return {
      frame(t) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.14)';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(237, 237, 237, 0.9)';
        ctx.beginPath();
        ctx.arc(w / 2, h / 2, w * 0.035, 0, TAU);
        ctx.fill();
        for (const b of bodies) {
          const a = t * b.speed;
          const x0 = Math.cos(a) * b.rx * w;
          const y0 = Math.sin(a) * b.ry * h;
          const x = w / 2 + x0 * Math.cos(b.tilt) - y0 * Math.sin(b.tilt);
          const y = h / 2 + x0 * Math.sin(b.tilt) + y0 * Math.cos(b.tilt);
          ctx.fillStyle = b.color;
          ctx.beginPath();
          ctx.arc(x, y, b.size * w, 0, TAU);
          ctx.fill();
        }
      },
    };
  });
})();
