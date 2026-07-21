// NI TDMS reader for NI-XNET CAN frame logs.
//
// Two layers:
//  1. A generic TDMS parser (segments, lead-in, metadata, contiguous raw data)
//     producing named channels with typed-array data. Handles incremental
//     metadata (kTocNewObjList), the standard numeric types, strings and
//     NI timestamps. Interleaved and DAQmx raw data are not supported.
//  2. An NI-XNET mapper that builds a FrameStore. NI-XNET logs CAN to a single
//     u8 "raw frame" channel (identified by NI_network_* properties): a byte
//     stream of 24-byte-ish records — u64 timestamp (100 ns FILETIME), u32
//     identifier (bit 29 = extended), type, flags, info, payloadLen, payload.
//     A per-field channel layout (Timestamp/Identifier/DLC/bytes…) is also
//     supported as a fallback. If neither matches, an error lists the channel
//     names so the layout can be added — validated against a real capture.

import { BinaryReader } from '../util/binary.js';
import { FrameStore, FrameFlags } from '../core/frame-store.js';
import { registerFormat } from './format-registry.js';

const TOC = {
  META: 1 << 1,
  NEW_OBJ_LIST: 1 << 2,
  RAW_DATA: 1 << 3,
  INTERLEAVED: 1 << 5,
  BIG_ENDIAN: 1 << 6,
  DAQMX: 1 << 7,
};

const TYPE_SIZE = {
  1: 1, 2: 2, 3: 4, 4: 8, // i8..i64
  5: 1, 6: 2, 7: 4, 8: 8, // u8..u64
  9: 4, 10: 8, // f32,f64
  0x21: 1, // boolean
  0x44: 16, // timestamp
};
const NI_EPOCH_OFFSET = 2082844800; // seconds from 1904-01-01 to 1970-01-01

export function parseTdmsChannels(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const channels = new Map(); // path -> { name, group, type, chunks: [] }
  let activeOrder = []; // paths with raw data, in order (persists across segments)
  let pos = 0;

  while (pos + 28 <= bytes.length) {
    const r = new BinaryReader(bytes, pos);
    if (r.fourcc() !== 'TDSm') break;
    const toc = r.u32();
    if (toc & TOC.BIG_ENDIAN) throw new Error('Big-endian TDMS is not supported');
    if (toc & TOC.DAQMX) throw new Error('DAQmx raw data in TDMS is not supported');
    r.u32(); // version
    const nextSegOffset = Number(r.u64());
    const rawDataOffset = Number(r.u64());
    const leadInEnd = pos + 28;
    const metaEnd = leadInEnd + rawDataOffset;
    const nextSeg =
      nextSegOffset === -1 || nextSegOffset === 0xffffffffffffffff
        ? bytes.length
        : leadInEnd + nextSegOffset;

    const segChannels = []; // {path, type, numValues, isString}
    if (toc & TOC.META) {
      const m = new BinaryReader(bytes, leadInEnd);
      const numObjects = m.u32();
      if (toc & TOC.NEW_OBJ_LIST) activeOrder = [];
      for (let o = 0; o < numObjects; o++) {
        const pathLen = m.u32();
        const path = m.str(pathLen);
        const rawIdxLen = m.u32();
        let ch = channels.get(path);
        if (!ch) {
          const { group, name } = splitPath(path);
          ch = { name, group, path, type: null, chunks: [] };
          channels.set(path, ch);
        }
        if (rawIdxLen === 0xffffffff) {
          // no raw data for this object in this segment
        } else if (rawIdxLen === 0) {
          // reuse previous raw data index -> still an active channel
          if (ch.type != null) {
            if (!activeOrder.includes(path)) activeOrder.push(path);
          }
        } else {
          const dataType = m.u32();
          m.u32(); // array dimension
          const numValues = Number(m.u64());
          let strTotal = 0;
          if (dataType === 0x20) strTotal = Number(m.u64());
          ch.type = dataType;
          ch._numValues = numValues;
          ch._strTotal = strTotal;
          if (!activeOrder.includes(path)) activeOrder.push(path);
        }
        // properties
        const numProps = m.u32();
        for (let p = 0; p < numProps; p++) {
          const nameLen = m.u32();
          const pname = m.str(nameLen);
          const ptype = m.u32();
          const pval = readValue(m, ptype);
          ch[`prop:${pname}`] = pval;
        }
      }
      for (const path of activeOrder) {
        const ch = channels.get(path);
        segChannels.push({ path, type: ch.type, numValues: ch._numValues, strTotal: ch._strTotal });
      }
    } else {
      // no metadata: reuse active channels with their last-known counts
      for (const path of activeOrder) {
        const ch = channels.get(path);
        segChannels.push({ path, type: ch.type, numValues: ch._numValues, strTotal: ch._strTotal });
      }
    }

    if (toc & TOC.RAW_DATA && nextSeg > metaEnd) {
      if (toc & TOC.INTERLEAVED) throw new Error('Interleaved TDMS raw data is not supported');
      const rr = new BinaryReader(bytes, metaEnd, nextSeg - metaEnd);
      for (const sc of segChannels) {
        const ch = channels.get(sc.path);
        const arr = readChannelData(rr, sc.type, sc.numValues, sc.strTotal);
        ch.chunks.push(arr);
      }
    }

    if (nextSeg <= pos) break;
    pos = nextSeg;
  }

  // flatten chunks
  for (const ch of channels.values()) {
    ch.data = flattenChunks(ch.chunks, ch.type);
    delete ch.chunks;
  }
  return channels;
}

