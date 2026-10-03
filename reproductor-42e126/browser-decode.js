/* When ffmpeg.wasm can't decode a video codec (AV1 today: the build has no
 * AV1 decoder), let the browser do it. A hidden <video> plays the file in
 * real time; at every 1/14 s of media time we draw the current frame at the
 * player's exact geometry and keep it as a JPEG. ffmpeg then encodes those
 * frames with the same AMV settings, taking the sound from the original file.
 *
 * The page has to stay visible while this runs: browsers stop painting video
 * in hidden tabs, so we pause when hidden and pick up where we left off. */

import { layout, TARGET } from './plan.js';

const W = TARGET.width;
const H = TARGET.height;
const FPS = TARGET.fps;

function once(target, event, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const t = timeoutMs ? setTimeout(() => done(new Error(`timeout waiting for ${event}`)), timeoutMs) : null;
    const onEvent = () => done(null);
    const onError = () => done(new Error(`media error ${target.error?.code || ''}`));
    const onAbort = () => done(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    function done(err) {
      clearTimeout(t);
      target.removeEventListener(event, onEvent);
      target.removeEventListener('error', onError);
      signal?.removeEventListener('abort', onAbort);
      err ? reject(err) : resolve();
    }
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener('error', onError, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function makeVideo(file) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.disablePictureInPicture = true;
  const url = URL.createObjectURL(file);
  video.src = url;
  // Some browsers only decode attached video; keep it in the page, invisible.
  Object.assign(video.style, { position: 'fixed', left: '-10000px', top: '0', width: '160px', height: '120px', opacity: '0', pointerEvents: 'none' });
  document.body.append(video);
  return {
    video,
    dispose() {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (_) {}
      video.remove();
      URL.revokeObjectURL(url);
    },
  };
}

/** Can this browser decode the file's picture? Resolves {ok, width, height, duration}. */
export async function browserCanPlay(file, timeoutMs = 8000) {
  const { video, dispose } = makeVideo(file);
  try {
    await once(video, 'loadeddata', timeoutMs);
    const ok = video.videoWidth > 0 && video.videoHeight > 0;
    return { ok, width: video.videoWidth, height: video.videoHeight, duration: Number.isFinite(video.duration) ? video.duration : null };
  } catch (_) {
    return { ok: false };
  } finally {
    dispose();
  }
}

function draw(ctx, video, display, fit, sx = 1) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W * sx, H * sx);
  const box = layout(display, fit);
  if (box.crop) ctx.drawImage(video, -box.crop.x * sx, -box.crop.y * sx, box.scaleW * sx, box.scaleH * sx);
  else ctx.drawImage(video, box.x * sx, box.y * sx, box.scaleW * sx, box.scaleH * sx);
}

/** A still (PNG bytes) at time t, full picture at 640x480-fit, for the preview. */
export async function browserThumbnail(file, t) {
  const { video, dispose } = makeVideo(file);
  try {
    await once(video, 'loadeddata', 8000);
    const display = { width: video.videoWidth, height: video.videoHeight };
    if (t > 0) {
      video.currentTime = Math.min(t, Math.max(0, (video.duration || t) - 0.1));
      await once(video, 'seeked', 8000);
    }
    const box = layout(display, 'fit');
    const canvas = document.createElement('canvas');
    canvas.width = box.scaleW * 2;
    canvas.height = box.scaleH * 2;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    return { png: new Uint8Array(await blob.arrayBuffer()), display };
  } catch (_) {
    return null;
  } finally {
    dispose();
  }
}

/**
 * Play the file and capture one JPEG per 1/14 s of media time.
 * Resolves {blob (concatenated JPEGs, an MJPEG stream), frames}.
 */
