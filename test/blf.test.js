// BLF writer -> reader round-trip (classic, extended, FD, error frames).

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { FrameStore, FrameFlags } from '../src/core/frame-store.js';
import { writeBlf } from '../src/io/blf-writer.js';
import { parseBlf } from '../src/io/blf-reader.js';

function makeStore() {
  const s = new FrameStore();
  s.t0Epoch = 1700000000;
  s.add(0.001, 0x100, false, 1, 0, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  s.add(0.002, 0x1cff00ee, true, 1, FrameFlags.TX, new Uint8Array([0xaa, 0xbb]));
  s.add(0.003, 0x200, false, 1, FrameFlags.FD | FrameFlags.BRS,
    new Uint8Array(Array.from({ length: 64 }, (_, i) => i)));
  s.add(0.004, 0, false, 1, FrameFlags.ERR, null);
  return s;
}

test('BLF round-trip preserves frame count and fields', async () => {
  const src = makeStore();
  const blf = await writeBlf(src);
  assertEqual(String.fromCharCode(blf[0], blf[1], blf[2], blf[3]), 'LOGG');
  const out = await parseBlf(blf);
  assertEqual(out.count, 4);

  // frame 0: classic
  assertEqual(out.rawId(0), 0x100);
  assertEqual(out.isExt(0), false);
  assertEqual(out.len[0], 8);
  assertEqual([...out.data(0)], [1, 2, 3, 4, 5, 6, 7, 8]);

  // frame 1: extended, TX, 2 bytes
  assertEqual(out.rawId(1), 0x1cff00ee);
  assertEqual(out.isExt(1), true);
  assert(out.flags[1] & FrameFlags.TX, 'TX preserved');
  assertEqual([...out.data(1)], [0xaa, 0xbb]);

  // frame 2: FD 64 bytes, BRS
  assert(out.flags[2] & FrameFlags.FD, 'FD flag preserved');
  assert(out.flags[2] & FrameFlags.BRS, 'BRS preserved');
  assertEqual(out.len[2], 64);
  assertEqual(out.data(2)[63], 63);

  // frame 3: error
  assert(out.flags[3] & FrameFlags.ERR, 'error frame preserved');
});

test('BLF round-trip preserves timestamps', async () => {
  const src = makeStore();
  const out = await parseBlf(await writeBlf(src));
  assertClose(out.t[0], 0.001, 1e-6);
  assertClose(out.t[2], 0.003, 1e-6);
});
