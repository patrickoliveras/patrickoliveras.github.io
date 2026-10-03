/**
 * amv.js: parse, validate and decode AMV ("Actions Media Video") files, the
 * RIFF variant that cheap MP3/MP4 players play. Dependency-free ES module for
 * browsers and Node. Nothing here touches the DOM; the module is safe to
 * import in a worker or in Node.
 *
 * Layout written by FFmpeg's AMV muxer (libavformat/amvenc.c), which made the
 * reference files that play on the target device:
 *
 *   0    RIFF <0> 'AMV '                        RIFF and LIST sizes are 0 on purpose
 *   12   LIST <0> hdrl
 *   24     amvh <56>  u32 us_per_frame, 28 zero bytes, u32 width, u32 height,
 *                     u32 ts_den, u32 ts_num, u32 0, duration: u8 s, u8 m, u16 h
 *   88     LIST <0> strl  strh <56> zeros  strf <36> zeros           (video)
 *   208    LIST <0> strl  strh <48> zeros  strf <20> WAVEFORMATEX    (audio)
 *   304  LIST <0> movi
 *   316    00dc <n> frame, 01wb <n> audio block, 00dc, 01wb, ...   no even-padding
 *        one 0x00 if the position is odd, then 'AMV_END_'
 *
 * Video: each frame is FFD8 + a baseline JPEG scan + FFD9, with no tables in
 * the stream (frameToJpeg adds the fixed ones). Frames are stored upside down.
 * Audio: each block is int16 predictor, u8 step index, u8 0, u32 sample count,
 * then 4-bit IMA ADPCM, high nibble first; every block decodes on its own.
 */

// ---------------------------------------------------------------------------
// Constants: the 14 fps profile of ref/01, the file known to play on the device.

export const width = 320;
export const height = 240;
export const fps = 14;
export const usPerFrame = 71429;
export const audioSampleRate = 22050;
export const samplesPerFrame = 1575;
export const audioBlockSize = 796;
/** Stored frames are upside down: the encoder flips them, FFmpeg's decoder flips back. */
export const FRAMES_ARE_FLIPPED = true;

/** Default cap on a chunk's declared size; anything larger is treated as corrupt. */
const MAX_CHUNK_SIZE = 2 * 1024 * 1024;
/** The header (everything before the first chunk) must fit in this many bytes. */
const HEADER_LIMIT = 64 * 1024;
/** Zero bytes accepted between the last chunk and 'AMV_END_' before they count as junk. */
const MAX_PAD = 8;
/** At most this many issues are listed per code; the rest are counted. */
const ISSUE_CAP = 20;

/**
 * Expected values for an AMV that FFmpeg writes at `frameRate` fps (an
 * integer). Mirrors amv_init(): us_per_frame = round(1e6 / fps), samples per
 * block = round(22050 * us_per_frame / 1e6), block = 8 + ceil(samples / 2).
 * amvProfile(14) gives 71429 us, 1575 samples, 796-byte blocks;
 * amvProfile(25) gives 40000 us, 882 samples, 449-byte blocks.
 */
export function amvProfile(frameRate = fps) {
  const us = Math.round(1e6 / frameRate);
  const samples = Math.round((audioSampleRate * us) / 1e6);
  return Object.freeze({
    fps: frameRate,
    usPerFrame: us,
    tsDen: frameRate,
    tsNum: 1,
    width,
    height,
    audioSampleRate,
    samplesPerFrame: samples,
    audioBlockSize: 8 + Math.ceil(samples / 2),
  });
}

// ---------------------------------------------------------------------------
// Byte helpers