export async function captureFrames(file, { fit = 'fit', onProgress, signal } = {}) {
  const { video, dispose } = makeVideo(file);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const parts = [];
  let onVisibility = null;
  try {
    await once(video, 'loadeddata', 15000, signal);
    const display = { width: video.videoWidth, height: video.videoHeight };
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
    const total = duration ? Math.max(1, Math.round(duration * FPS)) : Infinity;
    let n = 0;

    const snapshot = () => {
      draw(ctx, video, display, fit);
      // toBlob copies the canvas now, so the canvas can be reused at once.
      parts.push(new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)));
      n++;
    };
    const catchUp = (mediaTime) => {
      while (n < total && n / FPS <= mediaTime + 0.5 / FPS) snapshot();
      if (duration) onProgress?.(Math.min(1, mediaTime / duration));
    };

    await new Promise((resolve, reject) => {
      const onAbort = () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      const finish = () => {
        // The element shows the last frame; repeat it up to the full length.
        if (Number.isFinite(total)) while (n < total) snapshot();
        else if (!n) snapshot();
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      video.addEventListener('ended', finish, { once: true });
      video.addEventListener('error', () => reject(new Error('media error during capture')), { once: true });

      if (typeof video.requestVideoFrameCallback === 'function') {
        const onFrame = (_now, meta) => {
          catchUp(meta.mediaTime);
          if (!video.ended) video.requestVideoFrameCallback(onFrame);
        };
        video.requestVideoFrameCallback(onFrame);
        // Real time: every browser presents every frame at 1x, so no 1/14 s
        // sample is ever taken from a frame that's too old.
        video.playbackRate = 1;
        onVisibility = () => {
          if (document.hidden) video.pause();
          else if (!video.ended) video.play().catch(() => {});
        };
        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) video.play().catch(reject);
      } else {
        // No frame callbacks (older browsers): step through by seeking.
        (async () => {
          try {
            while (n < total) {
              const t = n / FPS;
              if (duration && t >= duration) break;
              video.currentTime = t;
              await once(video, 'seeked', 10000, signal);
              snapshot();
              if (duration) onProgress?.(Math.min(1, t / duration));
            }
            finish();
          } catch (err) {
            reject(err);
          }
        })();
      }
    });

    const blobs = await Promise.all(parts);
    if (blobs.some((b) => !b)) throw new Error('a frame could not be encoded');
    return { blob: new Blob(blobs, { type: 'video/x-motion-jpeg' }), frames: blobs.length };
  } finally {
    if (onVisibility) document.removeEventListener('visibilitychange', onVisibility);
    dispose();
  }
}

// ---------------------------------------------------------------- WebCodecs

/** The AV1 codec string WebCodecs wants, from ffprobe's stream fields. */
export function av1CodecString(stream) {
  const profile = /high/i.test(stream?.profile || '') ? 1 : /professional/i.test(stream?.profile || '') ? 2 : 0;
  const lvl = Number.isFinite(Number(stream?.level)) && Number(stream.level) >= 0 ? Number(stream.level) : 8;
  const depth = /1[02]/.test(String(stream?.pix_fmt || '')) ? (/12/.test(stream.pix_fmt) ? 12 : 10) : 8;
  return `av01.${profile}.${String(Math.min(lvl, 31)).padStart(2, '0')}M.${String(depth).padStart(2, '0')}`;
}

/** Can this browser's VideoDecoder take this stream? Returns a working config or null. */
export async function webcodecsConfig(stream) {
  if (typeof VideoDecoder === 'undefined' || typeof EncodedVideoChunk === 'undefined') return null;
  const w = Number(stream?.width) || 0;
  const h = Number(stream?.height) || 0;
  const depth = /1[02]/.test(String(stream?.pix_fmt || '')) ? '10' : '08';
  const candidates = [av1CodecString(stream), `av01.0.15M.${depth}`, `av01.0.08M.${depth}`, 'av01.0.08M.08'];
  for (const codec of [...new Set(candidates)]) {
    const config = { codec, codedWidth: w || undefined, codedHeight: h || undefined, optimizeForLatency: false };
    try {
      const r = await VideoDecoder.isConfigSupported(config);
      if (r && r.supported) return config;
    } catch (_) {
      // try the next string
    }
  }
  return null;
}

function readU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

/** Walk an IVF file (as ffmpeg's `-f ivf` writes it) in slices. */
async function* ivfFrames(blob) {
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  if (String.fromCharCode(...head.subarray(0, 4)) !== 'DKIF') throw new Error('not an IVF stream');
  const headerSize = head[6] | (head[7] << 8);
  const den = readU32(head, 16) || 1;
  const num = readU32(head, 20) || 1;
  let pos = headerSize;
  const WIN = 4 << 20;
  let buf = new Uint8Array(0);
  let bufStart = pos;
  const ensure = async (need) => {
    if (pos + need <= bufStart + buf.length) return true;
    const start = pos;
    const end = Math.min(blob.size, start + Math.max(WIN, need));
    if (end - start < need) return false;
    buf = new Uint8Array(await blob.slice(start, end).arrayBuffer());
    bufStart = start;
    return true;
  };
  while (pos + 12 <= blob.size) {
    if (!(await ensure(12))) break;
    let o = pos - bufStart;
    const size = readU32(buf, o);
    const ptsLo = readU32(buf, o + 4);
    const ptsHi = readU32(buf, o + 8);
    const pts = ptsHi * 4294967296 + ptsLo;
    if (!(await ensure(12 + size))) break;
    o = pos - bufStart;
    yield { seconds: (pts * num) / den, data: buf.slice(o + 12, o + 12 + size) };
    pos += 12 + size;
  }
}

