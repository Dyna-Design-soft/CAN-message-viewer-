// Raw CAN payload -> signal values.
//
// Bit addressing follows the DBC conventions:
//  - Intel (@1, little-endian): startBit is the position of the LSB; message
//    bit i lives at byte i>>3, bit i&7; significance grows upward.
//  - Motorola (@0, big-endian): startBit is the position of the MSB in
//    msb-first ("sawtooth") numbering; significance decreases within a byte
//    (bit 7 -> 0) and continues at bit 7 of the NEXT byte (+15 in raw bit
//    position). Getting this walk wrong is the classic CAN decoder bug — it is
//    pinned by golden-vector tests in test/.

const f64scratch = new DataView(new ArrayBuffer(8));

/**
 * Extract the raw (unscaled) value of a signal from a payload.
 * Returns a Number (safe: ≤ 52 significant bits handled via BigInt fallback,
 * result converted with Number()). Returns null if the payload is too short.
 */
export function extractRaw(data, signal) {
  const { startBit, bitLength, byteOrder, signed } = signal;

  // Bounds check: highest byte the signal touches.
  const lastBit =
    byteOrder === 1
      ? startBit + bitLength - 1
      : motorolaLastBit(startBit, bitLength);
  if (lastBit >> 3 >= data.length || lastBit < 0) return null;

  let raw;
  if (bitLength <= 32) {
    raw = extract32(data, startBit, bitLength, byteOrder);
    if (signed && bitLength < 32 && raw & (1 << (bitLength - 1))) {
      raw -= 1 << bitLength;
    } else if (signed && bitLength === 32 && raw & 0x80000000) {
      raw -= 0x100000000;
    } else {
      raw = raw >>> 0 === raw ? raw : raw >>> 0; // keep unsigned positive
    }
  } else {
    let big = extractBig(data, startBit, bitLength, byteOrder);
    if (signed && big & (1n << BigInt(bitLength - 1))) {
      big -= 1n << BigInt(bitLength);
    }
    raw = Number(big);
  }

  if (signal.isFloat) {
    // IEEE 754 stored in the extracted bit pattern.
    if (signal.isDouble || bitLength === 64) {
      const big = BigInt.asUintN(64, BigInt(raw < 0 ? raw + 2 ** 64 : raw));
      f64scratch.setBigUint64(0, big);
      return f64scratch.getFloat64(0);
    }
    f64scratch.setUint32(0, raw >>> 0);
    return f64scratch.getFloat32(0);
  }
  return raw;
}

function extract32(data, startBit, bitLength, byteOrder) {
  let value = 0;
  if (byteOrder === 1) {
    for (let i = 0; i < bitLength; i++) {
      const pos = startBit + i;
      value |= ((data[pos >> 3] >> (pos & 7)) & 1) << i;
    }
  } else {
    let pos = startBit;
    for (let i = 0; i < bitLength; i++) {
      value = (value << 1) | ((data[pos >> 3] >> (pos & 7)) & 1);
      pos = (pos & 7) === 0 ? pos + 15 : pos - 1;
    }
  }
  return value >>> 0;
}

function extractBig(data, startBit, bitLength, byteOrder) {
  let value = 0n;
  if (byteOrder === 1) {
    for (let i = 0; i < bitLength; i++) {
      const pos = startBit + i;
      if ((data[pos >> 3] >> (pos & 7)) & 1) value |= 1n << BigInt(i);
    }
  } else {
    let pos = startBit;
    for (let i = 0; i < bitLength; i++) {
      value = (value << 1n) | BigInt((data[pos >> 3] >> (pos & 7)) & 1);
      pos = (pos & 7) === 0 ? pos + 15 : pos - 1;
    }
  }
  return value;
}

function motorolaLastBit(startBit, bitLength) {
  let pos = startBit;
  for (let i = 1; i < bitLength; i++) pos = (pos & 7) === 0 ? pos + 15 : pos - 1;
  return pos;
}

/** raw -> physical engineering value. */
export function rawToPhysical(raw, signal) {
  return raw * signal.factor + signal.offset;
}

/**
 * Decode one signal from a payload to its physical value.
 * Handles multiplexing: returns null when the frame's selector value does not
 * match a multiplexed signal, or when the payload is too short.
 */
export function decodeSignal(data, signal) {
  if (signal.muxRole === 'multiplexed') {
    const mux = signal.message?.multiplexor;
    if (mux) {
      const sel = extractRaw(data, mux);
      if (sel === null || sel !== signal.muxValue) return null;
    }
  }
  const raw = extractRaw(data, signal);
  if (raw === null) return null;
  return rawToPhysical(raw, signal);
}

/** Value-table label for a physical value, or null. */
export function valueLabel(signal, physical) {
  if (!signal.valueTable) return null;
  // VAL_ tables are keyed by raw value.
  const raw = Math.round((physical - signal.offset) / signal.factor);
  return signal.valueTable.get(raw) ?? null;
}

/** Decode every signal of a message payload -> [{signal, raw, value}] (display use). */
export function decodeMessage(data, message) {
  const out = [];
  const mux = message.multiplexor;
  const sel = mux ? extractRaw(data, mux) : null;
  for (const signal of message.signals) {
    if (signal.muxRole === 'multiplexed' && sel !== signal.muxValue) continue;
    const raw = extractRaw(data, signal);
    if (raw === null) continue;
    out.push({ signal, raw, value: rawToPhysical(raw, signal) });
  }
  return out;
}