const fourcc = (s) =>
  (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;
const T_RIFF = fourcc('RIFF');
const T_FORM = fourcc('AMV ');
const T_LIST = fourcc('LIST');
const T_VIDEO = fourcc('00dc');
const T_AUDIO = fourcc('01wb');
const T_AMV_ = fourcc('AMV_');
const T_END_ = fourcc('END_');

const u16 = (b, i) => b[i] | (b[i + 1] << 8);
const u32 = (b, i) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const str4 = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const quoted = (s) => JSON.stringify(s.replace(/[^\x20-\x7e]/g, '?'));

/** A plain Uint8Array view of x (a Node Buffer becomes a plain view, so slice() copies), or null. */
function toBytes(x) {
  if (x instanceof Uint8Array && x.constructor === Uint8Array) return x;
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  const kind = Object.prototype.toString.call(x);
  if (kind === '[object ArrayBuffer]' || kind === '[object SharedArrayBuffer]') return new Uint8Array(x);
  return null;
}

function allZero(b, start, n) {
  for (let i = start, end = start + n; i < end; i++) if (b[i] !== 0) return false;
  return true;
}

/** True when the n bytes at b[i] equal the first n characters of s. */
function startsLike(b, i, n, s) {
  if (n < 1 || n > s.length) return false;
  for (let k = 0; k < n; k++) if (b[i + k] !== s.charCodeAt(k)) return false;
  return true;
}

function isFourccText(b, i) {
  for (let k = 0; k < 4; k++) if (b[i + k] < 0x20 || b[i + k] > 0x7e) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Issue lists

function newIssues() {
  return { errors: [], warnings: [], counts: Object.create(null) };
}

function report(issues, kind, code, message, extra) {
  const n = (issues.counts[code] = (issues.counts[code] || 0) + 1);
  if (n > ISSUE_CAP) return null;
  const entry = { code, message, ...extra };
  issues[kind].push(entry);
  return entry;
}

function closeIssues(issues) {
  for (const code of Object.keys(issues.counts)) {
    const extra = issues.counts[code] - ISSUE_CAP;
    if (extra <= 0) continue;
    const kind = issues.errors.some((e) => e.code === code) ? 'errors' : 'warnings';
    issues[kind].push({ code, message: `${extra} more '${code}' issues not listed.`, omitted: extra });
  }
}

// ---------------------------------------------------------------------------
// Header

/** isAmv(bytes): true when the first 12 bytes are 'RIFF' <size> 'AMV '. */
export function isAmv(bytes) {
  const b = toBytes(bytes);
  return !!b && b.length >= 12 && u32(b, 0) === T_RIFF && u32(b, 8) === T_FORM;
}

/**
 * Reads everything before the first chunk. `b` holds the first bytes of a file
 * of `fileSize` bytes (all of it, or at least HEADER_LIMIT of it).
 * Returns { header, moviOffset } where moviOffset is the file offset of the
 * first chunk header, or -1.
 */
function parseHeader(b, fileSize, issues) {
  const out = { header: null, moviOffset: -1 };
  const len = b.length;
  const err = (code, message, offset) => report(issues, 'errors', code, message, { offset });

  if (fileSize === 0) {
    err('empty', 'The file is empty (0 bytes).', 0);
    return out;
  }
  if (len < 4 || u32(b, 0) !== T_RIFF) {
    if (len < 4 && startsLike(b, 0, len, 'RIFF')) err('truncated-header', `The file ends after ${len} bytes, inside the RIFF header.`, len);
    else err('not-riff', 'Not an AMV file: it does not start with "RIFF".', 0);
    return out;
  }
  if (len < 12) {
    err('truncated-header', `The file ends after ${len} bytes, inside the RIFF header.`, len);
    return out;
  }

  const h = {
    complete: false,
    riffSize: u32(b, 4),
    formType: str4(b, 8),
    layout: [],
    videoStream: null,
    audioStream: null,
  };
  out.header = h;
  if (u32(b, 8) !== T_FORM) {
    err('wrong-form-type', `RIFF form type is ${quoted(h.formType)}, not "AMV ".`, 8);
    return out;
  }

  const scanEnd = Math.min(len, HEADER_LIMIT);
  const stop = (pos) => {
    if (scanEnd === len && len === fileSize) {
      err('truncated-header', `The file ends at byte ${len}, inside the header (no movi list yet).`, len);
    } else {
      err('movi-not-found', `No "LIST movi" in the first ${HEADER_LIMIT} bytes.`, pos);
    }
    return out;
  };

  let pos = 12;
  let strl = -1;
  for (;;) {
    if (pos + 8 > scanEnd) return stop(pos);
    const t = u32(b, pos);
    const size = u32(b, pos + 4);
    if (t === T_LIST) {
      if (pos + 12 > scanEnd) return stop(pos);
      const type = str4(b, pos + 8);
      h.layout.push({ id: 'LIST ' + type, offset: pos, size });
      if (type === 'movi') {
        h.moviListSize = size;
        h.complete = true;
        h.raw = b.slice(0, pos + 12);
        out.moviOffset = pos + 12;
        return out;
      }
      if (type === 'strl') strl++;
      else if (type !== 'hdrl') {
        report(issues, 'warnings', 'unknown-header-chunk', `Unexpected "LIST ${type}" at ${pos} in the header.`, { offset: pos });
        if (size >= 4 && pos + 8 + size <= scanEnd) {
          pos += 8 + size + (size & 1);
          continue;
        }
      }
      pos += 12;
      continue;
    }
    if (t === T_VIDEO || t === T_AUDIO) {
      err('movi-not-found', `Stream chunk ${str4(b, pos)} at ${pos} comes before any "LIST movi".`, pos);
      return out;
    }
    if (!isFourccText(b, pos)) {
      err('bad-header', `Unreadable data at byte ${pos} of the header.`, pos);
      return out;
    }
    const name = str4(b, pos);
    const body = pos + 8;
    if (body + size > scanEnd) {
      if (scanEnd === len && len === fileSize && size <= HEADER_LIMIT) return stop(pos);
      if (body + size <= fileSize && size <= HEADER_LIMIT) return stop(pos);
      err('bad-header', `Header chunk ${quoted(name)} at ${pos} declares ${size} bytes, past the end of the header.`, pos);
      return out;
    }
    h.layout.push({ id: name, offset: pos, size });
    if (name === 'amvh') {
      if (size >= 56) readAmvh(h, b, body);
    } else if ((name === 'strh' || name === 'strf') && (strl === 0 || strl === 1)) {
      const key = strl === 0 ? 'videoStream' : 'audioStream';
      const stream = h[key] || (h[key] = {});
      stream[name] = { offset: body, size, zero: allZero(b, body, size) };
      if (name === 'strf' && strl === 1 && size >= 16) {
        stream.format = {
          formatTag: u16(b, body),
          channels: u16(b, body + 2),
          sampleRate: u32(b, body + 4),
          byteRate: u32(b, body + 8),
          blockAlign: u16(b, body + 12),
          bitsPerSample: u16(b, body + 14),
          cbSize: size >= 18 ? u16(b, body + 16) : undefined,
          extra: size >= 20 ? u16(b, body + 18) : undefined,
        };
      }
    } else {
      report(issues, 'warnings', 'unknown-header-chunk', `Unexpected ${quoted(name)} chunk at ${pos} in the header.`, { offset: pos });
    }
    pos = body + size + (size & 1);
  }
}

function readAmvh(h, b, p) {
  h.usPerFrame = u32(b, p);
  h.amvhReservedZero = allZero(b, p + 4, 28);
  h.width = u32(b, p + 32);
  h.height = u32(b, p + 36);
  h.tsDen = u32(b, p + 40);
  h.tsNum = u32(b, p + 44);
  h.fps = h.tsNum ? h.tsDen / h.tsNum : 0;
  h.start = u32(b, p + 48);
  const seconds = b[p + 52];
  const minutes = b[p + 53];
  const hours = u16(b, p + 54);
  h.duration = { hours, minutes, seconds, totalSeconds: hours * 3600 + minutes * 60 + seconds };
  h.durationOffset = p + 52;
}

// ---------------------------------------------------------------------------
// Chunk walker, shared by parseAmv (whole file in memory) and iterateChunks
// (a Blob read in windows). It stops with `need` set when the window runs out
// before EOF; the caller then reads a window of at least `need` bytes at `pos`.
// Given the same file, both callers see the same chunks and the same issues.

function newWalk(moviOffset, fileSize, maxChunkSize, issues) {
  return {
    pos: moviOffset,
    fileSize,
    maxChunkSize,
    issues,
    need: 0,
    done: false,
    video: [],
    audio: [],
    videoCount: 0,
    audioCount: 0,
    badFrames: [],
    badAudioBlocks: [],
    chunksEnd: moviOffset,
    junkStart: -1,
    junkAfterBogus: false,
    junkIssue: null,
    trailer: { found: false, offset: -1, padBytes: 0, trailingBytes: 0, chunksEnd: moviOffset },
  };
}

function startJunk(st, pos) {
  if (st.junkStart >= 0) return;
  st.junkStart = pos;
  st.junkAfterBogus = false;
  st.junkIssue = null;
}

function endJunk(st, pos) {
  if (st.junkStart < 0) return;
  const n = pos - st.junkStart;
  if (st.junkAfterBogus) {
    if (st.junkIssue && n > 0) {
      st.junkIssue.skipped = n;
      st.junkIssue.message += ` Skipped ${n} bytes to the next readable chunk.`;
    }
  } else if (n > 0) {
    report(st.issues, 'errors', 'unexpected-data', `${n} bytes at offset ${st.junkStart} are not a chunk.`, {
      offset: st.junkStart,
      length: n,
    });
  }
  st.junkStart = -1;
  st.junkAfterBogus = false;
  st.junkIssue = null;
}

function foundTrailer(st, offset, pad) {
  endJunk(st, offset - pad);
  const trailingBytes = st.fileSize - offset - 8;
  st.trailer = { found: true, offset, padBytes: pad, trailingBytes, chunksEnd: st.chunksEnd };
  if (trailingBytes > 0) {
    report(st.issues, 'warnings', 'trailing-data', `${trailingBytes} bytes follow 'AMV_END_'.`, { offset: offset + 8 });
  }
  st.done = true;
}

/** Is there a chunk or trailer that could be read somewhere in [from, EOF)? Final window only. */
function canResync(st, b, base, from) {
  for (let p = from; p + 8 <= st.fileSize; p++) {
    const r = p - base;
    const t = u32(b, r);
    if (t === T_VIDEO || t === T_AUDIO) {
      const s = u32(b, r + 4);
      if (s <= st.maxChunkSize && p + 8 + s <= st.fileSize) return true;
    } else if (t === T_AMV_ && u32(b, r + 4) === T_END_) return true;
  }
  return false;
}

/** Fewer than 8 bytes (after any zero run) remain before EOF at `pos`. */
function finishTail(st, b, r, avail, pos) {
  const err = (code, message, extra) => report(st.issues, 'errors', code, message, extra);
  if (st.junkStart >= 0) {
    endJunk(st, pos + avail);
    err('missing-trailer', `No 'AMV_END_' trailer before the end of the file.`, { offset: pos + avail });
  } else {
    let z = 0;
    while (z < avail && b[r + z] === 0) z++;
    const rest = avail - z;
    const head = Math.min(avail, 4);
    if (z === 0 && (startsLike(b, r, head, '00dc') || startsLike(b, r, head, '01wb'))) {
      err('truncated-chunk', `The file ends at byte ${pos + avail}, inside a chunk header.`, { offset: pos });
    } else if (rest > 0 && startsLike(b, r + z, rest, 'AMV_END_')) {
      err('truncated-trailer', `The file ends at byte ${pos + avail}, inside the 'AMV_END_' trailer.`, { offset: pos + z });
    } else if (rest === 0) {
      err('missing-trailer', `No 'AMV_END_' trailer after the last chunk.`, { offset: pos });
    } else {
      err('unexpected-data', `${avail} bytes at offset ${pos} are not a chunk.`, { offset: pos, length: avail });
      err('missing-trailer', `No 'AMV_END_' trailer before the end of the file.`, { offset: pos + avail });
    }
  }
  st.done = true;
}

function walk(st, b, base, onChunk) {
  const end = base + b.length;
  const final = end >= st.fileSize;
  const fileSize = st.fileSize;
  const max = st.maxChunkSize;
  let pos = st.pos;
  st.need = 0;

  while (!st.done) {
    const r = pos - base;
    const avail = end - pos;

    if (avail >= 8) {
      const t = u32(b, r);
      if (t === T_VIDEO || t === T_AUDIO) {
        const size = u32(b, r + 4);
        const next = pos + 8 + size;
        if (size <= max && next <= fileSize) {
          if (next > end) {
            st.need = next - pos;
            break;
          }
          endJunk(st, pos);
          const ro = r + 8;
          if (t === T_VIDEO) {
            const i = st.videoCount++;
            if (size < 4 || b[ro] !== 0xff || b[ro + 1] !== 0xd8 || b[ro + size - 2] !== 0xff || b[ro + size - 1] !== 0xd9) {
              st.badFrames.push(i);
            }
            if (onChunk) onChunk('video', i, b, ro, size);
            else st.video.push({ offset: pos + 8, size });
          } else {
            const i = st.audioCount++;
            const nsamples = size >= 8 ? u32(b, ro + 4) : -1;
            if (size < 8 || b[ro + 2] > 88 || b[ro + 3] !== 0 || nsamples === 0 || nsamples > (size - 8) * 2) {
              st.badAudioBlocks.push(i);
            }
            if (onChunk) onChunk('audio', i, b, ro, size);
            else st.audio.push({ offset: pos + 8, size, nsamples });
          }
          pos = next;
          st.chunksEnd = pos;
          continue;
        }
        if (st.junkStart < 0) {
          // A chunk header whose size cannot be right, or a file cut short.
          if (size <= max && !final) {
            st.need = fileSize - pos; // read to EOF to tell the two apart
            break;
          }
          const tagName = t === T_VIDEO ? '00dc' : '01wb';
          if (size > max || canResync(st, b, base, pos + 8)) {
            const e = report(st.issues, 'errors', 'bogus-chunk-size', `Chunk ${tagName} at ${pos} declares ${size} bytes, which cannot be right.`, {
              offset: pos,
              size,
            });
            pos += 8;
            startJunk(st, pos);
            st.junkAfterBogus = true;
            st.junkIssue = e;
            continue;
          }
          report(st.issues, 'errors', 'truncated-chunk', `The file ends inside chunk ${tagName} at ${pos}: it declares ${size} bytes but ${fileSize - pos - 8} remain.`, {
            offset: pos,
            size,
          });
          st.done = true;
          break;
        }
        pos++; // inside junk, a chunk tag that leads nowhere is junk too
        continue;
      }
      if (t === T_AMV_ && u32(b, r + 4) === T_END_) {
        foundTrailer(st, pos, 0);
        break;
      }
    }

    if (avail === 0) {
      if (!final) {
        st.need = 8;
        break;
      }
      endJunk(st, pos);
      report(st.issues, 'errors', 'missing-trailer', `No 'AMV_END_' trailer after the last chunk.`, { offset: pos });
      st.done = true;
      break;
    }

    if (b[r] === 0) {
      let z = 1;
      while (z < avail && b[r + z] === 0) z++;
      if (z > MAX_PAD) {
        startJunk(st, pos);
        pos += z - MAX_PAD;
        continue;
      }
      if (avail - z >= 8) {
        const t2 = u32(b, r + z);
        if (t2 === T_AMV_ && u32(b, r + z + 4) === T_END_) {
          foundTrailer(st, pos + z, z);
          break;
        }
        if (z === 1 && (pos & 1) && pos === st.chunksEnd && st.junkStart < 0 && (t2 === T_VIDEO || t2 === T_AUDIO)) {
          report(st.issues, 'errors', 'chunk-padding', `Padding byte at ${pos} after an odd-sized chunk; AMV chunks are not padded to even sizes.`, {
            offset: pos,
          });
          pos += 1;
          continue;
        }
        startJunk(st, pos);
        pos += z;
        continue;
      }
      if (!final) {
        st.need = z + 8;
        break;
      }
      finishTail(st, b, r, avail, pos);
      break;
    }

    if (avail < 8) {
      if (!final) {
        st.need = 8;
        break;
      }
      finishTail(st, b, r, avail, pos);
      break;
    }

    startJunk(st, pos);
    pos++;
  }
  st.pos = pos;
}

// ---------------------------------------------------------------------------
// Public: parse and validate

/**
 * parseAmv(bytes[, {maxChunkSize}]) walks a whole AMV file held in memory.
 * It never throws. It returns:
 *   fileSize
 *   header      null if unreadable; otherwise riffSize, formType, usPerFrame,
 *               width, height, tsDen, tsNum, fps, start, duration {hours,
 *               minutes, seconds, totalSeconds}, videoStream/audioStream
 *               {strh, strf[, format]}, layout (the header chunks in order),
 *               moviListSize, complete, raw (the header bytes)
 *   moviOffset  file offset of the first chunk header, or -1
 *   video       [{offset, size}], offset = first byte of the frame payload
 *   audio       [{offset, size, nsamples}]
 *   badFrames, badAudioBlocks: indices of frames without FFD8...FFD9, and of audio
 *               blocks whose header FFmpeg would reject or that is nonstandard
 *   trailer     {found, offset, padBytes, trailingBytes, chunksEnd}
 *   errors, warnings: [{code, message, offset?, ...}]
 *
 * Error codes: not-bytes, empty, not-riff, wrong-form-type, truncated-header,
 * bad-header, movi-not-found, bogus-chunk-size, truncated-chunk,
 * unexpected-data, chunk-padding, missing-trailer, truncated-trailer,
 * internal-error. Warning codes: trailing-data, unknown-header-chunk.
 * After junk or a bogus size the walk resynchronises on the next readable
 * chunk, so later chunks are still listed. For a Blob/File too big to load,
 * parseAmvBlob() returns the same object.
 */
export function parseAmv(bytes, options = {}) {
  const issues = newIssues();
  const result = newResult(issues);
  try {
    const b = toBytes(bytes);
    if (!b) {
      report(issues, 'errors', 'not-bytes', 'Expected a Uint8Array, ArrayBuffer or other binary view.');
    } else {
      result.fileSize = b.length;
      const head = parseHeader(b, b.length, issues);
      result.header = head.header;
      result.moviOffset = head.moviOffset;
      if (head.moviOffset >= 0) {
        const st = newWalk(head.moviOffset, b.length, (options && options.maxChunkSize) || MAX_CHUNK_SIZE, issues);
        walk(st, b, 0, null);
        takeWalk(result, st);
      }
    }
  } catch (e) {
    report(issues, 'errors', 'internal-error', `Parser failure: ${(e && e.message) || e}`);
  }
  closeIssues(issues);
  return result;
}

function newResult(issues) {
  return {
    fileSize: 0,
    header: null,
    moviOffset: -1,
    video: [],
    audio: [],
    badFrames: [],
    badAudioBlocks: [],
    trailer: { found: false, offset: -1, padBytes: 0, trailingBytes: 0, chunksEnd: -1 },
    errors: issues.errors,
    warnings: issues.warnings,
  };
}

function takeWalk(result, st) {
  result.video = st.video;
  result.audio = st.audio;
  result.badFrames = st.badFrames;
  result.badAudioBlocks = st.badAudioBlocks;
  result.trailer = st.trailer;
}

const EXPECTED_LAYOUT = [
  ['LIST hdrl', 0],
  ['amvh', 56],
  ['LIST strl', 0],
  ['strh', 56],
  ['strf', 36],
  ['LIST strl', 0],
  ['strh', 48],
  ['strf', 20],
  ['LIST movi', 0],
];
const EXPECTED_AUDIO_FORMAT = { formatTag: 1, channels: 1, sampleRate: 22050, byteRate: 44100, blockAlign: 2, bitsPerSample: 16, cbSize: 0, extra: 0 };

/** The 316 header bytes FFmpeg writes for profile p, with the duration left at 0. */
function headerTemplate(p) {
  const b = new Uint8Array(316);
  const dv = new DataView(b.buffer);
  const put = (s, at) => {
    for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i);
  };
  put('RIFF', 0);
  put('AMV ', 8);
  put('LIST', 12);
  put('hdrl', 20);
  put('amvh', 24);
  dv.setUint32(28, 56, true);
  dv.setUint32(32, p.usPerFrame, true);
  dv.setUint32(64, p.width, true);
  dv.setUint32(68, p.height, true);
  dv.setUint32(72, p.tsDen, true);
  dv.setUint32(76, p.tsNum, true);
  put('LIST', 88);
  put('strl', 96);
  put('strh', 100);
  dv.setUint32(104, 56, true);
  put('strf', 164);
  dv.setUint32(168, 36, true);
  put('LIST', 208);
  put('strl', 216);
  put('strh', 220);
  dv.setUint32(224, 48, true);
  put('strf', 276);
  dv.setUint32(280, 20, true);
  const f = EXPECTED_AUDIO_FORMAT;
  dv.setUint16(284, f.formatTag, true);
  dv.setUint16(286, f.channels, true);
  dv.setUint32(288, f.sampleRate, true);
  dv.setUint32(292, f.byteRate, true);
  dv.setUint16(296, f.blockAlign, true);
  dv.setUint16(298, f.bitsPerSample, true);
  put('LIST', 304);
  put('movi', 312);
  return b;
}

function checkHeader(h, p, add) {
  const before = add.count();

  const nonZeroSizes = [h.riffSize ? `RIFF=${h.riffSize}` : '']
    .concat(h.layout.filter((c) => c.id.startsWith('LIST ') && c.size).map((c) => `${c.id}=${c.size}`))
    .filter(Boolean);
  if (nonZeroSizes.length) {
    add('riff-sizes', `RIFF/LIST sizes must be 0 as FFmpeg writes them (some players break otherwise); found ${nonZeroSizes.join(', ')}.`);
  }

  const got = h.layout.map((c) => `${c.id}(${c.id.startsWith('LIST ') ? '' : c.size})`).join(' ');
  const want = EXPECTED_LAYOUT.map(([id, size]) => `${id}(${id.startsWith('LIST ') ? '' : size})`).join(' ');
  if (got !== want) add('header-layout', `Header chunks are ${got}; expected ${want}.`);

  if (h.usPerFrame !== undefined) {
    if (h.usPerFrame !== p.usPerFrame) {
      add('us-per-frame', `amvh us_per_frame is ${h.usPerFrame}; expected ${p.usPerFrame} for ${p.fps} fps.`);
    }
    if (h.width !== p.width || h.height !== p.height) {
      add('dimensions', `Frame size is ${h.width}x${h.height}; expected ${p.width}x${p.height}.`);
    }
    if (h.tsDen !== p.tsDen || h.tsNum !== p.tsNum) {
      add('timebase', `amvh time base is ${h.tsDen}/${h.tsNum}; expected ${p.tsDen}/${p.tsNum}.`);
    }
    if (!h.amvhReservedZero || h.start !== 0) {
      add('amvh-reserved', 'amvh has non-zero bytes where FFmpeg writes zeros (bytes 4-31 or the u32 at 48).');
    }
  }

  const vs = h.videoStream;
  if (vs && ((vs.strh && !vs.strh.zero) || (vs.strf && !vs.strf.zero))) {
    add('video-stream-header', 'The video strh/strf must be all zeros.');
  }
  const as = h.audioStream;
  if (as && as.strh && !as.strh.zero) add('audio-stream-header', 'The audio strh must be all zeros.');
  if (as && as.format) {
    const diffs = Object.keys(EXPECTED_AUDIO_FORMAT)
      .filter((k) => as.format[k] !== EXPECTED_AUDIO_FORMAT[k])
      .map((k) => `${k}=${as.format[k]} (expected ${EXPECTED_AUDIO_FORMAT[k]})`);
    if (diffs.length) add('audio-format', `Audio strf differs: ${diffs.join(', ')}.`);
  }

  // Catch-all: byte-for-byte against what FFmpeg writes, duration excluded.
  if (add.count() === before && h.raw) {
    const want = headerTemplate(p);
    if (h.raw.length !== want.length) {
      add('header-bytes', `Header is ${h.raw.length} bytes; expected ${want.length}.`);
    } else {
      want.set(h.raw.subarray(84, 88), 84);
      const at = want.findIndex((v, i) => v !== h.raw[i]);
      if (at >= 0) add('header-bytes', `Header byte ${at} is 0x${h.raw[at].toString(16)}; expected 0x${want[at].toString(16)}.`, { offset: at });
    }
  }
}

function checkChunks(parsed, p, add) {
  const V = parsed.video;
  const A = parsed.audio;
  if (!V.length && !A.length) {
    add('no-chunks', 'The movi list has no chunks.');
    return;
  }
  if (!V.length) add('no-chunks', 'The movi list has no video chunks.');

  if (A.length && (!V.length || A[0].offset < V[0].offset)) {
    add('first-chunk-not-video', 'The first chunk is audio; players expect video first.', { offset: A[0].offset - 8 });
  }

  // Strict alternation: no two chunks of the same type in a row.
  let i = 0;
  let j = 0;
  let k = 0;
  let prevVideo = null;
  let repeats = 0;
  let first = null;
  while (i < V.length || j < A.length) {
    const isVideo = j >= A.length || (i < V.length && V[i].offset < A[j].offset);
    const c = isVideo ? V[i++] : A[j++];
    if (prevVideo === isVideo) {
      repeats++;
      if (!first) first = { index: k, offset: c.offset - 8, type: isVideo ? '00dc' : '01wb' };
    }
    prevVideo = isVideo;
    k++;
  }
  if (repeats) {
    add('interleave', `Chunks must alternate video/audio; ${repeats} repeat(s), first at chunk #${first.index} (${first.type} at ${first.offset}).`, {
      offset: first.offset,
      count: repeats,
    });
  }

  if (V.length !== A.length) add('count-mismatch', `${V.length} video chunks but ${A.length} audio chunks.`);

  let wrongSize = 0;
  let firstSize = -1;
  let wrongN = 0;
  let firstN = -1;
  for (let n = 0; n < A.length; n++) {
    if (A[n].size !== p.audioBlockSize && wrongSize++ === 0) firstSize = n;
    if (A[n].nsamples !== p.samplesPerFrame && wrongN++ === 0) firstN = n;
  }
  if (wrongSize) {
    const a = A[firstSize];
    add('audio-block-size', `${wrongSize} audio block(s) are not ${p.audioBlockSize} bytes; first is #${firstSize} at ${a.offset - 8} with ${a.size}.`, {
      offset: a.offset - 8,
      count: wrongSize,
    });
  }
  if (wrongN) {
    const a = A[firstN];
    add('audio-nsamples', `${wrongN} audio block(s) don't declare ${p.samplesPerFrame} samples; first is #${firstN} with ${a.nsamples}.`, {
      offset: a.offset - 8,
      count: wrongN,
    });
  }
  if (parsed.badAudioBlocks.length) {
    const n = parsed.badAudioBlocks[0];
    add('audio-block-header', `${parsed.badAudioBlocks.length} audio block header(s) are invalid (step index > 88, reserved byte set, or sample count not in 1..2*(size-8)); first is #${n}.`, {
      offset: A[n].offset - 8,
      count: parsed.badAudioBlocks.length,
    });
  }
  if (parsed.badFrames.length) {
    const n = parsed.badFrames[0];
    add('frame-markers', `${parsed.badFrames.length} frame(s) don't start with FFD8 and end with FFD9; first is #${n} at ${V[n].offset - 8}.`, {
      offset: V[n].offset - 8,
      count: parsed.badFrames.length,
    });
  }
}

/**
 * validateAmv(parsed[, options]) checks a parseAmv() result against what
 * FFmpeg's muxer writes, i.e. against ref/01 byte for byte (duration aside).
 * Options: fps (default 14) picks the profile via amvProfile(); width, height,
 * usPerFrame, samplesPerFrame, audioBlockSize override single values.
 * Returns {ok, problems: [{code, message, offset?, count?}], expected}.
 *
 * Problem codes: every parse error code, plus riff-sizes, header-layout,
 * us-per-frame, dimensions, timebase, amvh-reserved, video-stream-header,
 * audio-stream-header, audio-format, header-bytes, no-chunks,
 * first-chunk-not-video, interleave, count-mismatch, audio-block-size,
 * audio-nsamples, audio-block-header, frame-markers, trailer-pad,
 * trailer-pad-parity, trailing-data, duration.
 */
export function validateAmv(parsed, options = {}) {
  const o = options || {};
  const base = amvProfile(o.fps === undefined ? fps : o.fps);
  const p = Object.freeze({
    ...base,
    ...Object.fromEntries(
      ['width', 'height', 'usPerFrame', 'samplesPerFrame', 'audioBlockSize'].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
    ),
  });
  const problems = [];
  const add = (code, message, extra) => problems.push({ code, message, ...extra });
  add.count = () => problems.length;

  if (!parsed || !Array.isArray(parsed.errors) || !Array.isArray(parsed.video) || !Array.isArray(parsed.audio)) {
    add('not-parsed', 'validateAmv expects the object returned by parseAmv().');
    return { ok: false, problems, expected: p };
  }

  for (const e of parsed.errors) {
    const { code, message, ...extra } = e;
    add(code, message, extra);
  }

  const h = parsed.header;
  if (h && h.complete) checkHeader(h, p, add);
  if (parsed.moviOffset >= 0) checkChunks(parsed, p, add);

  const t = parsed.trailer;
  if (t && t.found) {
    if (t.padBytes > 1) {
      add('trailer-pad', `${t.padBytes} zero bytes precede 'AMV_END_'; at most 1 is allowed.`, { offset: t.offset - t.padBytes });
    } else if (t.offset - t.padBytes === t.chunksEnd && t.padBytes !== (t.chunksEnd & 1)) {
      add('trailer-pad-parity', `The last chunk ends at ${t.chunksEnd} (${t.chunksEnd & 1 ? 'odd' : 'even'}) but ${t.padBytes} pad byte(s) follow; FFmpeg pads only odd positions, with one 0x00.`, {
        offset: t.chunksEnd,
      });
    }
    if (t.trailingBytes > 0) add('trailing-data', `${t.trailingBytes} bytes follow 'AMV_END_'.`, { offset: t.offset + 8 });
  }

  if (h && h.duration && parsed.moviOffset >= 0) {
    const d = h.duration;
    const expected = Math.floor((parsed.video.length * p.usPerFrame) / 1e6);
    if (d.seconds > 59 || d.minutes > 59 || Math.abs(d.totalSeconds - expected) > 1) {
      add('duration', `amvh duration is ${d.hours}h${d.minutes}m${d.seconds}s (${d.totalSeconds} s); ${parsed.video.length} frames x ${p.usPerFrame} us = ${expected} s.`, {
        offset: h.durationOffset,
      });
    }
  }

  return { ok: problems.length === 0, problems, expected: p };
}

// ---------------------------------------------------------------------------
// Video: AMV frame -> standard JPEG, as FFmpeg's sp5x_decode_frame() does for AMV

const hexBytes = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));

