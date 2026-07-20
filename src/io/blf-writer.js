// Vector BLF writer.
//
// Emits a standard BLF: a 144-byte file header followed by zlib LOG_CONTAINER
// objects, each holding a run of message objects. Classic frames are written
// as CAN_MESSAGE (type 1); CAN FD frames as CAN_FD_MESSAGE (type 100); error
// frames as CAN_ERROR (type 2). Timestamps are nanoseconds (objectFlags = 2).
//
// The layout follows the documented Vector BLF structures; it round-trips
// through this viewer's own BLF reader and is intended to be CANoe-readable.

import { BinaryWriter, deflate } from '../util/binary.js';
import { FrameFlags, lengthToDlc } from '../core/frame-store.js';

const SIG_FILE = 'LOGG';
const SIG_OBJ = 'LOBJ';
const OBJ_CAN_MESSAGE = 1;
const OBJ_CAN_ERROR = 2;
const OBJ_LOG_CONTAINER = 10;
const OBJ_CAN_FD_MESSAGE = 100;
const OBJ_FLAG_NS = 2;
const CONTAINER_MAX = 128 * 1024; // uncompressed bytes per container

const CANFD_EDL = 0x01;
const CANFD_BRS = 0x02;
const CANFD_ESI = 0x04;
const CAN_MSG_FLAG_TX = 0x01;
const ID_EXT_FLAG = 0x80000000;

export async function writeBlf(store) {
  const containers = []; // compressed container objects (Uint8Array)
  let uncompressedTotal = 0;
  let objCount = 0;

  let cur = new BinaryWriter(CONTAINER_MAX + 4096);
  const flushContainer = async () => {
    if (cur.pos === 0) return;
    const raw = cur.finish();
    uncompressedTotal += raw.length;
    const compressed = await deflate(raw);
    containers.push(buildContainer(compressed, raw.length));
    objCount++; // container counts as an object
    cur = new BinaryWriter(CONTAINER_MAX + 4096);
  };

  for (let i = 0; i < store.count; i++) {
    writeMessageObject(cur, store, i);
    if (cur.pos >= CONTAINER_MAX) await flushContainer();
  }
  await flushContainer();

  // assemble file
  const body = concat(containers);
  const header = buildFileHeader(store, body.length, uncompressedTotal, objCount);
  return concat([header, body]);
}

function writeMessageObject(w, store, i) {
  const f = store.flags[i];
  const tsNs = Math.round(store.t[i] * 1e9);
  const id = store.rawId(i) | (store.isExt(i) ? ID_EXT_FLAG : 0);
  const data = store.data(i);

  if (f & FrameFlags.ERR) {
    beginObject(w, OBJ_CAN_ERROR, tsNs, 8, () => {
      w.u16(store.ch[i]); // channel
      w.u16(0); // length
      w.u32(0); // reserved
    });
    return;
  }

  if (f & FrameFlags.FD) {
    // CAN_FD_MESSAGE (type 100): 88-byte payload with data[64]
    beginObject(w, OBJ_CAN_FD_MESSAGE, tsNs, 88, () => {
      let cfd = CANFD_EDL;
      if (f & FrameFlags.BRS) cfd |= CANFD_BRS;
      if (f & FrameFlags.ESI) cfd |= CANFD_ESI;
      w.u16(store.ch[i]); // channel
      w.u8(f & FrameFlags.TX ? CAN_MSG_FLAG_TX : 0); // flags
      w.u8(lengthToDlc(data.length)); // dlc code
      w.u32(id);
      w.u32(0); // frameLength (ns) — unknown
      w.u8(0); // arbBitCount
      w.u8(cfd); // canFdFlags
      w.u8(data.length); // validDataBytes
      w.u8(0); // reserved1
      w.u32(0); // reserved2
      writePadded(w, data, 64);
      w.u32(0); // reserved3
    });
    return;
  }

  // CAN_MESSAGE (type 1): 16-byte payload, data[8]
  beginObject(w, OBJ_CAN_MESSAGE, tsNs, 16, () => {
    w.u16(store.ch[i]); // channel
    w.u8((f & FrameFlags.TX ? CAN_MSG_FLAG_TX : 0) | (f & FrameFlags.RTR ? 0x80 : 0)); // flags
    w.u8(data.length); // dlc
    w.u32(id);
    writePadded(w, data, 8);
  });
}

/** Write a message object: base header (16) + v1 header (16) + payload. */
function beginObject(w, type, tsNs, payloadSize, writePayload) {
  const objectSize = 32 + payloadSize;
  w.fourcc(SIG_OBJ);
  w.u16(32); // headerSize (base + v1)
  w.u16(1); // headerVersion
  w.u32(objectSize);
  w.u32(type);
  // v1 header
  w.u32(OBJ_FLAG_NS); // objectFlags = ns timestamp
  w.u16(0); // clientIndex
  w.u16(0); // objectVersion
  w.u64(tsNs); // timestamp
  const before = w.pos;
  writePayload();
  // pad payload to declared size just in case
  const written = w.pos - before;
  if (written < payloadSize) w.zeros(payloadSize - written);
  w.align(4); // objects are 4-byte aligned in the stream
}

function writePadded(w, data, size) {
  w.raw(data.subarray(0, Math.min(data.length, size)));
  if (data.length < size) w.zeros(size - data.length);
}

function buildContainer(compressed, uncompressedSize) {
  const w = new BinaryWriter(compressed.length + 64);
  const objectSize = 16 + 16 + compressed.length; // base + container header + data
  w.fourcc(SIG_OBJ);
  w.u16(16); // headerSize (base only)
  w.u16(1); // headerVersion
  w.u32(objectSize);
  w.u32(OBJ_LOG_CONTAINER);
  // container header (16 bytes): method u16, 6 reserved, uncompressedSize u32, 4 reserved
  w.u16(2); // compression method: 2 = zlib deflate
  w.zeros(6);
  w.u32(uncompressedSize);
  w.zeros(4);
  w.raw(compressed);
  w.align(4);
  return w.finish();
}

function buildFileHeader(store, fileBodySize, uncompressedTotal, objCount) {
  const w = new BinaryWriter(144);
  w.fourcc(SIG_FILE);
  w.u32(144); // header size
  w.u8(0); w.u8(0); w.u8(0); w.u8(0); // app id / version
  w.u8(0); w.u8(0); w.u8(0); w.u8(0); // bin log version
  w.u64(144 + fileBodySize); // total file size
  w.u64(uncompressedTotal); // uncompressed size
  w.u32(objCount); // object count
  w.u32(0); // objects read
  const start = store.t0Epoch != null ? new Date(store.t0Epoch * 1000) : new Date();
  const end = new Date((store.t0Epoch ?? Date.now() / 1000) * 1000 + (store.count ? store.t[store.count - 1] * 1000 : 0));
  writeSystemTime(w, start);
  writeSystemTime(w, end);
  while (w.pos < 144) w.u8(0);
  return w.finish();
}

function writeSystemTime(w, d) {
  w.u16(d.getFullYear());
  w.u16(d.getMonth() + 1);
  w.u16(d.getDay());
  w.u16(d.getDate());
  w.u16(d.getHours());
  w.u16(d.getMinutes());
  w.u16(d.getSeconds());
  w.u16(d.getMilliseconds());
}

function concat(arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrays) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