/** A temporal unit carrying a sequence header starts a decodable keyframe. */
function hasSequenceHeader(data) {
  let o = 0;
  while (o < data.length) {
    const header = data[o];
    const type = (header >> 3) & 0x0f;
    const hasExt = (header >> 2) & 1;
    const hasSize = (header >> 1) & 1;
    if (type === 1) return true;
    let p = o + 1 + hasExt;
    if (!hasSize) return false;
    let size = 0;
    for (let i = 0; i < 8; i++) {
      const byte = data[p++];
      size |= (byte & 0x7f) << (7 * i);
      if (!(byte & 0x80)) break;
    }
    o = p + size;
  }
  return false;
}

/**
 * Decode an IVF elementary stream with WebCodecs and render one JPEG per
 * 1/14 s at the player's geometry. Each output frame shows the latest decoded
 * frame at or before its time, like ffmpeg's fps filter.
 * opts: {config, stream (ffprobe), duration, fit, rotation, onProgress, signal}
 */
export async function decodeIvfToFrames(ivf, opts) {
  const { config, duration, fit = 'fit', rotation = 0, onProgress, signal } = opts;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  const parts = [];
  let n = 0;
  let prev = null;
  let failure = null;
  const total = duration ? Math.max(1, Math.round(duration * FPS)) : null;

  const render = (frame) => {
    const rot = ((rotation % 360) + 360) % 360;
    const fw = frame.displayWidth;
    const fh = frame.displayHeight;
    const display = rot === 90 || rot === 270 ? { width: fh, height: fw } : { width: fw, height: fh };
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const box = layout(display, fit);
    // Destination rectangle for the (rotated) picture on the 320x240 screen.
    const dx = box.crop ? -box.crop.x : box.x;
    const dy = box.crop ? -box.crop.y : box.y;
    const dw = box.scaleW;
    const dh = box.scaleH;
    ctx.save();
    ctx.translate(dx + dw / 2, dy + dh / 2);
    ctx.rotate((rot * Math.PI) / 180);
    const [pw, ph] = rot === 90 || rot === 270 ? [dh, dw] : [dw, dh];
    ctx.drawImage(frame, -pw / 2, -ph / 2, pw, ph);
    ctx.restore();
    parts.push(new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92)));
    n++;
  };

  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1e6;
      if (!prev) {
        // Before the first picture: hold it, like fps=start_time=0 does.
        while (n / FPS < t - 0.5 / FPS && (total == null || n < total)) render(frame);
      } else {
        while (n / FPS < t - 0.5 / FPS && (total == null || n < total)) render(prev);
        prev.close();
      }
      prev = frame;
      if (duration) onProgress?.(Math.min(1, t / duration));
    },
    error: (e) => {
      failure = e;
    },
  });
  decoder.configure(config);

  let first = true;
  for await (const f of ivfFrames(ivf)) {
    if (signal?.aborted) {
      decoder.close();
      throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    }
    if (failure) break;
    const key = first || hasSequenceHeader(f.data);
    if (first && !key) continue; // can't start mid-GOP
    first = false;
    decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Math.round(f.seconds * 1e6), data: f.data }));
    // Back-pressure: don't let the queue or undelivered frames pile up.
    while (decoder.decodeQueueSize > 6) await new Promise((r) => setTimeout(r, 4));
  }
  if (!failure) await decoder.flush().catch((e) => (failure = e));
  try {
    decoder.close();
  } catch (_) {}
  if (failure && !prev) throw failure;
  if (prev) {
    const end = total != null ? total : n + 1;
    while (n < end) render(prev);
    prev.close();
  }
  const blobs = await Promise.all(parts);
  if (!blobs.length || blobs.some((b) => !b)) throw new Error('no frames decoded');
  return { blob: new Blob(blobs, { type: 'video/x-motion-jpeg' }), frames: blobs.length };
}
