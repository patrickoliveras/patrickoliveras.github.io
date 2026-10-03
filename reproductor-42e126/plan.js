/* Pure conversion logic: ffprobe JSON + options in, ffmpeg arguments out.
 * No DOM, no workers, no I/O, so every rule here is unit-tested in Node.
 *
 * The target is the format the ZUSZOX 3" player (Actions chip) was proven to
 * play: AMV container, 320x240, 14 fps, AMV video (yuvj420p), IMA ADPCM AMV
 * audio, mono, 22050 Hz, 1575 samples per block (22050 / 14). */

export const TARGET = Object.freeze({
  width: 320,
  height: 240,
  fps: 14,
  sampleRate: 22050,
  blockSize: 1575,
  // Measured on the reference conversions: about 1 MB every 8 to 10 seconds.
  bytesPerSecondEstimate: 165_000,
});

/** Fit modes the user can choose between. */
export const FIT_MODES = Object.freeze(['fit', 'fill', 'stretch']);

/** Codecs ffmpeg.wasm (FFmpeg 5.1, no dav1d/libaom) can probe but not decode. */
export const UNDECODABLE_VIDEO_CODECS = new Set(['av1', 'vvc', 'h266', 'apv', 'jpegxs', 'lcevc']);

/** The input name inside the wasm filesystem. Fixed, so a user's file name can
 * never be read by ffmpeg as a protocol ("concat:", "pipe:") or an option. */
export const INPUT_PATH = '/in/input';
export const OUTPUT_PATH = '/out/output.amv';
export const CARD_PATH = '/in2/card.png';
export const FRAMES_PATH = '/in3/frames.mjpeg';

// ---------------------------------------------------------------- parsing

/** "16:9" -> 1.777..., "30000/1001" -> 29.97; null for 0, N/A or garbage. */
export function parseRatio(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  const m = String(value).trim().match(/^(-?\d+(?:\.\d+)?)\s*[:/]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const num = Number(m[1]);
    const den = Number(m[2]);
    if (!(num > 0) || !(den > 0)) return null;
    const r = num / den;
    return Number.isFinite(r) ? r : null;
  }
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Display rotation in degrees clockwise, normalized to 0, 90, 180 or 270. */
export function streamRotation(stream) {
  let deg = null;
  for (const sd of stream?.side_data_list || []) {
    if (sd && sd.rotation != null && Number.isFinite(Number(sd.rotation))) {
      deg = Number(sd.rotation);
      break;
    }
  }
  if (deg == null && stream?.tags?.rotate != null) {
    // Old-style tag is clockwise; display-matrix rotation is counter-clockwise.
    const tag = Number(stream.tags.rotate);
    if (Number.isFinite(tag)) deg = -tag;
  }
  if (deg == null) return 0;
  // ffprobe reports the display matrix angle counter-clockwise; flip the sign.
  const cw = ((Math.round(-deg / 90) * 90) % 360 + 360) % 360;
  return cw;
}

/** Size a viewer actually sees: coded size corrected by SAR, then rotated. */
export function displaySize(stream) {
  const w = num(stream?.width);
  const h = num(stream?.height);
  if (!w || !h || w <= 0 || h <= 0) return null;
  const sar = parseRatio(stream.sample_aspect_ratio) || 1;
  // Ignore absurd SARs from broken headers rather than producing a sliver.
  const safeSar = sar > 0.2 && sar < 5 ? sar : 1;
  let dw = w * safeSar;
  let dh = h;
  const rot = streamRotation(stream);
  if (rot === 90 || rot === 270) [dw, dh] = [dh, dw];
  return { width: dw, height: dh, rotation: rot, sar: safeSar };
}

const INTERLACED_ORDERS = new Set(['tt', 'bb', 'tb', 'bt']);

/** HDR transfer the stream declares, or 'none'. */
export function hdrKind(stream) {
  const trc = String(stream?.color_transfer || '').toLowerCase();
  if (trc === 'smpte2084') return 'pq';
  if (trc === 'arib-std-b67') return 'hlg';
  return 'none';
}

// ------------------------------------------------------- stream selection

function isRealVideo(s) {
  if (!s || s.codec_type !== 'video') return false;
  const d = s.disposition || {};
  if (d.attached_pic === 1 || d.timed_thumbnails === 1 || d.still_image === 1) return false;
  if (!(num(s.width) > 0 && num(s.height) > 0)) return false;
  return true;
}

function isUsableAudio(s) {
  if (!s || s.codec_type !== 'audio') return false;
  if (s.codec_name === 'none' || !s.codec_name) return false;
  const ch = num(s.channels);
  if (ch !== null && ch <= 0) return false;
  return true;
}

/**
 * Pick the streams to convert.
 * Video: the largest real picture (not cover art); ties go to the default
 * disposition, then the lowest index. Audio: the default-flagged track if
 * any, else the first usable one. Cover: an attached picture, for audio-only.
 */
export function pickStreams(probe) {
  const streams = Array.isArray(probe?.streams) ? probe.streams : [];
  const videos = streams.filter(isRealVideo);
  videos.sort((a, b) => {
    const area = (s) => num(s.width) * num(s.height);
    if (area(b) !== area(a)) return area(b) - area(a);
    const def = (s) => (s.disposition?.default === 1 ? 1 : 0);
    if (def(b) !== def(a)) return def(b) - def(a);
    return a.index - b.index;
  });
  const audios = streams.filter(isUsableAudio);
  const audio = audios.find((s) => s.disposition?.default === 1) || audios[0] || null;
  const cover = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1) || null;
  return { video: videos[0] || null, audio, cover };
}

