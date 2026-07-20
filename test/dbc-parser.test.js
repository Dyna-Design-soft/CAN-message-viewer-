// DBC parser tests using test/fixtures/demo.dbc.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { parseDbc } from '../src/core/dbc-parser.js';
import { loadFixture } from './fixtures.js';

let cluster;
async function getCluster() {
  if (!cluster) cluster = parseDbc(await loadFixture('demo.dbc'), 'demo.dbc');
  return cluster;
}

test('parses cluster name and message count', async () => {
  const c = await getCluster();
  assertEqual(c.name, 'demo');
  assertEqual(c.messages.size, 4);
  assertEqual(c.parseErrors.length, 0);
});

test('parses standard and extended message ids', async () => {
  const c = await getCluster();
  const engine = c.messageById(256);
  assert(engine, 'EngineData found');
  assertEqual(engine.name, 'EngineData');
  assertEqual(engine.extended, false);
  assertEqual(engine.dlc, 8);

  const counter = [...c.messages.values()].find((m) => m.name === 'CounterMsg');
  assert(counter, 'CounterMsg found');
  assertEqual(counter.extended, true);
  assertEqual(counter.id, 0x1cff00ee);
});

test('parses signal geometry and scaling', async () => {
  const c = await getCluster();
  const engine = c.messageById(256);
  const rpm = engine.signals.find((s) => s.name === 'EngineSpeed');
  assertEqual(rpm.startBit, 0);
  assertEqual(rpm.bitLength, 16);
  assertEqual(rpm.byteOrder, 1);
  assertClose(rpm.factor, 0.25);
  assertEqual(rpm.unit, 'rpm');
});

test('parses GenSigStartValue default value', async () => {
  const c = await getCluster();
  const rpm = c.messageById(256).signals.find((s) => s.name === 'EngineSpeed');
  // BA_ set raw start value 3200 -> physical 3200 * 0.25 = 800
  assertEqual(rpm.startValue, 3200);
  assertClose(rpm.defaultValue, 800);
});

test('parses multi-line comment on signal', async () => {
  const c = await getCluster();
  const rpm = c.messageById(256).signals.find((s) => s.name === 'EngineSpeed');
  assert(rpm.comment.includes('crankshaft'), 'multi-line comment captured');
});

test('parses value table', async () => {
  const c = await getCluster();
  const sel = c.messageById(768).signals.find((s) => s.name === 'TempSelect');
  assert(sel.valueTable, 'value table present');
  assertEqual(sel.valueTable.get(0), 'Cabin');
  assertEqual(sel.valueTable.get(1), 'Ambient');
});

test('parses multiplexing roles', async () => {
  const c = await getCluster();
  const climate = c.messageById(768);
  assertEqual(climate.multiplexor.name, 'TempSelect');
  const cabin = climate.signals.find((s) => s.name === 'CabinTemp');
  assertEqual(cabin.muxRole, 'multiplexed');
  assertEqual(cabin.muxValue, 0);
});

test('collects errors but continues on malformed line', () => {
  const bad = `BO_ 100 Good: 8 ECU
 SG_ ValidSig : 0|8@1+ (1,0) [0|255] "" ECU
BO_ notanumber Broken: 8 ECU
BO_ 200 Another: 8 ECU
 SG_ S2 : 0|8@1+ (1,0) [0|255] "" ECU`;
  const c = parseDbc(bad, 'bad.dbc');
  assert(c.parseErrors.length >= 1, 'reported at least one error');
  assert(c.messageById(100), 'good message before error still parsed');
  assert(c.messageById(200), 'message after error still parsed');
});
