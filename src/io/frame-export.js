// Extract a subset of a FrameStore and serialize it to a chosen format.
//
// Two extraction modes:
//   - range(from, to): every frame whose timestamp falls in [from, to].
//   - snapshot(t): the bus state at time t — the most recent frame of each
//     (channel, id) at or before t, i.e. one frame per message.
// Output formats: ASC, BLF, CSV, TDMS (NI-XNET raw frame).

import { FrameStore } from '../core/frame-store.js';
import { writeAsc } from './asc-writer.js';
import { writeCsv } from './csv-writer.js';
import { writeBlf } from './blf-writer.js';
import { writeTdms } from './tdms-writer.js';

/** New FrameStore with the frames whose time is within [from, to]. */
export function extractRange(store, from, to) {
  const out = new FrameStore();
  out.t0Epoch = store.t0Epoch;
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let i = 0; i < store.count; i++) {
    const t = store.t[i];
    if (t < lo || t > hi) continue;
    out.add(t, store.rawId(i), store.isExt(i), store.ch[i], store.flags[i], store.data(i));
  }
  return out;
}

/**
 * New FrameStore holding the latest frame of each (channel, id) at or before t
 * — a single snapshot of the bus state at that instant, one frame per message.
 */
export function extractSnapshot(store, t) {
  const out = new FrameStore();
  out.t0Epoch = store.t0Epoch;
  const best = new Map(); // ch*2^32+idWithExt -> frame index
  for (let i = 0; i < store.count; i++) {
    if (store.t[i] > t) continue;
    const key = store.ch[i] * 0x100000000 + store.id[i];
    const prev = best.get(key);
    if (prev === undefined || store.t[i] >= store.t[prev]) best.set(key, i);
  }
  const idxs = [...best.values()].sort((a, b) => store.t[a] - store.t[b]);
  for (const i of idxs) {
    out.add(store.t[i], store.rawId(i), store.isExt(i), store.ch[i], store.flags[i], store.data(i));
  }
  return out;
}

/** Serialize a FrameStore to bytes/text for the given format. */
export async function serializeFrames(store, format) {
  switch (format) {
    case 'asc': return { data: writeAsc(store), mime: 'text/plain', ext: 'asc' };
    case 'csv': return { data: writeCsv(store), mime: 'text/csv', ext: 'csv' };
    case 'blf': return { data: await writeBlf(store), mime: 'application/octet-stream', ext: 'blf' };
    case 'tdms': return { data: writeTdms(store), mime: 'application/octet-stream', ext: 'tdms' };
    default: throw new Error('Unknown export format: ' + format);
  }
}
