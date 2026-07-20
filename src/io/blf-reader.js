// Vector BLF reader.
//
// Parses the 144-byte file header, then walks objects. LOG_CONTAINER objects
// are zlib-inflated and their inner objects parsed recursively. Handles
// CAN_MESSAGE (1), CAN_MESSAGE2 (86), CAN_FD_MESSAGE (100), CAN_FD_MESSAGE_64
// (101) and CAN_ERROR (2/73); other object types are skipped by size.
//
// Real-file BRS/ESI flags for CAN_FD_MESSAGE_64 are best-effort; validate
// against a sample capture if exact FD flag fidelity is required.

import { BinaryReader, inflate } from '../util/binary.js';
import { FrameStore, FrameFlags } from '../core/frame-store.js';
import { registerFormat } from './format-registry.js';

const OBJ_CAN_MESSAGE = 1;
const OBJ_CAN_ERROR = 2;
const OBJ_LOG_CONTAINER = 10;
const OBJ_CAN_MESSAGE2 = 86;
const OBJ_CAN_FD_MESSAGE = 100;
const OBJ_CAN_FD_MESSAGE_64 = 101;
const OBJ_CAN_ERROR_EXT = 73;

const ID_MASK = 0x1fffffff;
const ID_EXT_FLAG = 0x80000000;
const CANFD_EDL = 0x01;
const CANFD_BRS = 0x02;
const CANFD_ESI = 0x04;
const CAN_MSG_FLAG_TX = 0x01;

export async function parseBlf(buffer) {
  const store = new FrameStore();
  const r = new BinaryReader(buffer);
  if (r.fourcc() !== 'LOGG') throw new Error('Not a BLF file (missing LOGG signature)');
  const headerSize = r.u32();
  r.seek(40);
  const startEpoch = readSystemTime(r);
  if (startEpoch != null) store.t0Epoch = startEpoch;
  r.seek(headerSize || 144);

  const skipped = { types: new Map() };
  while (r.remaining >= 16) {
    const objStart = r.pos;
    if (r.fourcc() !== 'LOBJ') {
      // resync: scan forward for next LOBJ
      const next = findNext(r.bytes, objStart + 1);
      if (next < 0) break;
      r.seek(next);
      continue;
    }
    const baseHeaderSize = r.u16();
    r.u16(); // header version
    const objectSize = r.u32();
    const objectType = r.u32();
    const objEnd = objStart + objectSize;

    if (objectType === OBJ_LOG_CONTAINER) {
      // container header (16 bytes): method u16, 6 res, uncompressedSize u32, 4 res
      const method = r.u16();
      r.skip(6);
      const uncompressedSize = r.u32();
      r.skip(4);
      const payloadStart = objStart + 16 + 16;
      const payload = r.bytes.subarray(payloadStart, objEnd);
      let raw;
      if (method === 0) {
        raw = payload; // uncompressed
      } else {
        raw = await inflate(payload);
      }
      parseObjects(raw, store, skipped);
    } else {
      countSkip(skipped, objectType);
    }
    // advance to next object (4-byte aligned)
    r.seek(align4(objEnd));
    if (objEnd <= objStart) break; // guard against malformed size
  }
  store.blfSkipped = skipped.types;
  return store;
}

/** Parse a buffer of concatenated (uncompressed) message objects. */
function parseObjects(buffer, store, skipped) {
  const r = new BinaryReader(buffer);
  while (r.remaining >= 16) {
    const objStart = r.pos;
    if (r.fourcc() !== 'LOBJ') {
      const next = findNext(r.bytes, objStart + 1);
      if (next < 0) break;
      r.seek(next);
      continue;
    }
    r.u16(); // header size (base)
    r.u16(); // header version
    const objectSize = r.u32();
    const objectType = r.u32();
    const objEnd = objStart + objectSize;

    // object header v1: flags u32, clientIndex u16, version u16, timestamp u64
    const objFlags = r.u32();
    r.u16();
    r.u16();
    const tsRaw = r.u64();
    const tsSec = objFlags === 1 ? Number(tsRaw) * 1e-5 : Number(tsRaw) * 1e-9;

    switch (objectType) {
      case OBJ_CAN_MESSAGE:
      case OBJ_CAN_MESSAGE2:
        readCanMessage(r, store, tsSec);
        break;
      case OBJ_CAN_FD_MESSAGE:
        readCanFdMessage(r, store, tsSec);
        break;
      case OBJ_CAN_FD_MESSAGE_64:
        readCanFdMessage64(r, store, tsSec);
        break;
      case OBJ_CAN_ERROR:
      case OBJ_CAN_ERROR_EXT: {
        const ch = r.u16();
        store.add(tsSec, 0, false, ch, FrameFlags.ERR, null);
        break;
      }
      default:
        countSkip(skipped, objectType);
    }
    r.seek(align4(objEnd));
    if (objEnd <= objStart) break;
  }
}