function readChannelData(r, type, numValues, strTotal) {
  if (type === 0x20) {
    // strings: numValues offsets (u32) then packed utf8
    const offsets = new Uint32Array(numValues);
    for (let i = 0; i < numValues; i++) offsets[i] = r.u32();
    const base = r.pos;
    const out = new Array(numValues);
    for (let i = 0; i < numValues; i++) {
      const start = i === 0 ? 0 : offsets[i - 1];
      const end = offsets[i];
      out[i] = new TextDecoder().decode(r.bytes.subarray(base + start, base + end));
    }
    r.skip(offsets[numValues - 1] || 0);
    return out;
  }
  const size = TYPE_SIZE[type];
  if (!size) throw new Error('Unsupported TDMS data type: ' + type);
  const out = allocTyped(type, numValues);
  for (let i = 0; i < numValues; i++) out[i] = readValueOfType(r, type);
  return out;
}

function readValueOfType(r, type) {
  switch (type) {
    case 1: return r.i8();
    case 2: return r.i16();
    case 3: return r.i32();
    case 4: return Number(r.u64BigSigned ? r.u64BigSigned() : BigInt.asIntN(64, r.u64()));
    case 5: return r.u8();
    case 6: return r.u16();
    case 7: return r.u32();
    case 8: return Number(r.u64());
    case 9: return r.f32();
    case 10: return r.f64();
    case 0x21: return r.u8();
    case 0x44: { // NI timestamp: u64 fractions, i64 seconds since 1904
      const frac = r.u64();
      const secs = BigInt.asIntN(64, r.u64());
      return Number(secs) - NI_EPOCH_OFFSET + Number(frac) / 2 ** 64;
    }
    default: throw new Error('Unsupported TDMS type ' + type);
  }
}

function readValue(r, type) {
  if (type === 0x20) {
    const len = r.u32();
    return r.str(len);
  }
  return readValueOfType(r, type);
}

function allocTyped(type, n) {
  switch (type) {
    case 1: return new Int8Array(n);
    case 2: return new Int16Array(n);
    case 3: return new Int32Array(n);
    case 5: case 0x21: return new Uint8Array(n);
    case 6: return new Uint16Array(n);
    case 7: return new Uint32Array(n);
    default: return new Float64Array(n);
  }
}

