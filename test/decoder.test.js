// Golden-vector tests for the bit-extraction / decode engine.
// These pin the Intel vs Motorola bit walk, sign handling, byte-crossing,
// 1-bit and 64-bit extraction, floats, and multiplexing.

import { test, assert, assertEqual, assertClose } from './test-runner.js';
import { extractRaw, decodeSignal, rawToPhysical } from '../src/core/decoder.js';
import { Signal, Message } from '../src/core/dbc-model.js';

const bytes = (...b) => new Uint8Array(b);

function sig(props) {
  return new Signal(props);
}

test('Intel u16 spanning bytes 0-1', () => {
  // 0x1234 little-endian -> byte0=0x34, byte1=0x12
  const s = sig({ startBit: 0, bitLength: 16, byteOrder: 1, signed: false });
  assertEqual(extractRaw(bytes(0x34, 0x12), s), 0x1234);
});

test('Intel u16 at bit offset 4 (crossing 3 bytes)', () => {
  // value occupies bits 4..19
  const s = sig({ startBit: 4, bitLength: 16, byteOrder: 1, signed: false });
  // put 0xABC across the nibble boundary: bits4..19 = 0x0ABC
  // byte0 low nibble unused=0, high nibble = C -> 0xC0
  // byte1 = AB -> 0xAB ... wait compute directly:
  const data = new Uint8Array(3);
  // set bits: value 0xABC = 0b1010_1011_1100 (12 bits) into bitLength 16 -> 0x0ABC
  const v = 0x0abc;
  for (let i = 0; i < 16; i++) if ((v >> i) & 1) data[(4 + i) >> 3] |= 1 << ((4 + i) & 7);
  assertEqual(extractRaw(data, s), v);
});

test('Intel signed 8-bit negative', () => {
  const s = sig({ startBit: 0, bitLength: 8, byteOrder: 1, signed: true });
  assertEqual(extractRaw(bytes(0xff), s), -1);
  assertEqual(extractRaw(bytes(0x80), s), -128);
  assertEqual(extractRaw(bytes(0x7f), s), 127);
});

test('single bit extraction', () => {
  const s = sig({ startBit: 3, bitLength: 1, byteOrder: 1, signed: false });
  assertEqual(extractRaw(bytes(0b0000_1000), s), 1);
  assertEqual(extractRaw(bytes(0b0000_0000), s), 0);
});

test('Motorola u16 (big-endian sawtooth)', () => {
  // DBC Motorola: startBit is MSB position. For a 16-bit signal starting at
  // bit 7 (MSB of byte0), the value is byte0<<8 | byte1.
  const s = sig({ startBit: 7, bitLength: 16, byteOrder: 0, signed: false });
  assertEqual(extractRaw(bytes(0x12, 0x34), s), 0x1234);
});

test('Motorola 12-bit crossing byte boundary', () => {
  // start MSB at bit 7 of byte0, length 12 -> byte0 (8 bits) + high nibble byte1
  const s = sig({ startBit: 7, bitLength: 12, byteOrder: 0, signed: false });
  // byte0 = 0xAB, byte1 high nibble = 0xC -> value 0xABC
  assertEqual(extractRaw(bytes(0xab, 0xc0), s), 0xabc);
});

test('Motorola startBit not on byte MSB', () => {
  // MotorolaDemo in demo.dbc: startBit 23, length 16. Bit 23 = MSB of byte2.
  // So it reads byte2<<8 | byte3.
  const s = sig({ startBit: 23, bitLength: 16, byteOrder: 0, signed: false });
  const data = bytes(0, 0, 0x0d, 0x11, 0, 0, 0, 0);
  assertEqual(extractRaw(data, s), 0x0d11);
});

test('64-bit unsigned via BigInt path', () => {
  const s = sig({ startBit: 0, bitLength: 64, byteOrder: 1, signed: false });
  const data = bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x1f, 0x00);
  // low 53 bits set -> 2^53 - 1 (still exactly representable)
  assertEqual(extractRaw(data, s), 0x1fffffffffffff);
});

test('factor/offset scaling', () => {
  const s = sig({ startBit: 32, bitLength: 8, byteOrder: 1, signed: false, factor: 1, offset: -40 });
  const raw = extractRaw(bytes(0, 0, 0, 0, 130), s);
  assertEqual(raw, 130);
  assertClose(rawToPhysical(raw, s), 90);
});

test('float32 signal', () => {
  const s = sig({ startBit: 0, bitLength: 32, byteOrder: 1, signed: false, isFloat: true });
  // 1.5f = 0x3FC00000 little-endian
  const data = bytes(0x00, 0x00, 0xc0, 0x3f);
  assertClose(extractRaw(data, s), 1.5, 1e-6);
});

test('out-of-range payload returns null', () => {
  const s = sig({ startBit: 0, bitLength: 16, byteOrder: 1, signed: false });
  assertEqual(extractRaw(bytes(0x00), s), null);
});

test('multiplexed signal selection', () => {
  const msg = new Message({ id: 768, extended: false, name: 'Climate', dlc: 4 });
  const selector = sig({ name: 'TempSelect', startBit: 0, bitLength: 8, byteOrder: 1, muxRole: 'multiplexor' });
  const cabin = sig({ name: 'CabinTemp', startBit: 8, bitLength: 16, byteOrder: 1, factor: 0.1, offset: -40, muxRole: 'multiplexed', muxValue: 0 });
  const ambient = sig({ name: 'AmbientTemp', startBit: 8, bitLength: 16, byteOrder: 1, factor: 0.1, offset: -40, muxRole: 'multiplexed', muxValue: 1 });
  for (const s of [selector, cabin, ambient]) s.message = msg;
  msg.signals = [selector, cabin, ambient];

  // selector = 0 -> cabin decodes, ambient is null
  const data0 = bytes(0, 0x6c, 0x02); // raw 0x026c = 620 -> 62.0 -40 = 22.0
  assertClose(decodeSignal(data0, cabin), 22.0, 1e-6);
  assertEqual(decodeSignal(data0, ambient), null);

  // selector = 1 -> ambient decodes, cabin is null
  const data1 = bytes(1, 0x6c, 0x02);
  assertClose(decodeSignal(data1, ambient), 22.0, 1e-6);
  assertEqual(decodeSignal(data1, cabin), null);
});
