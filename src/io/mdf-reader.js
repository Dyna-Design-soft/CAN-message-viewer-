// ASAM MDF v4 (.mf4/.mdf) reader — the dominant automotive measurement format
// (CANape, INCA/ETAS, Vector bus logging, PEAK). We read the CAN bus-logging
// layout: channel groups whose channels follow the standard "CAN_DataFrame"
// (and "CAN_ErrorFrame") naming, decoding each record into a FrameStore.
//
// Scope: sorted and unsorted data groups; uncompressed (##DT/##DV), compressed
// (##DZ, deflate, incl. transposed), and block lists (##DL/##HL). Generic
// signal decoding (non-bus MDF), array/VLSD channels and MDF3 are out of scope
// — those would surface as "no CAN frames found".

import { BinaryReader, inflate } from '../util/binary.js';
import { FrameStore, FrameFlags } from '../core/frame-store.js';
import { registerFormat } from './format-registry.js';

const TEXT = new TextDecoder();

/** Common v4 block header: id "##XY", length, link section. */
function readBlockHeader(bytes, offset) {
  const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = Number(dv.getBigUint64(offset + 8, true));
  const linkCount = Number(dv.getBigUint64(offset + 16, true));
  const links = new Array(linkCount);
  for (let i = 0; i < linkCount; i++) links[i] = Number(dv.getBigUint64(offset + 24 + i * 8, true));
  const dataStart = offset + 24 + linkCount * 8;
  return { id, length, linkCount, links, dataStart, end: offset + length };
}

function blockReaderAt(bytes, offset) {
  const h = readBlockHeader(bytes, offset);
  return { h, r: new BinaryReader(bytes, h.dataStart) };
}

/** UTF-8 text of a ##TX / ##MD block, or '' for a null link. */
function readText(bytes, offset) {
  if (!offset) return '';
  const h = readBlockHeader(bytes, offset);
  if (h.id !== '##TX' && h.id !== '##MD') return '';
  const raw = bytes.subarray(h.dataStart, h.end);
  return TEXT.decode(raw).replace(/\0.*$/s, '').trim();
}

/** Resolve a data-block reference (##DT/##DV/##DZ/##DL/##HL) to a byte array. */
async function readDataBlock(bytes, offset) {
  if (!offset) return new Uint8Array(0);
  const h = readBlockHeader(bytes, offset);
  switch (h.id) {
    case '##DT':
    case '##DV':
    case '##RD':
      return bytes.subarray(h.dataStart, h.end);
    case '##DZ':
      return inflateDz(bytes, h);
    case '##DL': {
      // Data list: concatenate all referenced blocks, following dl_dl_next.
      const parts = [];
      let cur = offset;
      while (cur) {
        const hh = readBlockHeader(bytes, cur);
        const r = new BinaryReader(bytes, hh.dataStart);
        r.u8(); r.skip(3); // dl_flags + reserved
        const count = r.u32();
        for (let i = 0; i < count; i++) parts.push(await readDataBlock(bytes, hh.links[1 + i]));
        cur = hh.links[0]; // dl_dl_next
      }
      return concat(parts);
    }
    case '##HL': {
      // Header list -> points at the first ##DL.
      return readDataBlock(bytes, h.links[0]);
    }
    default:
      return new Uint8Array(0);
  }
}

async function inflateDz(bytes, h) {
  const r = new BinaryReader(bytes, h.dataStart);
  r.skip(2); // dz_org_block_type (2 chars)
  const zipType = r.u8();
  r.u8(); // reserved
  const zipParam = r.u32();
  const orgLen = Number(r.u64());
  const dataLen = Number(r.u64());
  const comp = bytes.subarray(r.pos, r.pos + dataLen);
  let out = await inflate(comp);
  if (out.length !== orgLen) out = out.subarray(0, orgLen);
  if (zipType === 1) out = untranspose(out, zipParam, orgLen);
  return out;
}

/** Undo MDF column-wise transposition (zip_type 1). */
function untranspose(data, cols, orgLen) {
  if (!cols) return data;
  const rows = Math.floor(orgLen / cols);
  const out = new Uint8Array(orgLen);
  for (let c = 0; c < cols; c++) {
    for (let rrow = 0; rrow < rows; rrow++) {
      out[rrow * cols + c] = data[c * rows + rrow];
    }
  }
  const tail = rows * cols;
  if (tail < orgLen) out.set(data.subarray(tail), tail);
  return out;
}

