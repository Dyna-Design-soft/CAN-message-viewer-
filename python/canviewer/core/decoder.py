"""Raw CAN payload -> signal values. Port of the JS decoder.

Bit addressing:
 - Intel (@1): startBit is the LSB position; significance grows upward.
 - Motorola (@0): startBit is the MSB position in msb-first ("sawtooth")
   numbering; within a byte significance decreases (bit 7 -> 0) and continues
   at bit 7 of the next byte (+15 in raw bit position).
"""
from __future__ import annotations

import struct


def _motorola_last_bit(start_bit: int, bit_length: int) -> int:
    pos = start_bit
    for _ in range(1, bit_length):
        pos = pos + 15 if (pos & 7) == 0 else pos - 1
    return pos


def extract_raw(data: bytes, signal) -> int | float | None:
    start_bit = signal.start_bit
    bit_length = signal.bit_length
    byte_order = signal.byte_order
    signed = signal.signed

    last_bit = (start_bit + bit_length - 1) if byte_order == 1 else _motorola_last_bit(start_bit, bit_length)
    if last_bit < 0 or (last_bit >> 3) >= len(data):
        return None

    value = 0
    if byte_order == 1:  # Intel / little-endian
        for i in range(bit_length):
            pos = start_bit + i
            value |= ((data[pos >> 3] >> (pos & 7)) & 1) << i
    else:  # Motorola / big-endian sawtooth
        pos = start_bit
        for _ in range(bit_length):
            value = (value << 1) | ((data[pos >> 3] >> (pos & 7)) & 1)
            pos = pos + 15 if (pos & 7) == 0 else pos - 1

    if signal.is_float:
        if signal.is_double or bit_length == 64:
            return struct.unpack("<d", struct.pack("<Q", value & 0xFFFFFFFFFFFFFFFF))[0]
        return struct.unpack("<f", struct.pack("<I", value & 0xFFFFFFFF))[0]

    if signed and (value & (1 << (bit_length - 1))):
        value -= 1 << bit_length
    return value


def raw_to_physical(raw, signal) -> float:
    return raw * signal.factor + signal.offset


def decode_signal(data: bytes, signal):
    if signal.mux_role == "multiplexed":
        mux = signal.message.multiplexor if signal.message else None
        if mux is not None:
            sel = extract_raw(data, mux)
            if sel is None or sel != signal.mux_value:
                return None
    raw = extract_raw(data, signal)
    if raw is None:
        return None
    return raw_to_physical(raw, signal)


def value_label(signal, physical):
    """VAL_ enum/state label for a physical value, or None."""
    if not signal.value_table:
        return None
    raw = round((physical - signal.offset) / signal.factor)
    return signal.value_table.get(raw)


def decode_message(data: bytes, message):
    out = []
    mux = message.multiplexor
    sel = extract_raw(data, mux) if mux else None
    for signal in message.signals:
        if signal.mux_role == "multiplexed" and sel != signal.mux_value:
            continue
        raw = extract_raw(data, signal)
        if raw is None:
            continue
        out.append((signal, raw, raw_to_physical(raw, signal)))
    return out
