// Frame extraction (range / snapshot) + TDMS writer↔reader round-trip.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { FrameStore, FrameFlags } from '../src/core/frame-store.js';
import { extractRange, extractSnapshot } from '../src/io/frame-export.js';
import { writeTdms } from '../src/io/tdms-writer.js';
import { parseTdmsChannels, tdmsToFrameStore } from '../src/io/tdms-reader.js';

function sampleStore() {
  const s = new FrameStore();
  s.t0Epoch = 1_700_000_000; // arbitrary wall-clock base
  s.add(0.00, 0x100, false, 1, 0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  s.add(0.01, 0x1abcdef, true, 1, 0, new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16]));
  s.add(0.02, 0x200, false, 1, FrameFlags.FD, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  s.add(0.03, 0x300, false, 1, 0, new Uint8Array([0xaa, 0xbb, 0xcc]));
  return s;
}

test('extractRange keeps only frames inside the window', () => {
  const out = extractRange(sampleStore(), 0.01, 0.02);
  assertEqual(out.count, 2);
  assertEqual(out.rawId(0), 0x1abcdef);
  assertEqual(out.rawId(1), 0x200);
});

test('extractSnapshot keeps the latest frame per id at/before t', () => {
  const out = extractSnapshot(sampleStore(), 0.025);
  // 0x100@0, 0x1abcdef@0.01, 0x200@0.02 present; 0x300@0.03 excluded
  assertEqual(out.count, 3);
  const ids = new Set();
  for (let i = 0; i < out.count; i++) ids.add(out.rawId(i));
  assert(ids.has(0x100) && ids.has(0x1abcdef) && ids.has(0x200), 'has the three latest');
  assert(!ids.has(0x300), '0x300 is after t');
});

test('TDMS writer round-trips through the reader', () => {
  const src = sampleStore();
  const bytes = writeTdms(src);
  assertEqual(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]), 'TDSm');
  const store = tdmsToFrameStore(parseTdmsChannels(bytes));
  assertEqual(store.count, 4);
  assertEqual(store.rawId(0), 0x100);
  assertEqual(store.rawId(1), 0x1abcdef);
  assert(store.isExt(1), 'extended id preserved');
  assertEqual(store.len[2], 12);
  assert((store.flags[2] & FrameFlags.FD) !== 0, 'FD flagged from payload > 8');
  assertEqual([...store.data(3)], [0xaa, 0xbb, 0xcc]);
  // timestamps rebased to the first frame (reader convention). Tolerance is
  // ~µs: the TDMS format stores absolute 100 ns FILETIME ticks, so at a
  // real-world epoch the read-back loses sub-µs precision (inherent, not a bug).
  assertClose(store.t[1], 0.01, 1e-5);
  assertClose(store.t[3], 0.03, 1e-5);
});
