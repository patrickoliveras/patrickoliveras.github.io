/* Orchestration: what the UI calls. analyze() looks at a file; convert()
 * produces a verified AMV Blob. Every failure becomes a ConvertError with a
 * code the UI can explain in plain words. */

import {
  buildPlan,
  framesPlan,
  probeArgs,
  thumbnailArgs,
  coverArgs,
  sniff,
  progressSeconds,
  OUTPUT_PATH,
  CARD_PATH,
  FRAMES_PATH,
  TARGET,
} from './plan.js';
import { browserCanPlay, browserThumbnail, captureFrames, webcodecsConfig, decodeIvfToFrames } from './browser-decode.js';
import { streamRotation } from './plan.js';
import { EngineError } from './engine.js';
import { parseAmv, parseAmvBlob, validateAmv } from './amv.js';

export class ConvertError extends Error {
  /** code: empty | not-media | unreadable | incomplete |
   * undecodable | no-frames | out-of-memory | engine-unavailable |
   * browser-unsupported | invalid-output | cancelled | internal */
  constructor(code, detail = {}) {
    super(code);
    this.name = 'ConvertError';
    this.code = code;
    this.detail = detail;
  }
}

/** Map ffmpeg's log to the reason a person can act on. */
export function classifyFailure(lines = []) {
  const text = lines.slice(-400).join('\n');
  if (/moov atom not found/i.test(text)) return 'incomplete';
  if (/Decoder \(codec [\w-]+\) not found|Unsupported codec|codec not currently supported|Could not find codec parameters for stream.*unspecified size|Function not implemented/i.test(text)) return 'undecodable';
  if (/Cannot allocate memory|out of memory|\bOOM\b|Aborted\(OOM\)|memory access out of bounds/i.test(text)) return 'out-of-memory';
  if (/Output file is empty|Nothing was written|nothing was encoded/i.test(text)) return 'no-frames';
  if (/Invalid data found when processing input|does not contain any stream|Unknown format|could not find codec parameters|EBML header parsing failed|Format .* detected only with low score|Failed to read frame size|End of file/i.test(text)) return 'unreadable';
  return 'internal';
}

const RETRYABLE_ENGINE = new Set(['stalled', 'crashed', 'oom']);

function toConvertError(err) {
  if (err instanceof ConvertError) return err;
  if (err instanceof EngineError) {
    if (err.code === 'cancelled') return new ConvertError('cancelled');
    if (err.code === 'wasm-unsupported') return new ConvertError('browser-unsupported', { message: err.message });
    if (err.code === 'load-failed') return new ConvertError('engine-unavailable', { message: err.message });
    if (err.code === 'oom') return new ConvertError('out-of-memory', { message: err.message, lines: err.lines });
    return new ConvertError('internal', { message: `${err.code}: ${err.message}`, lines: err.lines });
  }
  return new ConvertError('internal', { message: String(err && err.message ? err.message : err) });
}

/** Run a short command (probe, thumbnail), retrying once single-threaded.
 * job.args may be a function of the mode, so each build gets its own flags. */
async function runShort(engine, job) {
  const modes = engine.preferred === 'mt' ? ['mt', 'st'] : ['st'];
  let last;
  for (const mode of modes) {
    try {
      const args = typeof job.args === 'function' ? job.args(mode) : job.args;
      return await engine.run(mode, { stallMs: debugStall() || 30000, ...job, args });
    } catch (err) {
      if (err instanceof EngineError && (err.code === 'cancelled' || err.code === 'wasm-unsupported')) throw err;
      if (err instanceof EngineError && RETRYABLE_ENGINE.has(err.code)) engine.markBroken?.(mode);
      last = err;
    }
  }
  throw last;
}

function debugStall() {
  try {
    return Number(new URLSearchParams(location.search).get('debug-stall')) || 0;
  } catch (_) {
    return 0;
  }
}

const threadsFor = (engine, mode) => (mode === 'mt' ? Math.min(2, engine.threads) : 1);

const NOT_MEDIA_KINDS = new Set(['image', 'document', 'archive', 'text']);

/**
 * Look at a file: is it a video, what does it contain, what does it look like.
 * Resolves {kind:'video'|'audio-only'|'already-amv', probe, duration, display,
 * thumbnail (PNG bytes or null), cover (image bytes or null)}.
 */