/** Best duration estimate in seconds, or null if the file doesn't say. */
export function mediaDuration(probe, picked) {
  const candidates = [num(probe?.format?.duration)];
  for (const s of [picked?.video, picked?.audio]) {
    if (s) candidates.push(num(s.duration));
  }
  const good = candidates.filter((d) => d != null && d > 0 && d < 60 * 60 * 48);
  if (!good.length) return null;
  // The container duration covers both streams; prefer it, else the longest.
  return good[0] === candidates[0] ? good[0] : Math.max(...good);
}

// ------------------------------------------------------------ geometry

const even = (x) => Math.max(2, 2 * Math.round(x / 2));
const evenFloor = (x) => Math.max(0, 2 * Math.floor(x / 2));

/**
 * Where the picture lands on the 320x240 screen.
 * fit: whole picture, black bars; fill: no bars, edges cropped; stretch: distort.
 * Returns {scaleW, scaleH, x, y, cropW, cropH, cropX, cropY} in output pixels.
 */
export function layout(display, mode = 'fit', target = TARGET) {
  const W = target.width;
  const H = target.height;
  if (!display || !(display.width > 0) || !(display.height > 0) || mode === 'stretch') {
    return { mode: display ? mode : 'stretch', scaleW: W, scaleH: H, x: 0, y: 0, crop: null };
  }
  const srcAspect = display.width / display.height;
  const dstAspect = W / H;
  // Within 1.5% of 4:3 a bar or crop would be 1-2 px of noise: fill exactly.
  if (Math.abs(srcAspect / dstAspect - 1) < 0.015) {
    return { mode, scaleW: W, scaleH: H, x: 0, y: 0, crop: null };
  }
  if (mode === 'fill') {
    const s = Math.max(W / display.width, H / display.height);
    const scaleW = Math.max(W, even(display.width * s));
    const scaleH = Math.max(H, even(display.height * s));
    return {
      mode,
      scaleW,
      scaleH,
      x: 0,
      y: 0,
      crop: { w: W, h: H, x: evenFloor((scaleW - W) / 2), y: evenFloor((scaleH - H) / 2) },
    };
  }
  const s = Math.min(W / display.width, H / display.height);
  const scaleW = Math.min(W, even(display.width * s));
  const scaleH = Math.min(H, even(display.height * s));
  return { mode: 'fit', scaleW, scaleH, x: evenFloor((W - scaleW) / 2), y: evenFloor((H - scaleH) / 2), crop: null };
}