// sp5x_qscale_five_quant_table (sp5x.h): luma then chroma, in DQT (zigzag) order.
const QSCALE_FIVE =
  '0d090a0b0a080d0b0a0b0e0e0d0f13201513121213271c1e17202e2931302e292d2c333a4a3e333646372c2d40574146' +
  '4c4e525352323e5a615a50604a51524f0e0e0e131113261515264f352d354f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f' +
  '4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f';
// sp5x_data_dht: the four standard Huffman tables (JPEG Annex K).
const SP5X_DHT =
  'ffc401a20000010501010101010100000000000000000102030405060708090a0b010003010101010101010101000000' +
  '0000000102030405060708090a0b100002010303020403050504040000017d0102030004110512213141061351610722' +
  '7114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a' +
  '535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8' +
  'a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9' +
  'fa1100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c1092333' +
  '52f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a63646566' +
  '6768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9ba' +
  'c2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa';
// sp5x_data_sof (8-bit, 3 components: Y 2x2 with table 0, Cb/Cr 1x1 with table 1) and sp5x_data_sos.
const SP5X_SOF = 'ffc000110800f0014003012200021101031101';
const SP5X_SOS = 'ffda000c03010002110311003f00';

const JPEG_PREFIX = hexBytes(
  'ffd8' + 'ffdb008400' + QSCALE_FIVE.slice(0, 128) + '01' + QSCALE_FIVE.slice(128) + SP5X_DHT + SP5X_SOF + SP5X_SOS,
);
const SOF_AT = JPEG_PREFIX.length - SP5X_SOS.length / 2 - SP5X_SOF.length / 2;

