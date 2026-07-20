// Normalize a protocol JSON frame (from the bridge or sim) into FrameStore
// fields. Shared by the live panel and recorder so both interpret the wire
// format identically.

import { FrameFlags } from '../core/frame-store.js';
import { hexToBytes } from '../util/hex.js';

/** Protocol frame -> { t, id, ext, ch, flags, data }. */
export function normalizeFrame(f) {
  let flags = 0;
  if (f.fd) flags |= FrameFlags.FD;
  if (f.brs) flags |= FrameFlags.BRS;
  if (f.esi) flags |= FrameFlags.ESI;
  if (f.rtr) flags |= FrameFlags.RTR;
  if (f.err) flags |= FrameFlags.ERR;
  if (f.dir === 'tx' || f.dir === 'Tx' || f.tx) flags |= FrameFlags.TX;
  const data = f.err ? new Uint8Array(0) : hexToBytes(f.data || '');
  return {
    t: f.t ?? 0,
    id: (f.id >>> 0) & 0x1fffffff,
    ext: !!f.ext,
    ch: f.ch ?? 1,
    flags,
    data,
  };
}
