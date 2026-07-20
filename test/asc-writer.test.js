// ASC writer -> reader round-trip.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { FrameStore, FrameFlags } from '../src/core/frame-store.js';
import { writeAsc } from '../src/io/asc-writer.js';
import { parseAscText } from '../src/io/asc-reader.js';

test('ASC round-trip preserves frames', () => {
  const s = new FrameStore();
  s.add(0.010, 0x100, false, 1, 0, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  s.add(0.020, 0x1cff00ee, true, 1, 0, new Uint8Array([1, 2]));
  s.add(0.030, 0x200, false, 1, FrameFlags.FD | FrameFlags.BRS,
    new Uint8Array(Array.from({ length: 16 }, (_, i) => i + 1)));
  s.add(0.040, 0, false, 1, FrameFlags.ERR, null);

  const text = writeAsc(s);
  const { store: out } = parseAscText(text);
  assertEqual(out.count, 4);
  assertEqual(out.rawId(0), 0x100);
  assertEqual([...out.data(0)], [0xde, 0xad, 0xbe, 0xef]);
  assertEqual(out.rawId(1), 0x1cff00ee);
  assert(out.isExt(1), 'extended preserved');
  assert(out.flags[2] & FrameFlags.FD, 'FD preserved');
  assertEqual(out.len[2], 16);
  assertEqual(out.data(2)[15], 16);
  assert(out.flags[3] & FrameFlags.ERR, 'error preserved');
});