/**
 * frameToJpeg(frameBytes, width = 320, height = 240) returns a standard
 * baseline JPEG (Uint8Array), built exactly like FFmpeg's sp5x_decode_frame()
 * for AMV: SOI + DQT with the two qscale_five tables + standard DHT + SOF with
 * the size + SOS + frame bytes [2, size-2) + EOI. Same decoder, same pixels.
 *
 * The picture is still upside down (FRAMES_ARE_FLIPPED). Flip it when drawing:
 *   const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
 *   ctx.save(); ctx.translate(0, bmp.height); ctx.scale(1, -1);
 *   ctx.drawImage(bmp, 0, 0); ctx.restore();
 */
export function frameToJpeg(frameBytes, w = width, h = height) {
  const src = toBytes(frameBytes);
  if (!src) throw new TypeError('frameToJpeg: expected a Uint8Array or ArrayBuffer');
  const body = Math.max(0, src.length - 4);
  const out = new Uint8Array(JPEG_PREFIX.length + body + 2);
  out.set(JPEG_PREFIX);
  out[SOF_AT + 5] = (h >> 8) & 0xff;
  out[SOF_AT + 6] = h & 0xff;
  out[SOF_AT + 7] = (w >> 8) & 0xff;
  out[SOF_AT + 8] = w & 0xff;
  if (body) out.set(src.subarray(2, src.length - 2), JPEG_PREFIX.length);
  out[out.length - 2] = 0xff;
  out[out.length - 1] = 0xd9;
  return out;
}