function concat(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Parse a ##CN channel block at offset. */
function readChannel(bytes, offset) {
  const h = readBlockHeader(bytes, offset);
  const r = new BinaryReader(bytes, h.dataStart);
  const cn = {
    next: h.links[0],
    composition: h.links[1],
    txName: h.links[2],
    ccConversion: h.links[4],
    type: r.u8(),
    syncType: r.u8(),
    dataType: r.u8(),
    bitOffset: r.u8(),
    byteOffset: r.u32(),
    bitCount: r.u32(),
  };
  cn.name = readText(bytes, cn.txName);
  return cn;
}

/** Read a linear/identity conversion; returns {a,b} for phys = a + b*raw. */
function readConversion(bytes, offset) {
  if (!offset) return null;
  const h = readBlockHeader(bytes, offset);
  if (h.id !== '##CC') return null;
  const r = new BinaryReader(bytes, h.dataStart);
  const ccType = r.u8();
  r.u8(); r.u16(); // precision, flags
  r.u16(); // ref_count
  const valCount = r.u16();
  r.f64(); r.f64(); // phy range min/max
  const vals = [];
  for (let i = 0; i < valCount; i++) vals.push(r.f64());
  if (ccType === 0) return { a: 0, b: 1 }; // identity
  if (ccType === 1) return { a: vals[0] ?? 0, b: vals[1] ?? 1 }; // linear
  return null; // other conversions not needed for bus timestamps
}

/** Collect all channels of a CG (following cn_cn_next and cn_composition). */
function collectChannels(bytes, firstCn) {
  const list = [];
  const walk = (offset) => {
    let cur = offset;
    while (cur) {
      const cn = readChannel(bytes, cur);
      list.push(cn);
      if (cn.composition) {
        const ch = readBlockHeader(bytes, cn.composition);
        if (ch.id === '##CN') walk(cn.composition); // nested channels
        // ##CA (arrays) are not expanded — DataBytes is read as a byte array.
      }
      cur = cn.next;
    }
  };
  walk(firstCn);
  return list;
}

// Numeric field read from a record (byte-aligned little/big-endian ints & floats).
function readField(rec, base, cn) {
  const off = base + cn.byteOffset;
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const bits = cn.bitCount;
  const dt = cn.dataType;
  // IEEE float
  if (dt === 4) return bits === 32 ? dv.getFloat32(off, true) : dv.getFloat64(off, true);
  if (dt === 5) return bits === 32 ? dv.getFloat32(off, false) : dv.getFloat64(off, false);
  const le = dt === 0 || dt === 2;
  const signed = dt === 2 || dt === 3;
  const nbytes = Math.ceil(bits / 8);
  let v = 0n;
  for (let i = 0; i < nbytes; i++) {
    const b = BigInt(rec[off + (le ? i : nbytes - 1 - i)]);
    v |= b << BigInt(8 * i);
  }
  // mask to bit count and shift by intra-byte bit offset if any
  if (cn.bitOffset) v >>= BigInt(cn.bitOffset);
  if (bits % 8 !== 0) v &= (1n << BigInt(bits)) - 1n;
  if (signed && (v & (1n << BigInt(bits - 1)))) v -= 1n << BigInt(bits);
  return Number(v);
}

export async function parseMdf(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const idMagic = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (idMagic !== 'MDF' && idMagic !== 'UnF') throw new Error('Not an MDF file');

  const store = new FrameStore();
  // HD block sits right after the 64-byte ID block.
  const hd = blockReaderAt(bytes, 64);
  if (hd.h.id !== '##HD') throw new Error('MDF: missing HD block');
  const startNs = Number(hd.r.u64());
  if (startNs > 0) store.t0Epoch = startNs / 1e9;

  let dgOff = hd.h.links[0]; // hd_dg_first
  let total = 0;
  while (dgOff) {
    const dg = blockReaderAt(bytes, dgOff);
    const dgNext = dg.h.links[0];
    const cgFirst = dg.h.links[1];
    const dgData = dg.h.links[2];
    const recIdSize = dg.r.u8();

    // Gather channel groups in this data group.
    const groups = [];
    let cgOff = cgFirst;
    while (cgOff) {
      const cg = blockReaderAt(bytes, cgOff);
      const cgNext = cg.h.links[0];
      const cnFirst = cg.h.links[1];
      const acqName = readText(bytes, cg.h.links[2]);
      const recordId = Number(cg.r.u64());
      const cycleCount = Number(cg.r.u64());
      const cgFlags = cg.r.u16();
      cg.r.u16(); // path separator
      cg.r.u32(); // reserved
      const dataBytes = cg.r.u32();
      const invalBytes = cg.r.u32();
      const isVlsd = (cgFlags & 0x01) !== 0;
      const channels = isVlsd ? [] : collectChannels(bytes, cnFirst);
      groups.push({ recordId, cycleCount, dataBytes, invalBytes, recSize: dataBytes + invalBytes, channels, acqName, isVlsd });
      cgOff = cgNext;
    }

    const data = await readDataBlock(bytes, dgData);
    total += decodeDataGroup(bytes, store, data, groups, recIdSize);
    dgOff = dgNext;
  }

  if (total === 0) {
    throw new Error(
      'MDF: no CAN frames found. This reader supports CAN bus-logging files ' +
      '(CAN_DataFrame channels); generic signal MDF is not supported.',
    );
  }
  return store;
}

function classifyGroup(bytes, g) {
  const find = (suffix) => g.channels.find((c) => {
    const leaf = c.name.toLowerCase().split('.').pop();
    return leaf === suffix;
  });
  const master = g.channels.find((c) => c.type === 2 || c.type === 3) || find('t');
  const id = find('id');
  const dataBytes = g.channels.find((c) => /databytes$/i.test(c.name.split('.').pop()));
  const nameHasCan = g.acqName.toLowerCase().includes('can') ||
    g.channels.some((c) => c.name.toLowerCase().includes('can_'));
  const isError = /errorframe/i.test(g.acqName) ||
    g.channels.some((c) => /errorframe/i.test(c.name));
  if (!master || (!id && !isError)) return null;
  if (!nameHasCan && !id) return null;
  return {
    master, id, dataBytes,
    ide: find('ide'),
    dlc: find('dlc'),
    dataLength: find('datalength'),
    dir: find('dir'),
    fd: find('edl') || find('fdf'),
    brs: find('brs'),
    esi: find('esi'),
    bus: find('buschannel'),
    isError,
    masterConv: readConversion(bytes, master.ccConversion),
  };
}

function decodeDataGroup(bytes, store, data, groups, recIdSize) {
  // Map record id -> group for unsorted data groups.
  const byId = new Map();
  for (const g of groups) byId.set(g.recordId, g);
  // Precompute CAN classification per group.
  for (const g of groups) g._can = g.isVlsd ? null : classifyGroup(bytes, g);

  let added = 0;
  let pos = 0;
  const n = data.length;

  const readRecId = () => {
    let id = 0;
    for (let i = 0; i < recIdSize; i++) id += data[pos + i] * 2 ** (8 * i);
    pos += recIdSize;
    return id;
  };

  if (recIdSize === 0) {
    // Sorted: exactly one channel group; records are back to back.
    const g = groups[0];
    if (!g) return 0;
    for (let k = 0; k < g.cycleCount && pos + g.recSize <= n; k++) {
      added += emitRecord(store, data, pos, g);
      pos += g.recSize;
    }
    return added;
  }

  // Unsorted: each record is prefixed by its group's record id.
  while (pos + recIdSize <= n) {
    const rid = readRecId();
    const g = byId.get(rid);
    if (!g) break; // desync — stop rather than misread
    if (pos + g.recSize > n) break;
    added += emitRecord(store, data, pos, g);
    pos += g.recSize;
  }
  return added;
}

function emitRecord(store, data, base, g) {
  const can = g._can;
  if (!can) return 0;
  const rec = data;
  const tRaw = readField(rec, base, can.master);
  const t = can.masterConv ? can.masterConv.a + can.masterConv.b * tRaw : tRaw;

  if (can.isError && !can.id) {
    store.add(t, 0, false, can.bus ? readField(rec, base, can.bus) : 0, FrameFlags.ERR, null);
    return 1;
  }

  let idVal = readField(rec, base, can.id) >>> 0;
  let ext;
  if (can.ide) ext = readField(rec, base, can.ide) !== 0;
  else { ext = (idVal & 0x80000000) !== 0; idVal &= 0x1fffffff; }
  idVal &= 0x1fffffff;

  const ch = can.bus ? readField(rec, base, can.bus) : 0;
  let flags = 0;
  if (can.isError) flags |= FrameFlags.ERR;
  if (can.fd && readField(rec, base, can.fd)) flags |= FrameFlags.FD;
  if (can.brs && readField(rec, base, can.brs)) flags |= FrameFlags.BRS;
  if (can.esi && readField(rec, base, can.esi)) flags |= FrameFlags.ESI;
  if (can.dir && readField(rec, base, can.dir)) flags |= FrameFlags.TX;

  // Actual payload length: DataLength if present, else DLC, else DataBytes width.
  let len;
  if (can.dataLength) len = readField(rec, base, can.dataLength);
  else if (can.dlc) len = readField(rec, base, can.dlc);
  else len = can.dataBytes ? can.dataBytes.bitCount / 8 : 0;
  len = Math.max(0, Math.min(64, len | 0));

  let payload = null;
  if (can.dataBytes) {
    const off = base + can.dataBytes.byteOffset;
    const width = can.dataBytes.bitCount / 8;
    payload = data.subarray(off, off + Math.min(len, width));
  }
  store.add(t, idVal, ext, ch, flags, payload);
  return 1;
}

registerFormat({
  name: 'ASAM MDF v4 (MF4)',
  extensions: ['mf4', 'mdf'],
  sniff(head) {
    // "MDF     " (finalized) or "UnFinMF " (unfinalized) at offset 0.
    return head[0] === 0x4d && head[1] === 0x44 && head[2] === 0x46;
  },
  async read(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    return parseMdf(buf);
  },
});
