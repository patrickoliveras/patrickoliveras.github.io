/* Runs one ffmpeg or ffprobe command inside a fresh ffmpeg.wasm instance.
 *
 * One worker per command, so nothing leaks between jobs and cancelling is
 * just worker.terminate(). The page compiles the wasm once and passes the
 * WebAssembly.Module in, so starting a job costs milliseconds, not a 32 MB
 * download and compile.
 *
 * Output can be streamed: instead of growing a 500 MB file in memory, bytes
 * past the header are posted to the page in chunks as ffmpeg writes them.
 * The AMV muxer only ever seeks back into its header (to write the duration),
 * so the first HEAD_BYTES stay here, patchable, until the job ends. */
'use strict';

const HEAD_BYTES = 64 * 1024;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function makeStreamingOutput(core, path, flushBytes) {
  const FS = core.FS;
  const head = new Uint8Array(HEAD_BYTES);
  let size = 0; // logical file size
  let committed = HEAD_BYTES; // everything in [HEAD_BYTES, committed) is already posted
  let pending = []; // Uint8Arrays covering [committed, committed + pendingLen)
  let pendingLen = 0;
  let chunks = 0;

  function flush() {
    if (!pendingLen) return;
    const out = new Uint8Array(pendingLen);
    let o = 0;
    for (const p of pending) {
      out.set(p, o);
      o += p.length;
    }
    post({ type: 'chunk', offset: committed, data: out }, [out.buffer]);
    committed += pendingLen;
    pending = [];
    pendingLen = 0;
    chunks++;
  }

  function writeTail(pos, data) {
    const end = committed + pendingLen;
    if (pos < committed) {
      // A seek back into bytes already sent. The AMV muxer never does this;
      // fail loudly so the engine retries with an in-memory file instead.
      throw new FS.ErrnoError(29);
    }
    if (pos > end) {
      const gap = new Uint8Array(pos - end);
      pending.push(gap);
      pendingLen += gap.length;
    } else if (pos < end) {
      // Overwrite inside the not-yet-flushed region: merge, then continue.
      const merged = new Uint8Array(Math.max(end, pos + data.length) - committed);
      let o = 0;
      for (const p of pending) {
        merged.set(p, o);
        o += p.length;
      }
      merged.set(data, pos - committed);
      pending = [merged];
      pendingLen = merged.length;
      return;
    }
    pending.push(data.slice()); // copy: data is a view into the wasm heap
    pendingLen += data.length;
  }

  // A regular file whose stream operations we replace. (A device node would
  // be simpler, but emscripten refuses O_TRUNC on devices and ffmpeg opens
  // its output with O_TRUNC.)
  FS.writeFile(path, new Uint8Array(0));
  const node = FS.lookupPath(path).node;
  node.stream_ops = Object.assign({}, node.stream_ops, {
    read() {
      throw new FS.ErrnoError(28);
    },
    write(stream, buffer, offset, length, position) {
      const data = buffer.subarray(offset, offset + length);
      let pos = position;
      let i = 0;
      if (pos < HEAD_BYTES) {
        const n = Math.min(length, HEAD_BYTES - pos);
        head.set(data.subarray(0, n), pos);
        pos += n;
        i = n;
      }
      if (i < length) writeTail(pos, data.subarray(i));
      size = Math.max(size, position + length);
      if (pendingLen >= flushBytes) flush();
      return length;
    },
    llseek(stream, offset, whence) {
      const p = whence === 0 ? offset : whence === 1 ? stream.position + offset : size + offset;
      if (p < 0) throw new FS.ErrnoError(28);
      return p;
    },
  });

  return {
    finish() {
      flush();
      const h = head.slice(0, Math.min(size, HEAD_BYTES));
      return { head: h, size, chunks };
    },
  };
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'run') return;
  const { coreURL, workerURL, wasmModule, file, tool, args, outputs, extraFiles, extraBlobs, streamOutput } = msg;
  let core;
  try {
    const t0 = performance.now();
    importScripts(coreURL);
    core = await self.createFFmpegCore({
      // ffmpeg.wasm convention: the core reads these URLs back out of the hash.
      mainScriptUrlOrBlob: coreURL + '#' + btoa(JSON.stringify({ wasmURL: coreURL.replace(/\.js$/, '.wasm'), workerURL })),
      instantiateWasm(imports, receiveInstance) {
        WebAssembly.instantiate(wasmModule, imports).then(
          (instance) => receiveInstance(instance, wasmModule),
          (err) => post({ type: 'error', message: 'instantiate: ' + String(err && err.message ? err.message : err) })
        );
        return {};
      },
    });
    post({ type: 'loaded', ms: Math.round(performance.now() - t0) });

    core.setLogger(({ type, message }) => post({ type: 'log', stream: type, line: message }));

    const FS = core.FS;
    FS.mkdir('/in');
    FS.mkdir('/in2');
    FS.mkdir('/out');
    if (file) {
      // WORKERFS reads the File lazily: a 4 GB input never has to fit in memory.
      FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name: 'input', data: file }] }, '/in');
    }
    for (const extra of extraFiles || []) {
      FS.writeFile(extra.path, new Uint8Array(extra.data));
    }
    for (const extra of extraBlobs || []) {
      // Large generated inputs (browser-decoded frames) are read lazily too.
      try {
        FS.mkdir(extra.dir);
      } catch (_) {}
      FS.mount(FS.filesystems.WORKERFS, { blobs: [{ name: extra.name, data: extra.data }] }, extra.dir);
    }
    const streamer = streamOutput ? makeStreamingOutput(core, streamOutput.path, streamOutput.flushBytes || 4 << 20) : null;

    const t1 = performance.now();
    const ret = tool === 'ffprobe' ? core.ffprobe(...args) : core.exec(...args);
    const runMs = Math.round(performance.now() - t1);

    const files = {};
    const transfer = [];
    for (const path of outputs || []) {
      try {
        const data = FS.readFile(path);
        files[path] = data;
        transfer.push(data.buffer);
      } catch (_) {
        // a missing output is reported by its absence
      }
    }
    let stream = null;
    if (streamer) {
      stream = streamer.finish();
      transfer.push(stream.head.buffer);
    }
    post({ type: 'done', ret, runMs, files, stream }, transfer);
  } catch (err) {
    const message = String((err && err.message) || err);
    post({ type: 'error', message, oom: /memory|OOM|allocat/i.test(message) });
  }
};
