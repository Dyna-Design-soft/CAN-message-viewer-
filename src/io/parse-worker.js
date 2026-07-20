// Web Worker: parse a log File off the main thread and transfer the resulting
// columnar FrameStore back with zero copy. Keeps the UI responsive on large
// BLF/TDMS/ASC files.

import { loadLogFile } from './format-registry.js';
import { FrameStore } from '../core/frame-store.js';
// Register all input formats inside the worker (side-effect imports).
import './asc-reader.js';
import './blf-reader.js';
import './csv-writer.js';
import './tdms-reader.js';

self.onmessage = async (e) => {
  const { file } = e.data;
  try {
    const { store, format } = await loadLogFile(file);
    const s = store.serialize();
    self.postMessage({ ok: true, store: s, format }, FrameStore.transferList(s));
  } catch (err) {
    self.postMessage({ ok: false, error: err.message });
  }
};
