/* Plays a finished AMV file on the drawn player's screen, picture and sound,
 * straight from the bytes we're about to hand over. If the preview looks and
 * sounds right, the file is right: this decodes exactly what the player will.
 *
 * Works from the Blob in slices, so a two-hour file never sits in memory. */

import { frameToJpeg, decodeAudioBlock, fps as FPS, audioSampleRate } from './amv.js';

const WINDOW = 4 << 20; // bytes per read while indexing
const AUDIO_AHEAD = 2.5; // seconds of sound scheduled ahead of the playhead
const FRAMES_AHEAD = 6;

function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function find(b, text, from = 0) {
  outer: for (let i = from; i <= b.length - text.length; i++) {
    for (let j = 0; j < text.length; j++) if (b[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Index chunk positions lazily: ensure(n) reads only as far as frame n. */
function createIndex(blob) {
  const video = []; // [offset, size, offset, size, ...]
  const audio = [];
  let pos = -1;
  let done = false;
  let busy = null;

  async function start() {
    const head = new Uint8Array(await blob.slice(0, Math.min(blob.size, 65536)).arrayBuffer());
    const movi = find(head, 'movi');
    if (movi < 0) throw new Error('not an AMV file');
    pos = movi + 4;
  }

  async function step() {
    if (pos < 0) await start();
    const stop = Math.min(blob.size, pos + WINDOW);
    const b = new Uint8Array(await blob.slice(pos, stop).arrayBuffer());
    let o = 0;
    while (o + 8 <= b.length) {
      const t0 = b[o];
      const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
      if (tag === 'AMV_' || (t0 === 0 && b[o + 1] === 0x41)) {
        done = true;
        break;
      }
      const size = u32(b, o + 4);
      if (tag === '00dc') video.push(pos + o + 8, size);
      else if (tag === '01wb') audio.push(pos + o + 8, size);
      else {
        done = true;
        break;
      }
      if (o + 8 + size > b.length && stop < blob.size) {
        // Chunk runs past this window: resume from it next time.
        o += 8 + size;
        break;
      }
      o += 8 + size;
    }
    pos += o;
    if (pos + 8 > blob.size) done = true;
  }

  return {
    video,
    audio,
    get done() {
      return done;
    },
    get frames() {
      return video.length / 2;
    },
    async ensure(frame) {
      while (!done && video.length / 2 <= frame) {
        busy = busy || step().finally(() => (busy = null));
        await busy;
      }
      return frame < video.length / 2;
    },
    async all() {
      while (!done) {
        busy = busy || step().finally(() => (busy = null));
        await busy;
      }
    },
  };
}

export function createPreview(blob, { onFrame, onEnd } = {}) {
  const index = createIndex(blob);
  let ctx = null;
  let raf = 0;
  let startAt = 0; // AudioContext time of frame 0
  let scheduledUntil = 0; // seconds of audio already scheduled
  let nextAudioBlock = 0;
  let shown = -1;
  let playing = false;
  let disposed = false;
  // Picture follows the sound's clock; if that clock never starts (no audio
  // device, a suspended context), it follows the wall clock instead.
  let wallStart = 0;
  let pausedAt = 0;
  let useWall = false;
  const frames = new Map(); // frame index -> Promise<ImageBitmap>
  const sources = [];

  async function readFrame(n) {
    if (!(await index.ensure(n))) return null;
    const off = index.video[n * 2];
    const size = index.video[n * 2 + 1];
    const data = new Uint8Array(await blob.slice(off, off + size).arrayBuffer());
    const jpeg = frameToJpeg(data);
    return createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
  }

  function frame(n) {
    if (!frames.has(n)) frames.set(n, readFrame(n).catch(() => null));
    return frames.get(n);
  }

  async function scheduleAudio() {
    if (!ctx || useWall) return;
    const playhead = ctx.currentTime - startAt;
    while (!disposed && scheduledUntil < playhead + AUDIO_AHEAD) {
      const count = Math.round(FPS); // one second of blocks per buffer
      const first = nextAudioBlock;
      if (!(await index.ensure(first))) return;
      const last = Math.min(first + count, index.audio.length / 2);
      if (last <= first) return;
      const startOff = index.audio[first * 2];
      const endOff = index.audio[(last - 1) * 2] + index.audio[(last - 1) * 2 + 1];
      const span = new Uint8Array(await blob.slice(startOff, endOff).arrayBuffer());
      const parts = [];
      let total = 0;
      for (let k = first; k < last; k++) {
        const o = index.audio[k * 2] - startOff;
        const pcm = decodeAudioBlock(span.subarray(o, o + index.audio[k * 2 + 1]));
        parts.push(pcm);
        total += pcm.length;
      }
      if (disposed || !ctx) return;
      const buffer = ctx.createBuffer(1, Math.max(1, total), audioSampleRate);
      const ch = buffer.getChannelData(0);
      let o = 0;
      for (const p of parts) {
        for (let i = 0; i < p.length; i++) ch[o + i] = p[i] / 32768;
        o += p.length;
      }
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const when = startAt + first / FPS;
      src.start(Math.max(when, ctx.currentTime));
      sources.push(src);
      if (sources.length > 8) sources.shift();
      nextAudioBlock = last;
      scheduledUntil = last / FPS;
    }
  }

  function now() {
    if (!useWall && ctx && ctx.state === 'running' && ctx.currentTime > 0) return ctx.currentTime - startAt;
    if (!useWall && performance.now() - wallStart > 400) useWall = true; // audio clock stuck
    return (performance.now() - wallStart) / 1000 - 0.15;
  }

  function tick() {
    if (!playing || disposed) return;
    const t = now();
    const n = Math.floor(t * FPS);
    if (index.done && n >= index.frames) {
      stopAll();
      onEnd?.();
      return;
    }
    if (n !== shown) {
      const want = n;
      frame(want).then((bmp) => {
        if (disposed || !bmp) return;
        if (want >= shown) {
          shown = want;
          onFrame?.(bmp);
        }
        bmp.close?.();
        frames.delete(want);
      });
      for (let k = 1; k <= FRAMES_AHEAD; k++) frame(n + k);
      for (const key of frames.keys()) if (key < n - 1) frames.delete(key);
    }
    scheduleAudio();
    raf = requestAnimationFrame(tick);
  }

  function stopAll() {
    playing = false;
    cancelAnimationFrame(raf);
    for (const s of sources) {
      try {
        s.stop();
      } catch (_) {}
    }
    sources.length = 0;
    if (ctx) {
      ctx.close().catch(() => {});
      ctx = null;
    }
  }

  return {
    item: null,
    get playing() {
      return playing;
    },
    /** Start (or resume) playback. Must be called from a click: browsers only allow sound then. */
    async play() {
      if (disposed) return;
      if (ctx && !playing) {
        await ctx.resume().catch(() => {});
        wallStart += performance.now() - pausedAt;
        playing = true;
        raf = requestAnimationFrame(tick);
        return;
      }
      const AC = window.AudioContext || window.webkitAudioContext;
      ctx = new AC();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      await index.ensure(FRAMES_AHEAD);
      startAt = ctx.currentTime + 0.15;
      wallStart = performance.now();
      useWall = false;
      scheduledUntil = 0;
      nextAudioBlock = 0;
      shown = -1;
      playing = true;
      await scheduleAudio();
      raf = requestAnimationFrame(tick);
    },
    pause() {
      if (!ctx || !playing) return;
      playing = false;
      pausedAt = performance.now();
      cancelAnimationFrame(raf);
      ctx.suspend().catch(() => {});
    },
    /** One decoded frame (upside down, as stored) near time t, for a still. */
    async frameAt(t) {
      const n = Math.max(0, Math.floor(t * FPS));
      await index.ensure(n);
      const last = Math.max(0, index.frames - 1);
      return readFrame(Math.min(n, last));
    },
    async frameCount() {
      await index.all();
      return index.frames;
    },
    dispose() {
      disposed = true;
      stopAll();
      frames.clear();
    },
  };
}