// ---------------------------------------------------------------------------
// Audio: ADPCM_IMA_AMV, bit-exact with FFmpeg's decoder (libavcodec/adpcm.c)

const STEP_TABLE = Int16Array.from([
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143,
  157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411,
  1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493,
  10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767,
]);
const INDEX_TABLE = Int8Array.from([-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8]);

/** Samples FFmpeg outputs for the block at b[off, off+size): 0 when it rejects the block. */
function blockSamples(b, off, size) {
  if (size < 8 || off < 0 || off + size > b.length) return 0;
  const n = u32(b, off + 4);
  if (n === 0 || n > (size - 8) * 2 || b[off + 2] > 88) return 0;
  return n;
}

function decodeBlockInto(b, off, size, out, o) {
  const n = blockSamples(b, off, size);
  if (!n) return 0;
  let pred = ((b[off] | (b[off + 1] << 8)) << 16) >> 16;
  let idx = b[off + 2];
  let p = off + 8;
  const expand = (nib) => {
    const step = STEP_TABLE[idx];
    const diff = ((2 * (nib & 7) + 1) * step) >> 3;
    pred = nib & 8 ? pred - diff : pred + diff;
    if (pred > 32767) pred = 32767;
    else if (pred < -32768) pred = -32768;
    idx += INDEX_TABLE[nib];
    if (idx < 0) idx = 0;
    else if (idx > 88) idx = 88;
    return pred;
  };
  for (let k = n >> 1; k > 0; k--) {
    const v = b[p++];
    out[o++] = expand(v >> 4);
    out[o++] = expand(v & 15);
  }
  if (n & 1) out[o++] = expand(b[p] >> 4);
  return n;
}