export async function analyze(engine, file, { signal, forceConvert = false } = {}) {
  try {
    if (!file || file.size === 0) throw new ConvertError('empty');
    const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
    const kind = sniff(head, file.name);
    if (kind === 'empty') throw new ConvertError('empty');
    if (kind === 'amv' && !forceConvert) return { kind: 'already-amv', duration: null };
    if (NOT_MEDIA_KINDS.has(kind)) throw new ConvertError('not-media', { sniffed: kind });

    const res = await runShort(engine, {
      file,
      tool: 'ffprobe',
      args: probeArgs('/out/probe.json'),
      outputs: ['/out/probe.json'],
      signal,
    });
    const raw = res.files['/out/probe.json'];
    let probe = null;
    try {
      probe = raw && raw.length ? JSON.parse(new TextDecoder().decode(raw)) : null;
    } catch (_) {
      probe = null;
    }
    if (!probe || !Array.isArray(probe.streams) || probe.streams.length === 0) {
      const code = classifyFailure(res.lines);
      // Bytes we didn't recognize and ffmpeg can't read: say "not a video",
      // not "damaged video". A recognized container that won't read is damaged.
      const unknownBytes = kind === 'unknown' && (code === 'unreadable' || code === 'internal');
      throw new ConvertError(unknownBytes ? 'not-media' : code === 'internal' ? 'unreadable' : code, {
        sniffed: kind,
        lines: res.lines,
      });
    }

    const plan = buildPlan(probe, { mode: 'fit' });
    if (plan.kind === 'not-media') {
      throw new ConvertError('not-media', { sniffed: plan.reason === 'image-only' ? 'image' : kind });
    }
    if (plan.kind === 'undecodable') {
      // ffmpeg.wasm can't decode this picture (AV1). The browser might: with
      // WebCodecs (exact, every frame) or, failing that, by playing it.
      const webcodecs = String(plan.picked.video.codec_name) === 'av1' ? await webcodecsConfig(plan.picked.video) : null;
      const can = typeof document !== 'undefined' ? await browserCanPlay(file) : { ok: false };
      if (!webcodecs && !can.ok) throw new ConvertError('undecodable', { codec: plan.picked.video.codec_name });
      const d = plan.duration || can.duration || 0;
      const shot = await browserThumbnail(file, d > 4 ? Math.min(d * 0.2, 30) : 0);
      return {
        kind: 'video',
        browserDecode: webcodecs ? 'webcodecs' : 'playback',
        webcodecs,
        probe,
        duration: d || null,
        display: shot?.display || { width: can.width, height: can.height },
        thumbnail: shot?.png || null,
        cover: null,
        picked: plan.picked,
      };
    }

    let thumbnail = null;
    let cover = null;
    if (plan.kind === 'video') {
      const d = plan.duration || 0;
      const at = d > 4 ? Math.min(d * 0.2, 30) : 0;
      thumbnail = await grabFrame(engine, file, plan.picked.video, at, signal);
      if (!thumbnail && at > 0) thumbnail = await grabFrame(engine, file, plan.picked.video, 0, signal);
    } else if (plan.picked.cover) {
      try {
        const r = await runShort(engine, {
          file,
          args: (mode) => coverArgs(plan.picked.cover.index, '/out/cover', { threads: threadsFor(engine, mode) }),
          outputs: ['/out/cover'],
          signal,
        });
        cover = r.files['/out/cover'] || null;
      } catch (err) {
        if (err instanceof EngineError && err.code === 'cancelled') throw err;
      }
    }

    return {
      kind: plan.kind,
      probe,
      duration: plan.duration,
      display: plan.display,
      thumbnail,
      cover,
      picked: plan.picked,
    };
  } catch (err) {
    throw toConvertError(err);
  }
}

async function grabFrame(engine, file, stream, at, signal) {
  try {
    const r = await runShort(engine, {
      file,
      args: (mode) => thumbnailArgs(stream, at, '/out/thumb.png', { threads: threadsFor(engine, mode) }),
      outputs: ['/out/thumb.png'],
      signal,
    });
    const png = r.files['/out/thumb.png'];
    return png && png.length > 100 ? png : null;
  } catch (err) {
    if (err instanceof EngineError && err.code === 'cancelled') throw err;
    return null;
  }
}

/**
 * Convert to a verified AMV Blob.
 * options: {fit, card (PNG bytes, audio-only), signal, onProgress(fraction|null), onAttempt(info)}
 * Resolves {blob, frames, seconds, mode, plan, attempts}.
 */
