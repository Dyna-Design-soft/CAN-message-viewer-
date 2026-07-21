// MDF v4 (MF4) reader test. Builds a minimal, sorted, uncompressed bus-logging
// file (one CAN_DataFrame channel group, three records) entirely in-code and
// asserts the decoded FrameStore — validating block walking, CN parsing,
// record extraction and CAN frame mapping.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { parseMdf } from '../src/io/mdf-reader.js';

// ---- tiny MDF v4 block builder ----
// Blocks are declared with symbolic link targets; offsets (from 64, after the
// ID block) are assigned in a first pass, then serialized with resolved links.
function buildMf4(records, channels, cycleCount, recSize) {
  const blocks = [];
  const add = (name, id, links, data) => { blocks.push({ name, id, links, data }); return name; };
  const enc = (s) => { const b = new TextEncoder().encode(s + '\0'); const pad = (8 - (b.length % 8)) % 8; const o = new Uint8Array(b.length + pad); o.set(b); return o; };

  // Data (DT) block
  const dt = new Uint8Array(Math.ceil((cycleCount * recSize) / 8) * 8);
  dt.set(records);
  add('DT', '##DT', [], dt);

  // TX name blocks + CN channel blocks (linked list)
  const cnNames = channels.map((c, i) => add('TX_' + i, '##TX', [], enc(c.name)));
  channels.forEach((c, i) => {
    const d = new Uint8Array(64); // 16 fixed bytes + padding for the f64 range fields
    const dv = new DataView(d.buffer);
    dv.setUint8(0, c.type || 0);
    dv.setUint8(1, c.sync || 0);
    dv.setUint8(2, c.dataType);
    dv.setUint8(3, c.bitOffset || 0);
    dv.setUint32(4, c.byteOffset, true);
    dv.setUint32(8, c.bitCount, true);
    const next = i + 1 < channels.length ? 'CN_' + (i + 1) : 0;
    add('CN_' + i, '##CN', [next, 0, cnNames[i], 0, 0, 0, 0, 0], d);
  });

  add('TXacq', '##TX', [], enc('CAN_DataFrame'));

  // CG block
  const cgData = new Uint8Array(32);
  const cgv = new DataView(cgData.buffer);
  cgv.setBigUint64(0, 0n, true); // record id
  cgv.setBigUint64(8, BigInt(cycleCount), true);
  cgv.setUint32(24, recSize, true); // data bytes
  cgv.setUint32(28, 0, true); // inval bytes
  // CG links: [cg_next, cn_first, cg_tx_acq_name, cg_si_acq_source, cg_sr_first, cg_md_comment]
  add('CG', '##CG', [0, 'CN_0', 'TXacq', 0, 0, 0], cgData);

  // DG block
  const dgData = new Uint8Array(8); // rec_id_size=0 + reserved
  add('DG', '##DG', [0, 'CG', 'DT', 0], dgData);

  // HD block (start time 0)
  const hdData = new Uint8Array(32);
  add('HD', '##HD', ['DG', 0, 0, 0, 0, 0], hdData);

  // ---- assign offsets (ID block is 64 bytes, blocks follow) ----
  // Order in file: HD first (parser reads HD at 64), then the rest.
  const order = ['HD', 'DG', 'CG', 'TXacq', ...channels.map((_, i) => 'CN_' + i), ...channels.map((_, i) => 'TX_' + i), 'DT'];
  const byName = new Map(blocks.map((b) => [b.name, b]));
  const sizeOf = (b) => { const s = 24 + b.links.length * 8 + b.data.length; return Math.ceil(s / 8) * 8; };
  const offset = new Map();
  let pos = 64;
  for (const name of order) { offset.set(name, pos); pos += sizeOf(byName.get(name)); }

  const out = new Uint8Array(pos);
  const dv = new DataView(out.buffer);
  // ID block
  out.set(new TextEncoder().encode('MDF     '), 0);
  out.set(new TextEncoder().encode('4.10    '), 8);
  dv.setUint16(28, 410, true);
  for (const name of order) {
    const b = byName.get(name);
    const o = offset.get(name);
    out.set(new TextEncoder().encode(b.id), o);
    dv.setBigUint64(o + 8, BigInt(sizeOf(b)), true);
    dv.setBigUint64(o + 16, BigInt(b.links.length), true);
    b.links.forEach((lk, i) => dv.setBigUint64(o + 24 + i * 8, BigInt(lk ? offset.get(lk) : 0), true));
    out.set(b.data, o + 24 + b.links.length * 8);
  }
  return out;
}

function buildRecords() {
  // Layout: t(f64)@0, ID(u32)@8, IDE(u8)@12, DLC(u8)@13, DataLength(u8)@14, DataBytes[8]@15
  const recSize = 23;
  const recs = [
    { t: 0.0, id: 0x100, ide: 0, dlc: 8, len: 8, data: [1, 2, 3, 4, 5, 6, 7, 8] },
    { t: 0.01, id: 0x1cff00ee, ide: 1, dlc: 8, len: 8, data: [9, 10, 11, 12, 13, 14, 15, 16] },
    { t: 0.02, id: 0x200, ide: 0, dlc: 4, len: 4, data: [0xaa, 0xbb, 0xcc, 0xdd, 0, 0, 0, 0] },
  ];
  const buf = new Uint8Array(recs.length * recSize);
  const dv = new DataView(buf.buffer);
  recs.forEach((r, i) => {
    const o = i * recSize;
    dv.setFloat64(o, r.t, true);
    dv.setUint32(o + 8, r.id, true);
    buf[o + 12] = r.ide;
    buf[o + 13] = r.dlc;
    buf[o + 14] = r.len;
    buf.set(r.data, o + 15);
  });
  return { buf, recSize, recs };
}

const CHANNELS = [
  { name: 't', type: 2, sync: 1, dataType: 4, byteOffset: 0, bitCount: 64 },
  { name: 'CAN_DataFrame.ID', dataType: 0, byteOffset: 8, bitCount: 32 },
  { name: 'CAN_DataFrame.IDE', dataType: 0, byteOffset: 12, bitCount: 8 },
  { name: 'CAN_DataFrame.DLC', dataType: 0, byteOffset: 13, bitCount: 8 },
  { name: 'CAN_DataFrame.DataLength', dataType: 0, byteOffset: 14, bitCount: 8 },
  { name: 'CAN_DataFrame.DataBytes', dataType: 10, byteOffset: 15, bitCount: 64 },
];

test('MF4 sniffs and parses a CAN bus-logging file', async () => {
  const { buf, recSize } = buildRecords();
  const file = buildMf4(buf, CHANNELS, 3, recSize);
  assertEqual(String.fromCharCode(file[0], file[1], file[2]), 'MDF');
  const store = await parseMdf(file);
  assertEqual(store.count, 3);
});

test('MF4 decodes id/ext/len/data and timestamps', async () => {
  const { buf, recSize, recs } = buildRecords();
  const store = await parseMdf(buildMf4(buf, CHANNELS, 3, recSize));
  assertEqual(store.rawId(0), 0x100);
  assert(!store.isExt(0), 'frame 0 standard');
  assertEqual(store.rawId(1), 0x1cff00ee);
  assert(store.isExt(1), 'frame 1 extended');
  assertEqual(store.len[2], 4);
  assertEqual([...store.data(0)], recs[0].data);
  assertEqual([...store.data(2)], [0xaa, 0xbb, 0xcc, 0xdd]);
  assertClose(store.t[1], 0.01);
  assertClose(store.t[2], 0.02);
});