/**
 * decodeAudioBlock(blockBytes) decodes one 01wb payload to Int16Array samples
 * (mono, 22050 Hz). Returns an empty array for a block FFmpeg would reject.
 */
export function decodeAudioBlock(blockBytes) {
  const b = toBytes(blockBytes);
  if (!b) throw new TypeError('decodeAudioBlock: expected a Uint8Array or ArrayBuffer');
  const out = new Int16Array(blockSamples(b, 0, b.length));
  decodeBlockInto(b, 0, b.length, out, 0);
  return out;
}

/**
 * decodeAudio(bytes, parsed = parseAmv(bytes)) decodes every audio block to
 * one Int16Array, mono, 22050 Hz, bit-exact with `ffmpeg -i x.amv -f s16le -`.
 * Blocks FFmpeg rejects (step index > 88, sample count 0 or larger than the
 * data holds) are dropped, as FFmpeg drops them.
 */
export function decodeAudio(bytes, parsed) {
  const b = toBytes(bytes);
  if (!b) throw new TypeError('decodeAudio: expected a Uint8Array or ArrayBuffer');
  const blocks = (parsed || parseAmv(b)).audio;
  let total = 0;
  for (const a of blocks) total += blockSamples(b, a.offset, a.size);
  const out = new Int16Array(total);
  let o = 0;
  for (const a of blocks) o += decodeBlockInto(b, a.offset, a.size, out, o);
  return out;
}

