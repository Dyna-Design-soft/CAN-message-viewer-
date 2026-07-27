"""Synthetic MF4 round-trip: build a minimal sorted, uncompressed CAN
bus-logging file in-code and assert the decoded frames (mirrors the JS test)."""
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from canviewer.io.mdf_reader import parse_mdf

CHANNELS = [
    dict(name="t", type=2, dt=4, bo=0, bits=64),
    dict(name="CAN_DataFrame.ID", type=0, dt=0, bo=8, bits=32),
    dict(name="CAN_DataFrame.IDE", type=0, dt=0, bo=12, bits=8),
    dict(name="CAN_DataFrame.DLC", type=0, dt=0, bo=13, bits=8),
    dict(name="CAN_DataFrame.DataLength", type=0, dt=0, bo=14, bits=8),
    dict(name="CAN_DataFrame.DataBytes", type=0, dt=10, bo=15, bits=64),
]
REC = 23


def _enc(s):
    b = s.encode() + b"\x00"
    return b + b"\x00" * ((8 - len(b) % 8) % 8)


def build_mf4(records):
    blocks = {}
    order = []

    def add(name, ident, links, data):
        blocks[name] = dict(id=ident, links=links, data=data)
        order.append(name)

    # channels + their name blocks
    for i, c in enumerate(CHANNELS):
        d = bytearray(64)
        d[0] = c["type"]
        d[2] = c["dt"]
        struct.pack_into("<I", d, 4, c["bo"])
        struct.pack_into("<I", d, 8, c["bits"])
        nxt = f"CN{i+1}" if i + 1 < len(CHANNELS) else 0
        add(f"CN{i}", "##CN", [nxt, 0, f"TX{i}", 0, 0, 0, 0, 0], bytes(d))
    for i, c in enumerate(CHANNELS):
        add(f"TX{i}", "##TX", [], _enc(c["name"]))
    add("TXacq", "##TX", [], _enc("CAN_DataFrame"))

    cg = bytearray(32)
    struct.pack_into("<Q", cg, 8, len(records))  # cycle count
    struct.pack_into("<I", cg, 24, REC)          # data bytes
    add("CG", "##CG", [0, "CN0", "TXacq", 0, 0, 0], bytes(cg))
    add("DG", "##DG", [0, "CG", "DT", 0], bytes(8))
    add("HD", "##HD", ["DG", 0, 0, 0, 0, 0], bytes(32))

    dt = bytearray(((len(records) * REC + 7) // 8) * 8)
    for i, r in enumerate(records):
        o = i * REC
        struct.pack_into("<d", dt, o, r["t"])
        struct.pack_into("<I", dt, o + 8, r["id"])
        dt[o + 12] = r["ide"]
        dt[o + 13] = r["len"]
        dt[o + 14] = r["len"]
        dt[o + 15:o + 15 + len(r["data"])] = bytes(r["data"])
    add("DT", "##DT", [], bytes(dt))

    layout = ["HD", "DG", "CG", "TXacq"] + [f"CN{i}" for i in range(len(CHANNELS))] + \
             [f"TX{i}" for i in range(len(CHANNELS))] + ["DT"]
    size = {n: ((24 + len(blocks[n]["links"]) * 8 + len(blocks[n]["data"])) + 7) // 8 * 8 for n in layout}
    offset = {}
    pos = 64
    for n in layout:
        offset[n] = pos
        pos += size[n]
    out = bytearray(pos)
    out[0:8] = b"MDF     "
    out[8:16] = b"4.10    "
    for n in layout:
        blk = blocks[n]
        o = offset[n]
        out[o:o + 4] = blk["id"].encode()
        struct.pack_into("<Q", out, o + 8, size[n])
        struct.pack_into("<Q", out, o + 16, len(blk["links"]))
        for i, lk in enumerate(blk["links"]):
            struct.pack_into("<Q", out, o + 24 + i * 8, offset[lk] if lk else 0)
        body = o + 24 + len(blk["links"]) * 8
        out[body:body + len(blk["data"])] = blk["data"]
    return bytes(out)


def test_mf4_roundtrip():
    recs = [
        dict(t=0.0, id=0x100, ide=0, len=8, data=[1, 2, 3, 4, 5, 6, 7, 8]),
        dict(t=0.01, id=0x1CFF00EE, ide=1, len=8, data=[9, 10, 11, 12, 13, 14, 15, 16]),
        dict(t=0.02, id=0x200, ide=0, len=4, data=[0xAA, 0xBB, 0xCC, 0xDD]),
    ]
    store = parse_mdf(build_mf4(recs))
    assert store.count == 3
    assert store.raw_id(0) == 0x100 and not store.is_ext(0)
    assert store.raw_id(1) == 0x1CFF00EE and store.is_ext(1)
    assert store.length[2] == 4
    assert list(store.data(2)) == [0xAA, 0xBB, 0xCC, 0xDD]
    assert abs(store.t[1] - 0.01) < 1e-9
