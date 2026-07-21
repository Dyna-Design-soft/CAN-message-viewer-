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

// Object types whose objectSize is exact and can be trusted for advancing.
// (Other types — app-text, system variables, etc. — report unreliable sizes.)
const RELIABLE_TYPES = new Set([
  OBJ_CAN_MESSAGE, OBJ_CAN_ERROR, OBJ_LOG_CONTAINER, OBJ_CAN_ERROR_EXT,
  OBJ_CAN_MESSAGE2, OBJ_CAN_FD_MESSAGE, OBJ_CAN_FD_MESSAGE_64,
]);

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
  // Inflate every LOG_CONTAINER and concatenate: the uncompressed object stream
  // is chopped into containers at arbitrary byte boundaries, so a single object
  // can straddle two containers. We must parse objects over the *joined* stream,
  // not per-container.
  const chunks = [];
  let total = 0;
  while (r.remaining >= 16) {
    const objStart = r.pos;
    if (r.fourcc() !== 'LOBJ') {
      const next = findNext(r.bytes, objStart + 1);
      if (next < 0) break;
      r.seek(next);
      continue;
    }
    r.u16(); // base header size
    r.u16(); // header version
    const objectSize = r.u32();
    const objectType = r.u32();
    const objEnd = objStart + objectSize;
    if (objEnd <= objStart || objEnd > r.bytes.length) break; // malformed/truncated

    if (objectType === OBJ_LOG_CONTAINER) {
      const method = r.u16();
      r.skip(6);
      r.u32(); // uncompressed size (per container) — not needed
      r.skip(4);
      const payload = r.bytes.subarray(objStart + 32, objEnd);
      const raw = method === 0 ? payload : await inflate(payload);
      chunks.push(raw);
      total += raw.length;
    } else {
      countSkip(skipped, objectType);
    }
    r.seek(align4(objEnd));
  }

  let joined;
  if (chunks.length === 1) {
    joined = chunks[0];
  } else {
    joined = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { joined.set(c, o); o += c.length; }
  }
  parseObjects(joined, store, skipped);
  store.blfSkipped = skipped.types;
  return store;
}

/** Parse a buffer of concatenated (uncompressed) message objects. */
function parseObjects(buffer, store, skipped) {
  const r = new BinaryReader(buffer);
  const bytes = r.bytes;
  const end = r.end;
  const view = r.view;
  let pos = 0;
  while (pos + 16 <= end) {
    if (!isLobjAt(bytes, pos)) { pos = scanValidLobj(bytes, view, pos + 1, end); continue; }
    const objStart = pos;
    const headerSize = bytes[objStart + 4] | (bytes[objStart + 5] << 8);
    const objectSize = view.getUint32(objStart + 8, true);
    const objectType = view.getUint32(objStart + 12, true);
    const objEnd = objStart + objectSize;
    // Reject an implausible header (e.g. a false LOBJ inside payload data).
    if (!(headerSize === 16 || headerSize === 32) || objectSize < 16 || objEnd > end) {
      pos = scanValidLobj(bytes, view, objStart + 4, end);
      continue;
    }

    // object header v1 (present when headerSize === 32): flags u32, clientIndex
    // u16, objectVersion u16, timestamp u64. Body starts right after it.
    if (headerSize === 32) {
      r.seek(objStart + 16);
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
          if (sane(tsSec, ch)) store.add(tsSec, 0, false, ch, FrameFlags.ERR, null);
          break;
        }
        default:
          countSkip(skipped, objectType);
      }
    } else {
      countSkip(skipped, objectType);
    }

    // Advance to the next object. CAN message/error/container objects have exact,
    // reliable objectSizes → jump to objEnd and snap to the next LOBJ within the
    // small padding window. App-text/unknown objects (e.g. type 72) report an
    // unreliable objectSize (seen both under- and over-stated), but their payload
    // is text and never contains the "LOBJ" signature — so find the next object
    // by scanning for LOBJ right after this object's 32-byte header.
    if (RELIABLE_TYPES.has(objectType)) {
      pos = nextObject(bytes, view, objEnd, end);
    } else {
      pos = scanValidLobj(bytes, view, objStart + 32, end);
    }
  }
}

// A real CAN frame has a small channel number and a timestamp in the
// seconds-to-hours range. These bounds reject the rare garbage frame that a
// resync can still produce (a false object that happens to pass structural
// validation), so it never pollutes channels/duration/per-ID. 48 h is far
// beyond any realistic single measurement file.
const MAX_TS_SEC = 48 * 3600;
function sane(tsSec, ch) {
  return ch <= 63 && tsSec >= 0 && tsSec < MAX_TS_SEC;
}

function readCanMessage(r, store, tsSec) {
  const ch = r.u16();
  const flags = r.u8();
  const dlc = r.u8();
  const id = r.u32();
  const data = r.bytesOf(8).slice(0, Math.min(dlc, 8));
  if (!sane(tsSec, ch)) return;
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
  if (!sane(tsSec, ch)) return;
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
  if (!sane(tsSec, ch)) return;
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

function isLobjAt(bytes, o) {
  return bytes[o] === 0x4c && bytes[o + 1] === 0x4f && bytes[o + 2] === 0x42 && bytes[o + 3] === 0x4a;
}

/** A LOBJ at `o` with a structurally plausible header. */
function plausibleObject(bytes, view, o, end) {
  if (o + 16 > end || !isLobjAt(bytes, o)) return false;
  const hs = bytes[o + 4] | (bytes[o + 5] << 8);
  const size = view.getUint32(o + 8, true);
  return (hs === 16 || hs === 32) && size >= 16 && o + size <= end;
}

/**
 * Next object after one ending at `objEnd`. Fast path: an object begins exactly
 * at objEnd (4-byte padded, the common case). Otherwise fall back to a validating
 * scan, since padding varies and CAN payloads can contain false "LOBJ" bytes.
 */
function nextObject(bytes, view, objEnd, end) {
  if (objEnd >= end) return end;
  if (plausibleObject(bytes, view, objEnd, end)) return objEnd;
  return scanValidLobj(bytes, view, objEnd + 1, end);
}

/**
 * Scan for the next real object start. Rejects false "LOBJ" signatures that
 * appear inside payload data by requiring the candidate to have a plausible
 * header AND to be followed by another plausible object (two-object
 * confirmation) — this is what keeps a desync from injecting garbage frames.
 */
function scanValidLobj(bytes, view, from, end) {
  for (let o = from; o + 16 <= end; o++) {
    if (!plausibleObject(bytes, view, o, end)) continue;
    const size = view.getUint32(o + 8, true);
    let nx = o + size;
    if (nx === end) return o;
    // the successor may be a few padding bytes further along
    let steps = 0;
    while (nx + 4 <= end && !isLobjAt(bytes, nx) && steps < 32) { nx++; steps++; }
    if (nx >= end || plausibleObject(bytes, view, nx, end)) return o;
  }
  return end;
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
