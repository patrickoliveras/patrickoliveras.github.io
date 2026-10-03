/* For songs and other audio-only files: a 320x240 title card that becomes
 * the picture. Drawn at the player's real resolution, so the type is sized
 * for a 3-inch screen. */

const W = 320;
const H = 240;

function wrap(ctx, text, maxWidth, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  // Break single words that are wider than the box.
  const out = [];
  for (let l of lines) {
    while (ctx.measureText(l).width > maxWidth && l.length > 1) {
      let i = l.length - 1;
      while (i > 1 && ctx.measureText(l.slice(0, i)).width > maxWidth) i--;
      out.push(l.slice(0, i));
      l = l.slice(i);
    }
    out.push(l);
  }
  if (out.length > maxLines) {
    const kept = out.slice(0, maxLines);
    let last = kept[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    kept[maxLines - 1] = last.replace(/[\s.,;:-]+$/, '') + '…';
    return kept;
  }
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function noteGlyph(ctx, x, y, s, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s / 24, s / 24);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.ellipse(6, 18, 3.6, 2.8, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(17, 15.5, 3.6, 2.8, -0.35, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(9.3, 17.5);
  ctx.lineTo(9.3, 5);
  ctx.lineTo(20.3, 2.5);
  ctx.lineTo(20.3, 15);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(9.3, 8.5);
  ctx.lineTo(20.3, 6);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draw the card and return {png: Uint8Array, canvas}.
 * cover: image bytes (JPEG/PNG) from the file's embedded artwork, or null.
 */
export async function makeCard({ title, cover = null }) {
  try {
    await Promise.all([
      document.fonts.load('600 22px Fraunces'),
      document.fonts.load('700 14px "Atkinson Hyperlegible Next"'),
    ]);
  } catch (_) {
    // fall back to system fonts
  }
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#3a2116');
  bg.addColorStop(0.6, '#1d120d');
  bg.addColorStop(1, '#120b08');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W * 0.78, H * 0.1, 8, W * 0.78, H * 0.1, W * 0.75);
  glow.addColorStop(0, 'rgba(242,180,90,0.35)');
  glow.addColorStop(1, 'rgba(242,180,90,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  let art = null;
  if (cover && cover.length) {
    try {
      art = await createImageBitmap(new Blob([cover]));
    } catch (_) {
      art = null;
    }
  }

  const display = 'Fraunces, Georgia, serif';
  ctx.textBaseline = 'alphabetic';
  if (art) {
    const S = 132;
    const x = 22;
    const y = (H - S) / 2;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 6;
    roundRect(ctx, x, y, S, S, 10);
    ctx.fillStyle = '#000';
    ctx.fill();
    ctx.restore();
    ctx.save();
    roundRect(ctx, x, y, S, S, 10);
    ctx.clip();
    const scale = Math.max(S / art.width, S / art.height);
    const dw = art.width * scale;
    const dh = art.height * scale;
    ctx.drawImage(art, x + (S - dw) / 2, y + (S - dh) / 2, dw, dh);
    ctx.restore();
    const tx = x + S + 18;
    const tw = W - tx - 16;
    ctx.font = `600 21px ${display}`;
    const lines = wrap(ctx, title, tw, 5);
    const lh = 25;
    let ty = H / 2 - (lines.length * lh) / 2 + 18;
    noteGlyph(ctx, tx, ty - 44, 20, '#f2c46b');
    ctx.fillStyle = '#fbf1e4';
    for (const l of lines) {
      ctx.fillText(l, tx, ty);
      ty += lh;
    }
  } else {
    noteGlyph(ctx, W / 2 - 26, 30, 52, '#f2c46b');
    ctx.font = `600 24px ${display}`;
    ctx.textAlign = 'center';
    const lines = wrap(ctx, title, W - 40, 3);
    const lh = 29;
    let ty = 128 + (3 - lines.length) * (lh / 2);
    ctx.fillStyle = '#fbf1e4';
    for (const l of lines) {
      ctx.fillText(l, W / 2, ty);
      ty += lh;
    }
  }

  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  );
  return { png: new Uint8Array(await blob.arrayBuffer()), canvas };
}
