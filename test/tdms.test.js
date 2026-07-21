// TDMS parser + NI-XNET mapper tests against a synthetic per-field fixture.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { parseTdmsChannels, tdmsToFrameStore, decodeNixnetFrames } from '../src/io/tdms-reader.js';
import { loadFixtureBytes } from './fixtures.js';

async function load() {
  const buf = await loadFixtureBytes('demo.tdms');
  return parseTdmsChannels(buf);
}

test('TDMS parses channels and values', async () => {
  const ch = await load();
  const ts = [...ch.values()].find((c) => c.name === 'Timestamp');
  const id = [...ch.values()].find((c) => c.name === 'Identifier');
  assert(ts, 'Timestamp channel');
  assertEqual(ts.data.length, 5);
  assertClose(ts.data[1], 0.001);
  assertEqual(id.data[2], 0x1cff00ee);
});

test('TDMS maps to FrameStore with correct frames', async () => {
  const store = tdmsToFrameStore(await load());
  assertEqual(store.count, 5);
  assertEqual(store.rawId(0), 0x100);
  assertEqual(store.rawId(2), 0x1cff00ee);
  assert(store.isExt(2), 'extended id flagged');
  assertEqual(store.len[0], 8);
  assertEqual(store.len[4], 4);
  // byte0/byte1 of first frame = E0 2E (EngineSpeed raw 0x2EE0)
  assertEqual([...store.data(0).slice(0, 2)], [0xe0, 0x2e]);
});

test('NI-XNET raw-frame stream: payload padded to 8-byte boundary', () => {
  // Build a raw NI-XNET frame stream by hand. Each record is a 16-byte header
  // (u64 100ns FILETIME ts | u32 id(bit29=ext) | type,flags,info | u8 plen)
  // followed by the payload padded up to a multiple of 8 bytes. A frame with
  // a 12-byte payload therefore occupies 16 + 16 = 32 bytes, and the reader
  // must skip the 4 pad bytes to stay aligned on the next record (the bug that
  // previously desynced the whole stream after the first long frame).
  const FILETIME = 11644473600; // s between 1601 and 1970 epochs
  const recs = [
    { ticks: 10_000_000n, id: 0x100, ext: false, payload: [1, 2, 3, 4, 5, 6, 7, 8] },
    { ticks: 20_000_000n, id: 0x18feca03, ext: true, payload: [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21] },
    { ticks: 30_000_000n, id: 0x200, ext: false, payload: [0xaa, 0xbb] },
  ];
  const size = recs.reduce((s, r) => s + 16 + Math.ceil(r.payload.length / 8) * 8, 0);
  const bytes = new Uint8Array(size);
  const dv = new DataView(bytes.buffer);
  let p = 0;
  for (const r of recs) {
    dv.setBigUint64(p, r.ticks, true);
    dv.setUint32(p + 8, (r.id >>> 0) | (r.ext ? 0x20000000 : 0), true);
    bytes[p + 15] = r.payload.length;
    bytes.set(r.payload, p + 16);
    p += 16 + Math.ceil(r.payload.length / 8) * 8;
  }
  const store = decodeNixnetFrames(bytes);
  assertEqual(store.count, 3);
  assertEqual(store.rawId(0), 0x100);
  assert(!store.isExt(0), 'frame 0 standard');
  assertEqual(store.rawId(1), 0x18feca03);
  assert(store.isExt(1), 'frame 1 extended');
  assertEqual(store.rawId(2), 0x200); // stays aligned after the padded long frame
  assertEqual(store.len[1], 12);
  assertEqual([...store.data(1)], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
  assertEqual([...store.data(2)], [0xaa, 0xbb]);
  // timestamps rebased to first frame; epoch captured for wall-clock display
  assertClose(store.t[0], 0);
  assertClose(store.t[1], 1);
  assertClose(store.t[2], 2);
  assertClose(store.t0Epoch, 1 - FILETIME); // 10_000_000 ticks = 1s past 1601 epoch
});
