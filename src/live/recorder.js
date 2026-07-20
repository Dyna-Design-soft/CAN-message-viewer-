// Records incoming live frames into a dedicated FrameStore and saves them as
// ASC, CSV, or BLF. The recorder taps the frame stream *before* the live
// ring-buffer trimming, so long recordings are never truncated by retention.

import { FrameStore } from '../core/frame-store.js';
import { writeAsc } from '../io/asc-writer.js';
import { writeCsv } from '../io/csv-writer.js';
import { writeBlf } from '../io/blf-writer.js';

export class Recorder {
  constructor() {
    this.recording = false;
    this.store = new FrameStore();
    this.startedAt = null;
  }

  get count() {
    return this.store.count;
  }

  start(t0Epoch) {
    this.store = new FrameStore();
    this.store.t0Epoch = t0Epoch ?? Date.now() / 1000;
    this.recording = true;
    this.startedAt = performance.now();
  }

  /** Append a normalized frame (fields from the ingest layer). */
  feed(t, id, ext, ch, flags, data) {
    if (!this.recording) return;
    this.store.add(t, id, ext, ch, flags, data);
  }

  stop() {
    this.recording = false;
  }

  /** Serialize to bytes/text for the chosen format. */
  async serialize(format) {
    switch (format) {
      case 'asc':
        return { data: writeAsc(this.store), mime: 'text/plain', ext: 'asc' };
      case 'csv':
        return { data: writeCsv(this.store), mime: 'text/csv', ext: 'csv' };
      case 'blf':
        return { data: await writeBlf(this.store), mime: 'application/octet-stream', ext: 'blf' };
      default:
        throw new Error('Unknown record format: ' + format);
    }
  }

  async save(format, fileNameBase = 'recording') {
    const { data, mime, ext } = await this.serialize(format);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(new Blob([data], { type: mime }), `${fileNameBase}_${stamp}.${ext}`);
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
