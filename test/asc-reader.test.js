// ASC reader tests + end-to-end decode against the DBC.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { parseAscText } from '../src/io/asc-reader.js';
import { parseDbc } from '../src/core/dbc-parser.js';
import { DbcRegistry } from '../src/core/dbc-model.js';
import { ChannelMap } from '../src/core/channel-map.js';
import { extractSeries } from '../src/core/signal-series.js';
import { loadFixture } from './fixtures.js';

async function load() {
  const asc = await loadFixture('demo.asc');
  const { store } = parseAscText(asc);
  const dbc = new DbcRegistry();
  dbc.add(parseDbc(await loadFixture('demo.dbc'), 'demo.dbc'));
  const map = new ChannelMap(dbc);
  return { store, dbc, map };
}

test('ASC parses frames of all types', async () => {
  const { store } = await load();
  // 3x EngineData(100), 1x error, 1x CounterMsg, 1x FD SensorArray, 1x Climate
  assertEqual(store.count, 7);
});

test('ASC parses extended id frame', async () => {
  const { store } = await load();
  let found = false;
  for (let i = 0; i < store.count; i++) {
    if (store.rawId(i) === 0x1cff00ee) {
      assert(store.isExt(i), 'counter frame is extended');
      found = true;
    }
  }
  assert(found, 'extended counter frame present');
});

test('ASC parses CAN FD 64-byte frame', async () => {
  const { store } = await load();
  let fdLen = 0;
  for (let i = 0; i < store.count; i++) {
    if (store.rawId(i) === 0x200) fdLen = store.len[i];
  }
  assertEqual(fdLen, 64);
});

test('ASC error frame flagged', async () => {
  const { store } = await load();
  const stats = store.computeStats();
  assertEqual(stats.errorFrames, 1);
});

test('end-to-end: decode EngineSpeed series from ASC via DBC', async () => {
  const { store, dbc, map } = await load();
  const rpm = dbc.signalByQualifiedName('demo/EngineData/EngineSpeed');
  const series = extractSeries(store, rpm, map);
  assertEqual(series.v.length, 3);
  // First frame bytes E0 2E -> 0x2EE0 = 12000 raw * 0.25 = 3000 rpm
  assertClose(series.v[0], 3000, 1e-6);
});

test('end-to-end: decode multiplexed CabinTemp', async () => {
  const { store, dbc, map } = await load();
  const cabin = dbc.signalByQualifiedName('demo/Climate/CabinTemp');
  const series = extractSeries(store, cabin, map);
  // Climate frame has selector 0 -> cabin present, raw 0x026C=620 -> 62-40=22
  assertEqual(series.v.length, 1);
  assertClose(series.v[0], 22.0, 1e-6);
});