// ---------------------------------------------------------------------------
// Blob access: read a File/Blob in windows instead of all at once

async function readHeaderInto(blob, issues) {
  const n = Math.min(blob.size, HEADER_LIMIT);
  const b = new Uint8Array(await blob.slice(0, n).arrayBuffer());
  return parseHeader(b, blob.size, issues);
}

/** The walker's next window: at least st.need bytes, from st.pos. */
async function readWindow(blob, st, windowBytes) {
  const start = st.pos;
  const stop = Math.min(st.fileSize, start + Math.max(windowBytes, st.need));
  const b = new Uint8Array(await blob.slice(start, stop).arrayBuffer());
  if (b.length !== stop - start) throw new Error(`amv.js: short read from Blob at ${start}`);
  return b;
}

const windowSize = (chunkBytes) => Math.max(64, Math.floor(chunkBytes) || 0);

/**
 * parseAmvBlob(blob[, {chunkBytes = 4 MiB, maxChunkSize}]) resolves to the
 * same object parseAmv() returns, reading the Blob/File in windows: a
 * multi-GB file can go through validateAmv() while memory holds one window
 * plus the chunk index. Data problems never reject; Blob read errors do.
 */
export async function parseAmvBlob(blob, options = {}) {
  const { chunkBytes = 4 * 1024 * 1024, maxChunkSize = MAX_CHUNK_SIZE } = options || {};
  const issues = newIssues();
  const result = newResult(issues);
  result.fileSize = blob.size;
  const head = await readHeaderInto(blob, issues);
  result.header = head.header;
  result.moviOffset = head.moviOffset;
  if (head.moviOffset >= 0) {
    const st = newWalk(head.moviOffset, blob.size, maxChunkSize, issues);
    const windowBytes = windowSize(chunkBytes);
    while (!st.done) {
      const start = st.pos;
      const b = await readWindow(blob, st, windowBytes);
      try {
        walk(st, b, start, null);
      } catch (e) {
        report(issues, 'errors', 'internal-error', `Parser failure: ${(e && e.message) || e}`);
        break;
      }
    }
    takeWalk(result, st);
  }
  closeIssues(issues);
  return result;
}

