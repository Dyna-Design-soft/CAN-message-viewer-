// Write a FrameStore to an NI TDMS file in the NI-XNET raw-frame layout that
// this viewer's TDMS reader consumes: one u8 channel ("My Group/My Channel")
// carrying NI_network_* properties, whose bytes are a stream of frame records
// (16-byte header + payload padded to an 8-byte boundary).
//
// Round-trips through tdms-reader.js. Note the raw-frame format carries only
// id / extended / payload / timestamp (+ FD implied by payload > 8 bytes);
// direction, error and BRS/ESI flags are not represented.

import { BinaryWriter } from '../util/binary.js';

const FILETIME_UNIX_OFFSET = 11644473600; // seconds between 1601 and 1970
const NIX_EXT_FLAG = 0x20000000;

/** Build the NI-XNET raw-frame byte stream for a FrameStore. */
export function buildNixnetStream(store) {
  let size = 0;
  for (let i = 0; i < store.count; i++) size += 16 + Math.ceil(store.len[i] / 8) * 8;
  const bytes = new Uint8Array(size);
  const dv = new DataView(bytes.buffer);
  let pos = 0;
  for (let i = 0; i < store.count; i++) {
    const len = store.len[i];
    const tSec = (store.t0Epoch ?? 0) + store.t[i];
    const ticks = BigInt(Math.round((tSec + FILETIME_UNIX_OFFSET) * 1e7));
    dv.setBigUint64(pos, ticks, true);
    const idRaw = (store.rawId(i) & 0x1fffffff) | (store.isExt(i) ? NIX_EXT_FLAG : 0);
    dv.setUint32(pos + 8, idRaw >>> 0, true);
    // bytes 12..14 (type/flags/info) are ignored by the reader; leave 0.
    bytes[pos + 15] = len;
    const data = store.data(i);
    bytes.set(data.subarray(0, Math.min(len, 64)), pos + 16);
    pos += 16 + Math.ceil(len / 8) * 8;
  }
  return bytes;
}

export function writeTdms(store) {
  const stream = buildNixnetStream(store);

  // ---- metadata: one channel object with raw data + NI_network props ----
  const meta = new BinaryWriter(512);
  meta.u32(1); // numObjects
  writeStr(meta, "/'My Group'/'My Channel'");
  meta.u32(20); // rawDataIndex length (non-zero → object has raw data)
  meta.u32(5); // data type: u8
  meta.u32(1); // array dimension
  meta.u64(stream.length); // number of values (bytes)
  meta.u32(2); // property count
  writeI32Prop(meta, 'NI_network_frame_version', 512);
  writeStrProp(meta, 'NI_network_content', 'CAN');
  const metaBytes = meta.finish();

  // ---- lead-in + segment ----
  const out = new BinaryWriter(28 + metaBytes.length + stream.length);
  out.fourcc('TDSm');
  out.u32((1 << 1) | (1 << 2) | (1 << 3)); // ToC: META | NEW_OBJ_LIST | RAW_DATA
  out.u32(4713); // TDMS version 2.0
  out.u64(metaBytes.length + stream.length); // next segment offset (from end of lead-in)
  out.u64(metaBytes.length); // raw data offset (from end of lead-in)
  out.raw(metaBytes);
  out.raw(stream);
  return out.finish();
}

function writeStr(w, s) {
  const b = new TextEncoder().encode(s);
  w.u32(b.length);
  w.raw(b);
}
function writeI32Prop(w, name, v) {
  writeStr(w, name);
  w.u32(3); // i32
  w.i32(v);
}
function writeStrProp(w, name, v) {
  writeStr(w, name);
  w.u32(0x20); // string
  writeStr(w, v);
}