// ------------------------------------------------------------- filters

function hdrFilters(kind) {
  if (kind === 'pq') {
    return [
      'zscale=tin=smpte2084:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ];
  }
  if (kind === 'hlg') {
    return [
      'zscale=tin=arib-std-b67:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
      'format=yuv420p',
    ];
  }
  return [];
}

/** The -vf chain for a real video stream. duration (s) is used to give very
 * short clips at least a second on screen. */
export function videoFilter(stream, mode = 'fit', duration = null) {
  const display = displaySize(stream);
  const box = layout(display, mode);
  const f = [];
  if (INTERLACED_ORDERS.has(String(stream?.field_order || '').toLowerCase())) {
    f.push('yadif=mode=send_frame:parity=auto:deint=all');
  }
  // A clip shorter than a second (even a single frame) holds its last frame
  // to one second, so it doesn't flash past on the player.
  if (duration != null && duration > 0 && duration < 1) {
    f.push(`tpad=stop_mode=clone:stop_duration=${(1 - duration + 0.05).toFixed(3)}`);
  }
  // Drop to 14 fps before scaling so we scale fewer frames. start_time=0 pads
  // with the first frame when video starts after audio, keeping the two in
  // sync; eof_action=pass keeps the last frame instead of dropping it.
  f.push(`fps=fps=${TARGET.fps}:start_time=0:eof_action=pass`);
  f.push(`scale=${box.scaleW}:${box.scaleH}:flags=lanczos`);
  f.push('setsar=1');
  f.push(...hdrFilters(hdrKind(stream)));
  if (box.crop) f.push(`crop=${box.crop.w}:${box.crop.h}:${box.crop.x}:${box.crop.y}`);
  if (box.scaleW !== TARGET.width || box.scaleH !== TARGET.height) {
    if (!box.crop) f.push(`pad=${TARGET.width}:${TARGET.height}:${box.x}:${box.y}:color=black`);
  }
  // AMV only accepts full-range 4:2:0; the scaler converts tv range for us.
  f.push('format=yuvj420p');
  return { filter: f.join(','), layout: box, display };
}

/** The -af chain: mono, 22050 Hz, starting at 0 with gaps filled by silence. */
export function audioFilter(stream) {
  const f = [];
  const ch = num(stream?.channels);
  // FFmpeg's stereo-to-mono matrix can exceed full scale on correlated stereo;
  // an explicit half-and-half mix never clips.
  if (ch === 2) f.push('pan=mono|c0=0.5*c0+0.5*c1');
  f.push(`aresample=${TARGET.sampleRate}:async=1:first_pts=0`);
  f.push('aformat=sample_fmts=s16:channel_layouts=mono');
  return f.join(',');
}

// ---------------------------------------------------------------- plan

/**
 * Turn a probe into an ffmpeg plan.
 * opts: {mode:'fit'|'fill'|'stretch', threads: n (MT core only), hasCard: bool}
 * Returns {kind, args, duration, notes, ...} where kind is 'video' or
 * 'audio-only'; or {kind:'not-media'|'undecodable', reason}.
 */
export function buildPlan(probe, opts = {}) {
  const mode = FIT_MODES.includes(opts.mode) ? opts.mode : 'fit';
  const picked = pickStreams(probe);
  const duration = mediaDuration(probe, picked);
  const notes = [];

  if (!picked.video && !picked.audio) {
    return { kind: 'not-media', reason: picked.cover ? 'image-only' : 'no-streams', picked, duration };
  }
  if (picked.video && UNDECODABLE_VIDEO_CODECS.has(String(picked.video.codec_name).toLowerCase())) {
    return { kind: 'undecodable', reason: `video-codec:${picked.video.codec_name}`, picked, duration };
  }

  const pre = ['-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5'];
  const robust = ['-fflags', '+genpts+discardcorrupt', '-analyzeduration', '20000000', '-probesize', '50000000'];
  const decodeThreads = threadArgs(opts.threads);
  const args = [...pre];

  let vf;
  let af = null;
  let kind;
  let maps;
  let shortest = false;
  let layoutInfo = null;
  let display = null;

  if (picked.video) {
    kind = 'video';
    const v = videoFilter(picked.video, mode, duration);
    vf = v.filter;
    layoutInfo = v.layout;
    display = v.display;
    args.push(...robust, ...decodeThreads, '-i', INPUT_PATH);
    maps = ['-map', `0:${picked.video.index}`];
    if (picked.audio) {
      maps.push('-map', `0:${picked.audio.index}`);
      af = audioFilter(picked.audio);
    } else {
      // AMV needs exactly one video and one audio stream: add silence.
      args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${TARGET.sampleRate}`);
      maps.push('-map', '1:a:0');
      af = 'aformat=sample_fmts=s16:channel_layouts=mono';
      shortest = true;
      notes.push('silent-audio-added');
    }
    if (v.display && v.display.rotation) notes.push(`rotated-${v.display.rotation}`);
    if (hdrKind(picked.video) !== 'none') notes.push(`hdr-${hdrKind(picked.video)}`);
    if (INTERLACED_ORDERS.has(String(picked.video.field_order || '').toLowerCase())) notes.push('deinterlaced');
  } else {
    // Audio only: a still title card becomes the picture.
    kind = 'audio-only';
    args.push(...robust, '-i', INPUT_PATH);
    args.push('-loop', '1', '-framerate', String(TARGET.fps), '-i', CARD_PATH);
    maps = ['-map', '1:v:0', '-map', `0:${picked.audio.index}`];
    vf = `fps=fps=${TARGET.fps}:start_time=0,scale=${TARGET.width}:${TARGET.height}:flags=lanczos,setsar=1,format=yuvj420p`;
    af = audioFilter(picked.audio);
    shortest = true;
  }

  args.push(...maps);
  args.push('-vf', vf);
  args.push('-af', af);
  args.push('-c:v', 'amv', '-threads', '1');
  args.push('-c:a', 'adpcm_ima_amv', '-ac', '1', '-ar', String(TARGET.sampleRate), '-block_size', String(TARGET.blockSize));
  if (shortest) args.push('-shortest');
  args.push('-max_muxing_queue_size', '4096', '-map_metadata', '-1', '-map_chapters', '-1');
  if (opts.filterThreads) args.push('-filter_threads', String(opts.filterThreads));
  args.push('-f', 'amv', OUTPUT_PATH);

  return {
    kind,
    args,
    duration,
    picked,
    layout: layoutInfo,
    display,
    mode,
    notes,
    estimatedBytes: duration ? Math.round(duration * TARGET.bytesPerSecondEstimate) : null,
    needsCard: kind === 'audio-only',
  };
}

/**
 * Plan for frames the browser decoded (see browser-decode.js): an MJPEG
 * stream at 14 fps, already at 320x240, plus the sound from the original file.
 */
export function framesPlan(probe, opts = {}) {
  const picked = pickStreams(probe);
  const duration = mediaDuration(probe, picked);
  const args = ['-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1', '-stats_period', '0.5'];
  args.push('-f', 'mjpeg', '-framerate', String(TARGET.fps), ...threadArgs(opts.threads), '-i', FRAMES_PATH);
  let maps;
  let af;
  let shortest = false;
  if (picked.audio) {
    args.push('-fflags', '+genpts+discardcorrupt', ...threadArgs(opts.threads), '-i', INPUT_PATH);
    maps = ['-map', '0:v:0', '-map', `1:${picked.audio.index}`];
    af = audioFilter(picked.audio);
  } else {
    args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=mono:sample_rate=${TARGET.sampleRate}`);
    maps = ['-map', '0:v:0', '-map', '1:a:0'];
    af = 'aformat=sample_fmts=s16:channel_layouts=mono';
    shortest = true;
  }
  args.push(...maps);
  args.push('-vf', `fps=fps=${TARGET.fps}:start_time=0:eof_action=pass,scale=${TARGET.width}:${TARGET.height}:flags=lanczos,setsar=1,format=yuvj420p`);
  args.push('-af', af);
  args.push('-c:v', 'amv', '-threads', '1');
  args.push('-c:a', 'adpcm_ima_amv', '-ac', '1', '-ar', String(TARGET.sampleRate), '-block_size', String(TARGET.blockSize));
  if (shortest) args.push('-shortest');
  args.push('-max_muxing_queue_size', '4096', '-map_metadata', '-1', '-map_chapters', '-1');
  if (opts.filterThreads) args.push('-filter_threads', String(opts.filterThreads));
  args.push('-f', 'amv', OUTPUT_PATH);
  return { kind: 'video', args, duration, picked, mode: opts.mode || 'fit', notes: ['browser-decoded'], layout: null, display: null, needsCard: false };
}

/** ffprobe arguments that write JSON to a file we can read back. */
export function probeArgs(outPath = '/out/probe.json') {
  return [
    '-v', 'error',
    '-analyzeduration', '20000000',
    '-probesize', '50000000',
    '-print_format', 'json',
    '-show_format', '-show_streams',
    INPUT_PATH,
    '-o', outPath,
  ];
}

/** Thread flags for the multi-threaded build (empty for single-threaded).
 * Its worker pool holds 32 threads; ffmpeg's automatic count can exceed that
 * and deadlock, so every command states its count. */
export function threadArgs(threads) {
  return threads > 1 ? ['-threads', String(Math.min(8, Math.floor(threads)))] : [];
}

/** Arguments that copy an attached picture out as an image file. */
export function coverArgs(streamIndex, outPath = '/out/cover', { threads = 1 } = {}) {
  return [
    '-hide_banner', '-nostdin', '-y',
    ...(threads > 1 ? ['-filter_threads', '1'] : []),
    ...threadArgs(threads), '-i', INPUT_PATH,
    '-map', `0:${streamIndex}`, '-frames:v', '1', '-c', 'copy', '-f', 'image2', outPath,
  ];
}

/** Arguments that grab one frame at time t (seconds), scaled to fit 320x240, as PNG. */
export function thumbnailArgs(stream, t, outPath = '/out/thumb.png', { threads = 1 } = {}) {
  const display = displaySize(stream);
  const box = layout(display, 'fit');
  const hdr = hdrKind(stream) !== 'none' ? ',' + hdrFilters(hdrKind(stream)).join(',') : '';
  return [
    '-hide_banner', '-nostdin', '-y',
    ...(threads > 1 ? ['-filter_threads', '1'] : []),
    '-ss', String(Math.max(0, t)),
    ...threadArgs(threads), '-i', INPUT_PATH,
    '-map', `0:${stream.index}`, '-frames:v', '1',
    '-vf', `scale=${box.scaleW * 2}:${box.scaleH * 2}:flags=lanczos,setsar=1${hdr},format=rgb24`,
    '-threads', '1',
    '-f', 'image2', '-c:v', 'png', outPath,
  ];
}

// --------------------------------------------------------- progress / ETA

/** Parse ffmpeg -progress lines; returns seconds of output written, or null. */
export function progressSeconds(line) {
  const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
  if (m) return Number(m[1]) / 1e6; // both keys are microseconds in FFmpeg 5.x
  const t = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (t) return Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  return null;
}

/**
 * Smoothed ETA. Feed (elapsedSeconds, fractionDone); returns seconds left or
 * null while there's not enough signal to say anything honest.
 */
export function createEta() {
  let last = null;
  let rate = null; // fraction per second
  return function update(elapsed, fraction) {
    if (!(fraction > 0) || !(elapsed > 0)) return null;
    if (fraction >= 1) return 0;
    const instant = fraction / elapsed;
    rate = rate == null ? instant : rate * 0.8 + instant * 0.2;
    if (elapsed < 2.5 || fraction < 0.02) return null;
    const left = (1 - fraction) / rate;
    last = last == null ? left : last * 0.7 + left * 0.3;
    return Math.max(0, last);
  };
}

// ----------------------------------------------------------- file names

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const MONTHS = {
  es: ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/**
 * Phone and WhatsApp names all look alike and get cut off on the player's
 * narrow list; turn the common ones into a short date. Others pass through.
 *   "WhatsApp Video 2026-09-28 at 18.22.31" -> "WhatsApp 28 sep 2026 18.22"
 *   "VID-20261001-WA0007"                   -> "WhatsApp 1 oct 2026 (7)"
 *   "VID_20260915_183214", "PXL_20260915_183214123" -> "Video 15 sep 2026 18.32"
 */
export function friendlyBase(base, lang = 'es') {
  const months = MONTHS[lang] || MONTHS.es;
  const date = (y, mo, d) => {
    const m = Number(mo);
    if (!(m >= 1 && m <= 12) || !(Number(d) >= 1 && Number(d) <= 31)) return null;
    return `${Number(d)} ${months[m - 1]} ${y}`;
  };
  let m = /^WhatsApp (?:Video|Vídeo|Audio) (\d{4})-(\d{2})-(\d{2}) (?:at|a las) (\d{1,2})\.(\d{2})\.\d{2}(?: ?([AP]M))?(?: \((\d+)\))?$/i.exec(base);
  if (m) {
    const dt = date(m[1], m[2], m[3]);
    if (dt) {
      let hh = Number(m[4]);
      if (m[6]) hh = (hh % 12) + (/p/i.test(m[6]) ? 12 : 0);
      return `WhatsApp ${dt} ${hh}.${m[5]}${m[7] ? ` (${m[7]})` : ''}`;
    }
  }
  m = /^VID-(\d{4})(\d{2})(\d{2})-WA(\d{4})$/i.exec(base);
  if (m) {
    const dt = date(m[1], m[2], m[3]);
    if (dt) return `WhatsApp ${dt} (${Number(m[4])})`;
  }
  m = /^(?:VID|PXL|video)[-_]?(\d{4})(\d{2})(\d{2})[-_]?(\d{2})(\d{2})\d{2,}(?:[-_~][\w-]*)?$/i.exec(base);
  if (m) {
    const dt = date(m[1], m[2], m[3]);
    if (dt) return `Video ${dt} ${m[4]}.${m[5]}`;
  }
  return base;
}

/**
 * A name that is safe on the player's FAT32 card and readable on its screen.
 * Keeps Spanish letters, drops emoji, symbols and characters FAT32 forbids.
 */
export function outputName(originalName, maxBase = 60, lang = 'es') {
  let base = String(originalName ?? '').normalize('NFC');
  base = base.replace(/^.*[\\/]/, ''); // just the file name
  base = base.replace(/\.[A-Za-z0-9]{1,5}$/, ''); // drop one extension
  base = friendlyBase(base.trim(), lang);
  base = base
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\p{Extended_Pictographic}|[‍️⃣]/gu, ' ')
    .replace(/[^\p{L}\p{M}\p{N} ._,()\[\]'&!#+=~@-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (base.length > maxBase) {
    const cut = base.slice(0, maxBase);
    const space = cut.lastIndexOf(' ');
    base = (space > maxBase * 0.6 ? cut.slice(0, space) : cut).replace(/[.\s]+$/g, '');
  }
  if (!base) base = 'video';
  if (WINDOWS_RESERVED.test(base)) base = `${base} video`;
  return `${base}.amv`;
}

/** Make names unique within a batch: "a.amv", "a (2).amv", "a (3).amv". */
export function uniqueName(name, taken) {
  const lower = (s) => s.toLocaleLowerCase('es');
  if (!taken.has(lower(name))) {
    taken.add(lower(name));
    return name;
  }
  const base = name.replace(/\.amv$/i, '');
  for (let i = 2; ; i++) {
    const candidate = `${base} (${i}).amv`;
    if (!taken.has(lower(candidate))) {
      taken.add(lower(candidate));
      return candidate;
    }
  }
}

// --------------------------------------------------------- file sniffing

/**
 * Recognize what a file is from its first bytes, before ffmpeg sees it.
 * Returns a coarse kind: 'amv', 'video', 'audio', 'image', 'document',
 * 'archive', 'empty', 'text', or 'unknown' (let ffmpeg decide).
 */
export function sniff(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length === 0) return 'empty';
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const startsWith = (...sig) => sig.every((v, i) => b[i] === v);
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'AMV ') return 'amv';
  if (ascii(0, 4) === 'RIFF') {
    const form = ascii(8, 4);
    if (form === 'AVI ' || form === 'AVIX') return 'video';
    if (form === 'WAVE') return 'audio';
    if (form === 'WEBP') return 'image';
  }
  if (ascii(4, 4) === 'ftyp') {
    const brand = ascii(8, 4);
    if (/^(heic|heix|hevc|mif1|msf1|avif)$/.test(brand)) return 'image';
    if (/^(M4A |M4B |M4P )$/.test(brand)) return 'audio';
    return 'video';
  }
  if (startsWith(0xff, 0xd8, 0xff)) return 'image';
  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return 'image';
  if (ascii(0, 4) === 'GIF8') return 'video'; // animated GIFs convert fine
  if (startsWith(0x42, 0x4d) && b.length > 26 && /\.bmp$/i.test(name)) return 'image';
  if (ascii(0, 4) === '%PDF') return 'document';
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) {
    return /\.(docx|xlsx|pptx|odt|ods|odp|pages|numbers|key)$/i.test(name) ? 'document' : 'archive';
  }
  if (startsWith(0x52, 0x61, 0x72, 0x21) || startsWith(0x37, 0x7a, 0xbc, 0xaf) || startsWith(0x1f, 0x8b)) return 'archive';
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0)) {
    // OLE: old Office documents, but also ASF? No, ASF has its own GUID.
    return 'document';
  }
  if (startsWith(0x30, 0x26, 0xb2, 0x75)) return 'video'; // ASF / WMV / WMA
  if (startsWith(0x1a, 0x45, 0xdf, 0xa3)) return 'video'; // Matroska / WebM
  if (ascii(0, 4) === 'OggS') return 'video'; // ogg may be audio; ffmpeg decides
  if (ascii(0, 4) === 'fLaC' || ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return 'audio';
  if (startsWith(0x00, 0x00, 0x01, 0xba) || startsWith(0x00, 0x00, 0x01, 0xb3)) return 'video'; // MPEG PS / ES
  if (b[0] === 0x47 && (b.length < 189 || b[188] === 0x47)) return 'video'; // MPEG-TS
  if (ascii(0, 3) === 'FLV') return 'video';
  // Valid UTF-8 with no NULs and no stray control bytes: a text file.
  const head = b.subarray(0, Math.min(b.length, 1024));
  let end = head.length;
  // Don't cut a multi-byte character in half at the window edge.
  if (b.length > head.length) {
    let k = end - 1;
    while (k > 0 && (head[k] & 0xc0) === 0x80) k--;
    end = k;
  }
  let text = null;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, end));
  } catch (_) {
    text = null;
  }
  if (text != null && text.length) {
    let bad = 0;
    for (const ch of text) {
      const c = ch.codePointAt(0);
      if (c === 0 || (c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0x7f) bad++;
    }
    if (bad === 0) {
      if (/^\s*</.test(text)) return 'document';
      return 'text';
    }
  }
  return 'unknown';
}

/** Human-friendly duration in Spanish or English: "3 min 05 s", "1 h 02 min". */
export function formatDuration(seconds, lang = 'es') {
  if (!(seconds >= 0) || !Number.isFinite(seconds)) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return lang === 'es' ? `${sec} s` : `${sec} s`;
}

/** "1,5 MB" (es) or "1.5 MB" (en). */
export function formatBytes(bytes, lang = 'es') {
  if (!(bytes >= 0)) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  const text = v.toLocaleString(lang === 'es' ? 'es-MX' : 'en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return `${text} ${units[i]}`;
}