/**
 * readHeader(blob) reads only the header of a Blob/File (at most 64 KiB).
 * Resolves to {fileSize, header, moviOffset, errors, warnings}, the same
 * fields parseAmv() returns for them.
 */
export async function readHeader(blob) {
  const issues = newIssues();
  const head = await readHeaderInto(blob, issues);
  closeIssues(issues);
  return { fileSize: blob.size, header: head.header, moviOffset: head.moviOffset, errors: issues.errors, warnings: issues.warnings };
}

/**
 * iterateChunks(blob, {chunkBytes = 4 MiB, maxChunkSize}) walks a Blob/File
 * through blob.slice() windows of about chunkBytes, never holding the whole
 * file. Yields {type: 'video'|'audio', index, data} in file order; data is a
 * copy of the payload with its own buffer (safe to keep or transfer). It
 * yields the same chunks parseAmv() lists and never throws over bad data:
 * junk is skipped as parseAmv skips it, and truncation ends the walk. The
 * generator's return value (seen from a manual next() loop) is a summary:
 * {fileSize, header, moviOffset, videoCount, audioCount, badFrames,
 * badAudioBlocks, trailer, errors, warnings}. Read errors from the Blob throw.
 */
export async function* iterateChunks(blob, options = {}) {
  const { chunkBytes = 4 * 1024 * 1024, maxChunkSize = MAX_CHUNK_SIZE } = options || {};
  const issues = newIssues();
  const fileSize = blob.size;
  const head = await readHeaderInto(blob, issues);
  const summary = {
    fileSize,
    header: head.header,
    moviOffset: head.moviOffset,
    videoCount: 0,
    audioCount: 0,
    badFrames: [],
    badAudioBlocks: [],
    trailer: { found: false, offset: -1, padBytes: 0, trailingBytes: 0, chunksEnd: -1 },
    errors: issues.errors,
    warnings: issues.warnings,
  };
  if (head.moviOffset >= 0) {
    const st = newWalk(head.moviOffset, fileSize, maxChunkSize, issues);
    const windowBytes = windowSize(chunkBytes);
    const ready = [];
    const onChunk = (type, index, b, r, size) => ready.push({ type, index, data: b.slice(r, r + size) });
    while (!st.done) {
      const start = st.pos;
      const b = await readWindow(blob, st, windowBytes);
      walk(st, b, start, onChunk);
      for (const c of ready) yield c;
      ready.length = 0;
    }
    summary.videoCount = st.videoCount;
    summary.audioCount = st.audioCount;
    summary.badFrames = st.badFrames;
    summary.badAudioBlocks = st.badAudioBlocks;
    summary.trailer = st.trailer;
  }
  closeIssues(issues);
  return summary;
}
