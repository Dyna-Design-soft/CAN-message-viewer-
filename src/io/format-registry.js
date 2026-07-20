// Pluggable log-file format registry.
//
// Each reader module registers { name, extensions, sniff(bytes), read(file) }.
// `read(file)` receives a File/Blob and resolves to a FrameStore.
// Detection: magic-byte sniff first (more reliable), then file extension.

const formats = [];

export function registerFormat(fmt) {
  formats.push(fmt);
}

export function listFormats() {
  return [...formats];
}

/**
 * Pick a reader for a file.
 * @param {File} file
 * @param {Uint8Array} head first bytes of the file (>= 64 recommended)
 */
export function detectFormat(file, head) {
  for (const f of formats) {
    if (f.sniff && f.sniff(head, file.name)) return f;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (const f of formats) {
    if (f.extensions.includes(ext)) return f;
  }
  return null;
}

/** Load a file into a FrameStore using the detected format (this thread). */
export async function loadLogFile(file, onProgress) {
  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const fmt = detectFormat(file, head);
  if (!fmt) {
    throw new Error(
      `Unsupported file format: "${file.name}". Supported: ` +
        formats.map((f) => f.name).join(', '),
    );
  }
  const store = await fmt.read(file, onProgress);
  return { store, format: fmt.name };
}

/**
 * Load a file in a Web Worker (keeps the UI responsive on large files),
 * falling back to main-thread parsing if workers are unavailable.
 */
export async function loadLogFileInWorker(file) {
  // The single-file build has no separate worker script to load; parse on the
  // main thread instead. esbuild's --define folds this to a constant so the
  // Worker/URL reference below becomes dead code (no second chunk is emitted).
  const SINGLEFILE = typeof __SINGLEFILE__ !== 'undefined' && __SINGLEFILE__;
  if (SINGLEFILE) return loadLogFile(file);
  const { FrameStore } = await import('../core/frame-store.js');
  if (typeof Worker === 'undefined') return loadLogFile(file);
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL('./parse-worker.js', import.meta.url), { type: 'module' });
    } catch {
      resolve(loadLogFile(file));
      return;
    }
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) {
        resolve({ store: FrameStore.fromSerialized(e.data.store), format: e.data.format });
      } else {
        reject(new Error(e.data.error));
      }
    };
    worker.onerror = () => {
      worker.terminate();
      // Module-worker support issues: fall back to the main thread.
      loadLogFile(file).then(resolve, reject);
    };
    worker.postMessage({ file });
  });
}