export async function convert(engine, file, analysis, options = {}) {
  const { fit = 'fit', card = null, signal, onProgress, onAttempt, stallMs = 120000 } = options;
  if (analysis.browserDecode) return convertBrowserDecoded(engine, file, analysis, options);
  // The multi-threaded build has a fixed 1 GB of memory and every decoder
  // thread holds its own frames: fewer threads for 4K, none above it (8K
  // would run out and only then fall back).
  const v = analysis.picked?.video;
  const pixels = v ? Number(v.width) * Number(v.height) : 0;
  const mtThreads = pixels > 2.2e6 ? Math.min(4, engine.threads) : engine.threads;
  const attempts = [];
  if (engine.preferred === 'mt' && pixels <= 8.9e6) attempts.push({ mode: 'mt', stream: true });
  attempts.push({ mode: 'st', stream: true });
  attempts.push({ mode: 'st', stream: false });

  let lastError = null;
  for (const attempt of attempts) {
    if (signal?.aborted) throw new ConvertError('cancelled');
    const plan = buildPlan(analysis.probe, {
      mode: fit,
      threads: attempt.mode === 'mt' ? mtThreads : 1,
      filterThreads: attempt.mode === 'mt' ? 2 : undefined,
    });
    if (plan.kind !== 'video' && plan.kind !== 'audio-only') throw new ConvertError('internal', { message: plan.kind });
    if (plan.kind === 'audio-only' && !card) throw new ConvertError('internal', { message: 'missing card' });
    onAttempt?.({ ...attempt, index: attempts.indexOf(attempt) });
    onProgress?.(plan.duration ? 0 : null);

    const parts = [];
    let expectedOffset = 64 * 1024;
    let contiguous = true;
    try {
      const res = await engine.run(attempt.mode, {
        file,
        args: plan.args,
        extraFiles: plan.needsCard ? [{ path: CARD_PATH, data: card }] : [],
        streamOutput: attempt.stream ? { path: OUTPUT_PATH, flushBytes: 4 << 20 } : null,
        outputs: attempt.stream ? [] : [OUTPUT_PATH],
        stallMs,
        signal,
        onLog: (line) => {
          const s = progressSeconds(line);
          if (s != null && plan.duration) onProgress?.(Math.max(0, Math.min(0.995, s / plan.duration)));
        },
        onChunk: (offset, data) => {
          if (offset !== expectedOffset) contiguous = false;
          expectedOffset = offset + data.length;
          parts.push(new Blob([data]));
        },
      });

      if (res.ret !== 0) {
        const code = classifyFailure(res.lines);
        lastError = new ConvertError(code, { lines: res.lines, ret: res.ret, mode: attempt.mode });
        // A file ffmpeg can't read won't read better in another mode.
        if (code === 'unreadable' || code === 'incomplete' || code === 'undecodable' || code === 'no-frames') throw lastError;
        continue;
      }

      let blob;
      if (attempt.stream) {
        const { head, size } = res.stream || {};
        if (!head || !contiguous) {
          lastError = new ConvertError('internal', { message: 'stream gap', lines: res.lines });
          continue;
        }
        blob = new Blob([head, ...parts], { type: 'video/x-amv' });
        if (blob.size !== size) {
          lastError = new ConvertError('internal', { message: `size ${blob.size} != ${size}`, lines: res.lines });
          continue;
        }
      } else {
        const bytes = res.files[OUTPUT_PATH];
        if (!bytes) {
          lastError = new ConvertError(classifyFailure(res.lines), { lines: res.lines });
          continue;
        }
        blob = new Blob([bytes], { type: 'video/x-amv' });
      }

      const check = await verifyAmv(blob);
      if (!check.ok) {
        lastError = new ConvertError(check.frames === 0 ? 'no-frames' : 'invalid-output', {
          problems: check.problems,
          lines: res.lines,
        });
        if (check.frames === 0) throw lastError;
        continue;
      }
      onProgress?.(1);
      return {
        blob,
        frames: check.frames,
        seconds: check.frames / TARGET.fps,
        mode: attempt.mode,
        plan,
        attempts: attempts.indexOf(attempt) + 1,
        log: res.lines,
      };
    } catch (err) {
      if (err instanceof ConvertError) throw err;
      if (err instanceof EngineError) {
        if (err.code === 'cancelled') throw new ConvertError('cancelled');
        if (RETRYABLE_ENGINE.has(err.code)) {
          engine.markBroken?.(attempt.mode);
          lastError = toConvertError(err);
          continue;
        }
      }
      throw toConvertError(err);
    }
  }
  throw lastError || new ConvertError('internal');
}

