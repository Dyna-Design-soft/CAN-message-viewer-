// TDMS parser + NI-XNET mapper tests against a synthetic per-field fixture.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { parseTdmsChannels, tdmsToFrameStore } from '../src/io/tdms-reader.js';
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