function readCanMessage(r, store, tsSec) {
  const ch = r.u16();
  const flags = r.u8();
  const dlc = r.u8();
  const id = r.u32();
  const data = r.bytesOf(8).slice(0, Math.min(dlc, 8));
  let ff = 0;
  if (flags & CAN_MSG_FLAG_TX) ff |= FrameFlags.TX;
  if (flags & 0x80) ff |= FrameFlags.RTR;
  store.add(tsSec, id & ID_MASK, !!(id & ID_EXT_FLAG), ch, ff, data);
}

function readCanFdMessage(r, store, tsSec) {
  const ch = r.u16();
  const flags = r.u8();
  const dlc = r.u8();
  const id = r.u32();
  r.u32(); // frameLength
  r.u8(); // arbBitCount
  const canFdFlags = r.u8();
  const validDataBytes = r.u8();
  r.u8(); // reserved1
  r.u32(); // reserved2
  const data = r.bytesOf(64).slice(0, Math.min(validDataBytes, 64));
  let ff = FrameFlags.FD;
  if (flags & CAN_MSG_FLAG_TX) ff |= FrameFlags.TX;
  if (canFdFlags & CANFD_BRS) ff |= FrameFlags.BRS;
  if (canFdFlags & CANFD_ESI) ff |= FrameFlags.ESI;
  if (!(canFdFlags & CANFD_EDL)) ff &= ~FrameFlags.FD; // EDL clear => classic in FD object
  store.add(tsSec, id & ID_MASK, !!(id & ID_EXT_FLAG), ch, ff, data);
}

function readCanFdMessage64(r, store, tsSec) {
  const ch = r.u8();
  const dlc = r.u8();
  const validDataBytes = r.u8();
  r.u8(); // txCount
  const id = r.u32();
  r.u32(); // frameLength
  const flags = r.u32();
  r.u32(); // btrCfgArb
  r.u32(); // btrCfgData
  r.u32(); // timeOffsetBrsNs
  r.u32(); // timeOffsetCrcDelNs
  r.u16(); // bitCount
  const dir = r.u8();
  r.u8(); // extDataOffset
  r.u32(); // crc
  const data = r.bytesOf(Math.min(validDataBytes, 64));
  let ff = FrameFlags.FD;
  if (dir === 1) ff |= FrameFlags.TX;
  if (flags & 0x2000) ff |= FrameFlags.BRS;
  if (flags & 0x4000) ff |= FrameFlags.ESI;
  store.add(tsSec, id & ID_MASK, !!(id & ID_EXT_FLAG), ch, ff, data);
}

// SYSTEMTIME: year, month, dayOfWeek, day, hour, minute, second, ms (all u16,
// local time). Returns Unix seconds, or null if empty/invalid.
function readSystemTime(r) {
  const year = r.u16();
  const month = r.u16();
  r.u16(); // dayOfWeek
  const day = r.u16();
  const hour = r.u16();
  const min = r.u16();
  const sec = r.u16();
  const ms = r.u16();
  if (year < 1970 || year > 2200 || month < 1 || month > 12) return null;
  return new Date(year, month - 1, day, hour, min, sec, ms).getTime() / 1000;
}

function findNext(bytes, from) {
  for (let i = from; i < bytes.length - 4; i++) {
    if (bytes[i] === 0x4c && bytes[i + 1] === 0x4f && bytes[i + 2] === 0x42 && bytes[i + 3] === 0x4a) {
      return i;
    }
  }
  return -1;
}

function countSkip(skipped, type) {
  skipped.types.set(type, (skipped.types.get(type) || 0) + 1);
}

function align4(n) {
  return (n + 3) & ~3;
}

registerFormat({
  name: 'Vector BLF',
  extensions: ['blf'],
  sniff(head) {
    return head[0] === 0x4c && head[1] === 0x4f && head[2] === 0x47 && head[3] === 0x47; // "LOGG"
  },
  async read(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return parseBlf(buf);
  },
});