/** ffmpeg copies the AV1 stream out (no decoding); WebCodecs decodes it. */
async function webcodecsFrames(engine, file, analysis, { fit, signal, onProgress }) {
  const v = analysis.picked.video;
  const parts = [];
  const res = await runShort(engine, {
    file,
    args: (mode) => ['-hide_banner', '-nostdin', '-y', ...(mode === 'mt' ? ['-threads', '1'] : []), '-i', '/in/input', '-map', `0:${v.index}`, '-c:v', 'copy', '-an', '-sn', '-dn', '-f', 'ivf', '/out/video.ivf'],
    streamOutput: { path: '/out/video.ivf', flushBytes: 4 << 20 },
    onChunk: (_offset, data) => parts.push(new Blob([data])),
    signal,
    stallMs: 60000,
  });
  if (res.ret !== 0 || !res.stream) throw new Error('could not extract the video stream');
  const ivf = new Blob([res.stream.head, ...parts]);
  onProgress?.(0.05);
  return decodeIvfToFrames(ivf, {
    config: analysis.webcodecs,
    duration: analysis.duration,
    fit,
    rotation: streamRotation(v),
    signal,
    onProgress: (f) => onProgress?.(0.05 + f * 0.8),
  });
}

/** The AV1 route: the browser decodes (85% of the bar), ffmpeg encodes. */
async function convertBrowserDecoded(engine, file, analysis, options) {
  const { fit = 'fit', signal, onProgress, onAttempt, stallMs = 120000 } = options;
  let frames;
  try {
    onAttempt?.({ mode: 'browser', stream: false, index: 0 });
    if (analysis.browserDecode === 'webcodecs') {
      frames = await webcodecsFrames(engine, file, analysis, { fit, signal, onProgress });
    } else {
      frames = await captureFrames(file, { fit, signal, onProgress: (f) => onProgress?.(f * 0.85) });
    }
  } catch (err) {
    if (err && err.code === 'cancelled') throw new ConvertError('cancelled');
    throw new ConvertError('undecodable', { codec: analysis.picked?.video?.codec_name, message: String(err && err.message) });
  }
  const modes = engine.preferred === 'mt' ? ['mt', 'st'] : ['st'];
  let lastError = null;
  for (const mode of modes) {
    if (signal?.aborted) throw new ConvertError('cancelled');
    const plan = framesPlan(analysis.probe, { mode: fit, threads: mode === 'mt' ? Math.min(2, engine.threads) : 1 });
    const total = frames.frames / TARGET.fps;
    try {
      const res = await engine.run(mode, {
        file,
        args: plan.args,
        extraBlobs: [{ dir: FRAMES_PATH.slice(0, FRAMES_PATH.lastIndexOf('/')), name: FRAMES_PATH.slice(FRAMES_PATH.lastIndexOf('/') + 1), data: frames.blob }],
        outputs: [OUTPUT_PATH],
        stallMs,
        signal,
        onLog: (line) => {
          const s = progressSeconds(line);
          if (s != null && total) onProgress?.(0.85 + 0.15 * Math.min(0.995, s / total));
        },
      });
      const bytes = res.files[OUTPUT_PATH];
      if (res.ret !== 0 || !bytes) {
        lastError = new ConvertError(classifyFailure(res.lines), { lines: res.lines, mode });
        continue;
      }
      const blob = new Blob([bytes], { type: 'video/x-amv' });
      const check = await verifyAmv(blob);
      if (!check.ok) {
        lastError = new ConvertError('invalid-output', { problems: check.problems, lines: res.lines });
        continue;
      }
      onProgress?.(1);
      return { blob, frames: check.frames, seconds: check.frames / TARGET.fps, mode: `browser+${mode}`, plan, attempts: modes.indexOf(mode) + 1, log: res.lines };
    } catch (err) {
      if (err instanceof EngineError && err.code === 'cancelled') throw new ConvertError('cancelled');
      lastError = toConvertError(err);
    }
  }
  throw lastError || new ConvertError('internal');
}

/**
 * Check a finished file against the format the player accepted: every header
 * byte, strict video/audio alternation, block sizes, frame markers, trailer.
 * Reads the Blob in windows, so it costs no extra memory at any size.
 */
export async function verifyAmv(blob) {
  try {
    const parsed = blob.size <= 64 * 1024 * 1024 ? parseAmv(new Uint8Array(await blob.arrayBuffer())) : await parseAmvBlob(blob);
    const v = validateAmv(parsed);
    return { ok: v.ok, problems: v.problems, frames: parsed.video ? parsed.video.length : 0 };
  } catch (err) {
    return { ok: false, problems: [{ code: 'verify-crash', message: String(err && err.message) }], frames: 0 };
  }
}