function flattenChunks(chunks, type) {
  if (chunks.length === 0) return type === 0x20 ? [] : allocTyped(type, 0);
  if (chunks.length === 1) return chunks[0];
  if (type === 0x20) return chunks.flat();
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = allocTyped(type, total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function splitPath(path) {
  // TDMS paths look like "/'Group'/'Channel'"
  const m = [...path.matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
  if (m.length >= 2) return { group: m[0], name: m[1] };
  if (m.length === 1) return { group: m[0], name: '' };
  return { group: '', name: path };
}

// ---- NI-XNET CAN mapper ----

const FILETIME_UNIX_OFFSET = 11644473600; // seconds between 1601-01-01 and 1970-01-01
const NIX_ID_MASK = 0x1fffffff;
const NIX_EXT_FLAG = 0x20000000;

/**
 * Decode an NI-XNET raw-frame byte stream (one u8 channel) into a FrameStore.
 * Record: u64 timestamp(100ns FILETIME) | u32 id(bit29=ext) | u8 type | u8 flags
 * | u8 info | u8 payloadLen | payload[payloadLen] padded to a multiple of 8
 * bytes so the following record stays 8-byte aligned. The header is already
 * 16 bytes (a multiple of 8), so the whole record is `16 + ceil(plen/8)*8`.
 */
export function decodeNixnetFrames(bytes) {
  const store = new FrameStore();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = bytes.length;
  let pos = 0;
  let t0 = null;
  while (pos + 16 <= n) {
    const ticks = Number(dv.getBigUint64(pos, true));
    const idRaw = dv.getUint32(pos + 8, true);
    const plen = bytes[pos + 15];
    const step = 16 + Math.ceil(plen / 8) * 8; // payload padded to 8-byte boundary
    if (pos + step > n) break;
    const sec = ticks / 1e7; // 100 ns ticks → seconds (since 1601)
    if (t0 === null) { t0 = sec; store.t0Epoch = sec - FILETIME_UNIX_OFFSET; }
    const data = bytes.subarray(pos + 16, pos + 16 + Math.min(plen, 64));
    // CAN classic caps at 8 data bytes; anything longer is a CAN FD frame.
    const flags = plen > 8 ? FrameFlags.FD : 0;
    store.add(sec - t0, idRaw & NIX_ID_MASK, !!(idRaw & NIX_EXT_FLAG), 1, flags, data);
    pos += step;
  }
  return store;
}

export function tdmsToFrameStore(channels) {
  const chans = [...channels.values()].filter((c) => c.data && c.data.length !== undefined);

  // NI-XNET raw-frame stream: a byte channel carrying NI_network_* properties.
  const nixnet = chans.find(
    (c) => c.data.length && Object.keys(c).some((k) => k.startsWith('prop:NI_network')),
  );
  if (nixnet) return decodeNixnetFrames(nixnet.data);
  const find = (...names) =>
    chans.find((c) => names.some((n) => c.name.toLowerCase().replace(/[\s_]/g, '').includes(n)));

  const tsCh = find('timestamp', 'time', 'abstime');
  const idCh = find('identifier', 'arbitrationid', 'canid', 'id');
  if (!tsCh || !idCh) {
    throw new Error(
      'TDMS: could not find NI-XNET CAN frame channels (need timestamp + identifier). ' +
        'Channels found: ' + chans.map((c) => `${c.group}/${c.name}`).join(', '),
    );
  }
  const extCh = find('extended', 'ide');
  const dlcCh = find('datalength', 'dlc', 'payloadlength');
  const typeCh = find('frametype', 'type');
  // payload: either a single "Data"/"Payload" byte channel per frame is not
  // typical; more commonly Byte0..ByteN columns.
  const byteChs = [];
  for (let i = 0; i < 64; i++) {
    const b = chans.find((c) => new RegExp(`(byte|data)\\s*${i}$`, 'i').test(c.name.trim()));
    if (b) byteChs.push(b);
  }
  const singlePayload = find('payload', 'data') && byteChs.length === 0 ? find('payload', 'data') : null;

  const store = new FrameStore();
  const n = tsCh.data.length;
  const t0 = tsCh.data[0] || 0;
  // If timestamps look like absolute NI/Unix seconds, store epoch and rebase.
  if (t0 > 1e9) store.t0Epoch = t0;
  for (let i = 0; i < n; i++) {
    const t = store.t0Epoch ? tsCh.data[i] - t0 : tsCh.data[i];
    const id = idCh.data[i] >>> 0;
    const ext = extCh ? !!extCh.data[i] : id > 0x7ff;
    const dlc = dlcCh ? dlcCh.data[i] : byteChs.length || 8;
    let flags = 0;
    if (typeCh && String(typeCh.data[i]).toLowerCase().includes('error')) flags |= FrameFlags.ERR;
    let data;
    if (byteChs.length) {
      const len = Math.min(dlc, byteChs.length);
      data = new Uint8Array(len);
      for (let b = 0; b < len; b++) data[b] = byteChs[b].data[i] & 0xff;
    } else if (singlePayload && Array.isArray(singlePayload.data)) {
      data = new Uint8Array(0); // unknown packing; skip payload
    } else {
      data = new Uint8Array(0);
    }
    store.add(t, id & 0x1fffffff, ext, 1, flags, data);
  }
  return store;
}

registerFormat({
  name: 'NI TDMS (XNET)',
  extensions: ['tdms'],
  sniff(head) {
    return head[0] === 0x54 && head[1] === 0x44 && head[2] === 0x53 && head[3] === 0x6d; // "TDSm"
  },
  async read(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const channels = parseTdmsChannels(buf);
    return tdmsToFrameStore(channels);
  },
});
