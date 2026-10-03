/* The player's screen: one canvas, a few moods.
 * Preview geometry comes from plan.layout(), the same function that builds
 * the ffmpeg filter, so what the screen shows is what the file will hold. */

import { layout, TARGET } from './plan.js';
import { t } from './i18n.js';

const reduceMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createScreen(canvas) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const W = canvas.width;
  const H = canvas.height;
  const sx = W / TARGET.width; // canvas pixels per output pixel
  let raf = 0;
  let mood = 'idle';
  let thumb = null; // {color: canvas, gray: canvas} rendered at final geometry
  let reveal = 0;
  let shownReveal = 0;

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  function loop(draw) {
    stop();
    const tick = (now) => {
      draw(now / 1000);
      if (!reduceMotion()) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function clear(color = '#0d0b0a') {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, W, H);
  }

  // The player's own home screen, reduced to its Video tile: a white rounded
  // square with a bright play triangle, on black, breathing gently.
  function drawIdle(time) {
    const a = Math.sin(time * 0.8) * 0.5 + 0.5;
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, '#16120f');
    bg.addColorStop(1, '#060505');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H * 0.44;
    const glow = ctx.createRadialGradient(cx, cy, 20, cx, cy, W * 0.45);
    glow.addColorStop(0, `rgba(160, 120, 255, ${0.16 + a * 0.08})`);
    glow.addColorStop(0.5, `rgba(255, 150, 80, ${0.06 + a * 0.04})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const s = 150 + a * 4;
    const x = cx - s / 2;
    const y = cy - s / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 8;
    roundRect(x, y, s, s, s * 0.24);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // play triangle with the tile's yellow-to-violet gradient
    const g = ctx.createLinearGradient(x + s * 0.3, y + s * 0.25, x + s * 0.75, y + s * 0.78);
    g.addColorStop(0, '#ffc93c');
    g.addColorStop(0.45, '#ff7a59');
    g.addColorStop(1, '#7b5cff');
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineWidth = s * 0.09;
    ctx.strokeStyle = g;
    ctx.beginPath();
    ctx.moveTo(x + s * 0.36, y + s * 0.27);
    ctx.lineTo(x + s * 0.74, y + s * 0.5);
    ctx.lineTo(x + s * 0.36, y + s * 0.73);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 34px "Atkinson Hyperlegible Next", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(t('device.videoTile'), cx, y + s + 52);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawChecking(t) {
    clear('#14100d');
    const x = ((t * 0.6) % 1.6) - 0.3;
    const g = ctx.createLinearGradient((x - 0.3) * W, 0, (x + 0.3) * W, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,240,220,0.08)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  /** Render the thumbnail at the geometry the conversion will produce. */
  function compose(bitmap, display, fit) {
    const out = document.createElement('canvas');
    out.width = W;
    out.height = H;
    const c = out.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, W, H);
    c.imageSmoothingQuality = 'high';
    const box = layout(display || { width: bitmap.width, height: bitmap.height }, fit);
    if (box.crop) {
      c.drawImage(bitmap, -box.crop.x * sx, -box.crop.y * sx, box.scaleW * sx, box.scaleH * sx);
    } else {
      c.drawImage(bitmap, box.x * sx, box.y * sx, box.scaleW * sx, box.scaleH * sx);
    }
    // A gray twin for the "arriving" reveal; done by hand so every browser can.
    const gray = document.createElement('canvas');
    gray.width = W;
    gray.height = H;
    const gc = gray.getContext('2d');
    const img = c.getImageData(0, 0, W, H);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const y = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) * 0.62 + 6;
      d[i] = y;
      d[i + 1] = y * 0.97;
      d[i + 2] = y * 0.93;
    }
    gc.putImageData(img, 0, 0);
    return { color: out, gray };
  }

  function drawReveal(t) {
    if (!thumb) return drawChecking(t);
    shownReveal += (reveal - shownReveal) * (reduceMotion() ? 1 : 0.12);
    const edge = Math.round(shownReveal * W);
    ctx.drawImage(thumb.gray, 0, 0);
    if (edge > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, edge, H);
      ctx.clip();
      ctx.drawImage(thumb.color, 0, 0);
      ctx.restore();
    }
    if (edge > 0 && edge < W) {
      const g = ctx.createLinearGradient(edge - 26, 0, edge + 4, 0);
      g.addColorStop(0, 'rgba(242,196,107,0)');
      g.addColorStop(0.85, 'rgba(255,214,140,0.55)');
      g.addColorStop(1, 'rgba(255,240,210,0.95)');
      ctx.fillStyle = g;
      ctx.fillRect(edge - 26, 0, 30, H);
    }
  }

  function drawError() {
    clear('#1a1210');
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.strokeStyle = 'rgba(240, 160, 140, 0.8)';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 0, 58, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -26);
    ctx.lineTo(0, 10);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 30, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(240, 160, 140, 0.9)';
    ctx.fill();
    ctx.restore();
  }

  return {
    get mood() {
      return mood;
    },
    idle() {
      mood = 'idle';
      thumb = null;
      loop(drawIdle);
      if (reduceMotion()) drawIdle(0);
    },
    checking() {
      mood = 'checking';
      thumb = null;
      loop(drawChecking);
      if (reduceMotion()) drawChecking(0);
    },
    /** Show a picture that will be revealed in color as `progress` grows. */
    arriving(bitmap, display, fit, progress = 0) {
      mood = 'arriving';
      thumb = bitmap ? compose(bitmap, display, fit) : null;
      reveal = progress;
      shownReveal = progress;
      loop(drawReveal);
      drawReveal(0);
    },
    progress(p) {
      reveal = Math.max(0, Math.min(1, p || 0));
      if (reduceMotion()) drawReveal(0);
    },
    /** A finished picture (full color, no animation). */
    still(bitmap, display, fit) {
      stop();
      mood = 'still';
      thumb = bitmap ? compose(bitmap, display, fit) : null;
      if (thumb) ctx.drawImage(thumb.color, 0, 0);
      else clear();
    },
    /** A decoded AMV frame: 320x240, stored upside down. */
    frame(bitmap) {
      stop();
      mood = 'frame';
      ctx.save();
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(0, H);
      ctx.scale(1, -1);
      ctx.drawImage(bitmap, 0, 0, W, H);
      ctx.restore();
    },
    /** A ready-made 320x240 picture (title card), drawn as is. */
    image(source) {
      stop();
      mood = 'image';
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(source, 0, 0, W, H);
    },
    error() {
      stop();
      mood = 'error';
      drawError();
    },
    stop,
  };
}
