/* Loads ffmpeg.wasm once and runs each command in a disposable worker.
 *
 * Two builds ship with the page: multi-threaded (needs cross-origin
 * isolation, which sw.js provides on GitHub Pages) and single-threaded
 * (works everywhere). The engine prefers threads and falls back on its own. */

const CORES = {
  mt: { dir: 'vendor/ffmpeg-0.12.10-mt/', wasmBytes: 32718323, pthreads: true },
  st: { dir: 'vendor/ffmpeg-0.12.10-st/', wasmBytes: 32232419, pthreads: false },
};

export class EngineError extends Error {
  /** code: cancelled | stalled | crashed | oom | failed | load-failed | wasm-unsupported */
  constructor(code, message, detail = {}) {
    super(message || code);
    this.name = 'EngineError';
    this.code = code;
    this.lines = detail.lines || [];
    this.ret = detail.ret;
    this.mode = detail.mode;
  }
}

/** True when this page may use the multi-threaded build. */
export function threadsAvailable() {
  try {
    if (!self.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') return false;
    new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    return true;
  } catch (_) {
    return false;
  }
}

/** Both builds are compiled with wasm SIMD; browsers older than ~2021-2023 lack it. */
export function wasmSupported() {
  try {
    if (typeof WebAssembly !== 'object') return false;
    // (module (func (result v128) i32.const 0 i8x16.splat i8x16.popcnt))
    const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
    return WebAssembly.validate(simd);
  } catch (_) {
    return false;
  }
}

/** Decoder threads for the MT build. The build's worker pool holds 32
 * threads; ffmpeg's automatic count can exceed that and deadlock, so we
 * always pass an explicit, modest number. */
export function decodeThreads() {
  const n = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  return Math.max(2, Math.min(8, n - 1));
}

/** Defense in depth for the multi-threaded build: a command that doesn't state
 * its decoder thread count gets a safe one, so no caller can deadlock the pool. */
export function guardThreads(args) {
  const out = [];
  let sawThreads = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-threads') sawThreads = true;
    if (args[i] === '-i' && !sawThreads) out.push('-threads', '2');
    if (args[i] === '-i') sawThreads = false;
    out.push(args[i]);
  }
  if (!out.includes('-filter_threads')) out.unshift('-filter_threads', '1');
  return out;
}

const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new EngineError('cancelled'));
    });
  });

async function fetchWithProgress(url, expectedBytes, onProgress) {
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!res.body || !res.body.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const parts = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    onProgress?.(Math.min(0.99, received / expectedBytes));
  }
  const out = new Uint8Array(received);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  onProgress?.(1);
  return out;
}

export function createEngine({ baseURL = new URL('./', import.meta.url), onLoadProgress, onLoadState } = {}) {
  const modules = new Map(); // mode -> Promise<WebAssembly.Module>
  const preferred = threadsAvailable() ? 'mt' : 'st';

  function load(mode) {
    if (!modules.has(mode)) {
      const p = fetchAndCompile(mode);
      modules.set(mode, p);
      p.catch(() => modules.delete(mode)); // allow a later retry
    }
    return modules.get(mode);
  }

  async function fetchAndCompile(mode) {
    const url = new URL(CORES[mode].dir + 'ffmpeg-core.wasm', baseURL);
    for (let attempt = 0; ; attempt++) {
      try {
        onLoadState?.(mode, attempt ? 'retrying' : 'downloading');
        const bytes = await fetchWithProgress(url, CORES[mode].wasmBytes, (f) => onLoadProgress?.(mode, f));
        onLoadState?.(mode, 'compiling');
        const module = await WebAssembly.compile(bytes);
        onLoadState?.(mode, 'ready');
        return module;
      } catch (err) {
        if (err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError) {
          onLoadState?.(mode, 'unsupported');
          throw new EngineError('wasm-unsupported', String(err.message || err));
        }
        if (attempt >= 5) {
          onLoadState?.(mode, 'failed');
          throw new EngineError('load-failed', String(err.message || err));
        }
        onLoadState?.(mode, 'offline');
        // Wait for the network to come back, or back off and try again.
        await Promise.race([
          sleep(Math.min(30000, 1500 * 2 ** attempt)),
          new Promise((r) => self.addEventListener('online', r, { once: true })),
        ]);
      }
    }
  }

  /**
   * Run one ffmpeg/ffprobe command. Resolves {ret, files, stream, lines, runMs};
   * rejects with EngineError. job: {file, tool, args, outputs, extraFiles,
   * streamOutput, onLog, onChunk, signal, stallMs}
   */
  async function run(mode, job) {
    const { signal } = job;
    if (signal?.aborted) throw new EngineError('cancelled');
    const module = await load(mode);
    if (signal?.aborted) throw new EngineError('cancelled');
    const dir = new URL(CORES[mode].dir, baseURL);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('engine-worker.js', baseURL));
      const lines = [];
      let settled = false;
      const stallMs = job.stallMs || 90000;
      // Stall watchdog that survives sleep: a gap in our own 5 s heartbeat
      // means the computer slept (lid closed), not that ffmpeg hung.
      let lastActivity = Date.now();
      let lastTick = lastActivity;
      const heartbeat = setInterval(() => {
        const now = Date.now();
        if (now - lastTick > 15000) lastActivity = now;
        lastTick = now;
        if (now - lastActivity > stallMs) finish(new EngineError('stalled', `no output for ${stallMs} ms`, { lines, mode }));
      }, Math.min(5000, Math.max(250, stallMs / 4)));

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        worker.terminate();
        signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve(value);
      };
      const kick = () => {
        lastActivity = Date.now();
      };
      const onAbort = () => finish(new EngineError('cancelled', 'cancelled', { lines, mode }));
      signal?.addEventListener('abort', onAbort);

      worker.onmessage = (e) => {
        const m = e.data;
        kick();
        if (m.type === 'log') {
          lines.push(m.line);
          if (lines.length > 3000) lines.splice(0, 1000);
          job.onLog?.(m.line, m.stream);
        } else if (m.type === 'chunk') {
          job.onChunk?.(m.offset, m.data);
        } else if (m.type === 'done') {
          finish(null, { ret: m.ret, files: m.files || {}, stream: m.stream, runMs: m.runMs, lines, mode });
        } else if (m.type === 'error') {
          finish(new EngineError(m.oom ? 'oom' : 'crashed', m.message, { lines, mode }));
        }
      };
      worker.onerror = (e) => {
        e.preventDefault?.();
        const msg = e.message || 'worker error';
        finish(new EngineError(/memory/i.test(msg) ? 'oom' : 'crashed', msg, { lines, mode }));
      };
      worker.onmessageerror = () => finish(new EngineError('crashed', 'message error', { lines, mode }));

      kick();
      worker.postMessage({
        type: 'run',
        coreURL: new URL('ffmpeg-core.js', dir).href,
        workerURL: CORES[mode].pthreads ? new URL('ffmpeg-core.worker.js', dir).href : undefined,
        wasmModule: module,
        file: job.file || null,
        tool: job.tool || 'ffmpeg',
        args: mode === 'mt' && (job.tool || 'ffmpeg') === 'ffmpeg' ? guardThreads(job.args) : job.args,
        outputs: job.outputs || [],
        extraFiles: job.extraFiles || [],
        extraBlobs: job.extraBlobs || [],
        streamOutput: job.streamOutput || null,
      });
    });
  }

  return { preferred, load, run, threads: preferred === 'mt' ? decodeThreads() : 1 };
}
