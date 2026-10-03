/* The ZUSZOX 3" player, drawn from product photos (docs/device-research.md):
 * an all-glass black slab, H:W 1.38 upright, a 240x320 portrait screen, a
 * ring home key under it, power and a volume rocker on its right edge. Video
 * plays with the player turned sideways (top edge to the left, ring on the
 * right), so that's how it's drawn: keys along the top edge, the video
 * filling the display. The screen rectangle is published as CSS variables so
 * the canvas overlay sits exactly on the drawn display.
 *
 * Measurements, in units of the upright body width (100) and height (138):
 * bezels left/right 12, top 13, bottom 24; display 76 x 101; ring centered
 * in the bottom bezel; power at 29-38% and the rocker at 45-70% of the right
 * edge. Here 1 unit = 3 px. */

const U = 3;
const VIEW = { w: 426, h: 318 };
const BODY = { x: 6, y: 12, w: 138 * U, h: 100 * U, r: 28 };
const GLASS = { x: BODY.x + 4, y: BODY.y + 4, w: BODY.w - 8, h: BODY.h - 8, r: 24 };
const SCREEN = { x: BODY.x + 13 * U, y: BODY.y + 12 * U, w: 304, h: 228 };
const HOME = { cx: BODY.x + 126 * U, cy: BODY.y + 50 * U, r: 12 };
const KEYS = [
  { x: BODY.x + 0.29 * BODY.w, w: 0.09 * BODY.w }, // power
  { x: BODY.x + 0.45 * BODY.w, w: 0.25 * BODY.w }, // volume rocker
];

const svg = `
<svg viewBox="0 0 ${VIEW.w} ${VIEW.h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="dv-edge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a4541"/>
      <stop offset="0.08" stop-color="#26221f"/>
      <stop offset="0.92" stop-color="#151311"/>
      <stop offset="1" stop-color="#2c2825"/>
    </linearGradient>
    <linearGradient id="dv-glass" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1b1917"/>
      <stop offset="0.5" stop-color="#0b0a09"/>
      <stop offset="1" stop-color="#040404"/>
    </linearGradient>
    <linearGradient id="dv-sheen" x1="0" y1="0" x2="1" y2="0.7">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.13"/>
      <stop offset="0.38" stop-color="#ffffff" stop-opacity="0.035"/>
      <stop offset="0.39" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="dv-key" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3b3632"/>
      <stop offset="1" stop-color="#121010"/>
    </linearGradient>
    <clipPath id="dv-glass-clip"><rect x="${GLASS.x}" y="${GLASS.y}" width="${GLASS.w}" height="${GLASS.h}" rx="${GLASS.r}"/></clipPath>
  </defs>

  ${KEYS.map((k) => `<rect x="${k.x.toFixed(1)}" y="${BODY.y - 2.4}" width="${k.w.toFixed(1)}" height="8" rx="2.5" fill="url(#dv-key)"/>`).join('')}

  <rect x="${BODY.x}" y="${BODY.y}" width="${BODY.w}" height="${BODY.h}" rx="${BODY.r}" fill="url(#dv-edge)"/>
  <rect x="${BODY.x + 0.75}" y="${BODY.y + 0.75}" width="${BODY.w - 1.5}" height="${BODY.h - 1.5}" rx="${BODY.r - 0.75}" fill="none" stroke="#6b645e" stroke-opacity="0.55" stroke-width="1.5"/>

  <rect x="${GLASS.x}" y="${GLASS.y}" width="${GLASS.w}" height="${GLASS.h}" rx="${GLASS.r}" fill="url(#dv-glass)"/>
  <rect x="${GLASS.x + 0.5}" y="${GLASS.y + 0.5}" width="${GLASS.w - 1}" height="${GLASS.h - 1}" rx="${GLASS.r - 0.5}" fill="none" stroke="#000" stroke-opacity="0.9" stroke-width="1"/>

  <rect x="${SCREEN.x - 1.5}" y="${SCREEN.y - 1.5}" width="${SCREEN.w + 3}" height="${SCREEN.h + 3}" rx="3" fill="#000"/>

  <circle cx="${HOME.cx}" cy="${HOME.cy}" r="${HOME.r}" fill="none" stroke="#d9d2ca" stroke-opacity="0.72" stroke-width="2.6"/>

  <g clip-path="url(#dv-glass-clip)">
    <polygon points="${GLASS.x},${GLASS.y} ${GLASS.x + GLASS.w * 0.62},${GLASS.y} ${GLASS.x + GLASS.w * 0.22},${GLASS.y + GLASS.h} ${GLASS.x},${GLASS.y + GLASS.h}" fill="url(#dv-sheen)"/>
  </g>
</svg>`;

export const geometry = { VIEW, SCREEN, HOME };

export function mountDevice(figure, body) {
  body.innerHTML = svg;
  figure.style.setProperty('--device-aspect', String(VIEW.w / VIEW.h));
  figure.style.setProperty('--screen-x', `${(SCREEN.x / VIEW.w) * 100}%`);
  figure.style.setProperty('--screen-y', `${(SCREEN.y / VIEW.h) * 100}%`);
  figure.style.setProperty('--screen-w', `${(SCREEN.w / VIEW.w) * 100}%`);
}
