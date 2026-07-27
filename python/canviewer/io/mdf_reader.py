"""ASAM MDF v4 (.mf4) reader — CAN bus-logging layout. Port of the JS mdf-reader.

Reads CAN_DataFrame / CAN_ErrorFrame channel groups: sorted and unsorted data
groups; uncompressed (##DT/##DV), compressed (##DZ, deflate incl. transposed),
and block-list (##DL/##HL) data. Generic signal MDF, array/VLSD channels and
MDF3 are out of scope.
"""
from __future__ import annotations

import struct
import zlib

from ..core.frame_store import FrameStore, FD, BRS, ESI, ERR, TX, dlc_to_length
from .registry import Format, register_format


def _hdr(b, off):
    ident = b[off:off + 4].decode("latin-1")
    length = struct.unpack_from("<Q", b, off + 8)[0]
    link_count = struct.unpack_from("<Q", b, off + 16)[0]
    links = list(struct.unpack_from("<%dQ" % link_count, b, off + 24)) if link_count else []
    data_start = off + 24 + link_count * 8
    return {"id": ident, "length": length, "links": links,
            "data": data_start, "end": off + length}


def _text(b, off):
    if not off:
        return ""
    h = _hdr(b, off)
    if h["id"] not in ("##TX", "##MD"):
        return ""
    return b[h["data"]:h["end"]].split(b"\x00", 1)[0].decode("utf-8", "replace").strip()


def _read_data_block(b, off):
    if not off:
        return b""
    h = _hdr(b, off)
    ident = h["id"]
    if ident in ("##DT", "##DV", "##RD"):
        return b[h["data"]:h["end"]]
    if ident == "##DZ":
        return _inflate_dz(b, h)
    if ident == "##DL":
        parts = []
        cur = off
        while cur:
            hh = _hdr(b, cur)
            count = struct.unpack_from("<I", b, hh["data"] + 4)[0]
            for i in range(count):
                parts.append(_read_data_block(b, hh["links"][1 + i]))
            cur = hh["links"][0]
        return b"".join(parts)
    if ident == "##HL":
        return _read_data_block(b, h["links"][0])
    return b""


def _inflate_dz(b, h):
    o = h["data"]
    zip_type = b[o + 2]
    zip_param = struct.unpack_from("<I", b, o + 4)[0]
    org_len = struct.unpack_from("<Q", b, o + 8)[0]
    data_len = struct.unpack_from("<Q", b, o + 16)[0]
    comp = b[o + 24:o + 24 + data_len]
    out = zlib.decompress(comp)
    if len(out) > org_len:
        out = out[:org_len]
    if zip_type == 1:
        out = _untranspose(out, zip_param, org_len)
    return out


def _untranspose(data, cols, org_len):
    if not cols:
        return data
    rows = org_len // cols
    out = bytearray(org_len)
    for c in range(cols):
        for r in range(rows):
            out[r * cols + c] = data[c * rows + r]
    tail = rows * cols
    if tail < org_len:
        out[tail:] = data[tail:org_len]
    return bytes(out)


def _read_channel(b, off):
    h = _hdr(b, off)
    o = h["data"]
    cn = {
        "next": h["links"][0],
        "composition": h["links"][1],
        "cc": h["links"][4] if len(h["links"]) > 4 else 0,
        "type": b[o],
        "data_type": b[o + 2],
        "bit_offset": b[o + 3],
        "byte_offset": struct.unpack_from("<I", b, o + 4)[0],
        "bit_count": struct.unpack_from("<I", b, o + 8)[0],
    }
    cn["name"] = _text(b, h["links"][2])
    return cn


def _read_conversion(b, off):
    if not off:
        return None
    h = _hdr(b, off)
    if h["id"] != "##CC":
        return None
    o = h["data"]
    cc_type = b[o]
    val_count = struct.unpack_from("<H", b, o + 6)[0]
    vals = list(struct.unpack_from("<%dd" % val_count, b, o + 24)) if val_count else []
    if cc_type == 0:
        return (0.0, 1.0)
    if cc_type == 1:
        return (vals[0] if len(vals) > 0 else 0.0, vals[1] if len(vals) > 1 else 1.0)
    return None


def _collect_channels(b, first):
    out = []

    def walk(off):
        cur = off
        while cur:
            cn = _read_channel(b, cur)
            out.append(cn)
            if cn["composition"]:
                ch = _hdr(b, cn["composition"])
                if ch["id"] == "##CN":
                    walk(cn["composition"])
            cur = cn["next"]

    walk(first)
    return out


def _read_field(rec, base, cn):
    off = base + cn["byte_offset"]
    bits = cn["bit_count"]
    dt = cn["data_type"]
    if dt == 4:
        return struct.unpack_from("<f" if bits == 32 else "<d", rec, off)[0]
    if dt == 5:
        return struct.unpack_from(">f" if bits == 32 else ">d", rec, off)[0]
    le = dt in (0, 2)
    signed = dt in (2, 3)
    nbytes = (bits + 7) // 8
    chunk = rec[off:off + nbytes]
    if len(chunk) < nbytes:
        chunk = chunk + b"\x00" * (nbytes - len(chunk))
    v = int.from_bytes(chunk, "little" if le else "big")
    if cn["bit_offset"]:
        v >>= cn["bit_offset"]
    if bits % 8:
        v &= (1 << bits) - 1
    if signed and (v & (1 << (bits - 1))):
        v -= 1 << bits
    return v


def parse_mdf(b: bytes) -> FrameStore:
    if b[:3] not in (b"MDF", b"UnF"):
        raise ValueError("Not an MDF file")
    store = FrameStore()
    hd = _hdr(b, 64)
    if hd["id"] != "##HD":
        raise ValueError("MDF: missing HD block")
    start_ns = struct.unpack_from("<Q", b, hd["data"])[0]
    if start_ns > 0:
        store.t0_epoch = start_ns / 1e9

    total = 0
    dg_off = hd["links"][0]
    while dg_off:
        dg = _hdr(b, dg_off)
        dg_next, cg_first, dg_data = dg["links"][0], dg["links"][1], dg["links"][2]
        rec_id_size = b[dg["data"]]
        groups = []
        cg_off = cg_first
        while cg_off:
            cg = _hdr(b, cg_off)
            o = cg["data"]
            record_id = struct.unpack_from("<Q", b, o)[0]
            cycle_count = struct.unpack_from("<Q", b, o + 8)[0]
            cg_flags = struct.unpack_from("<H", b, o + 16)[0]
            data_bytes = struct.unpack_from("<I", b, o + 24)[0]
            inval_bytes = struct.unpack_from("<I", b, o + 28)[0]
            is_vlsd = bool(cg_flags & 0x01)
            channels = [] if is_vlsd else _collect_channels(b, cg["links"][1])
            groups.append({
                "record_id": record_id, "cycle_count": cycle_count,
                "rec_size": data_bytes + inval_bytes, "data_bytes": data_bytes,
                "channels": channels, "acq": _text(b, cg["links"][2]), "vlsd": is_vlsd,
            })
            cg_off = cg["links"][0]

        data = _read_data_block(b, dg_data)
        total += _decode_dg(b, store, data, groups, rec_id_size)
        dg_off = dg_next

    if total == 0:
        raise ValueError("MDF: no CAN frames found (only CAN bus-logging files are supported).")
    return store


def _classify(b, g):
    def find(suffix):
        for c in g["channels"]:
            if c["name"].lower().split(".")[-1] == suffix:
                return c
        return None

    master = next((c for c in g["channels"] if c["type"] in (2, 3)), None) or find("t")
    idc = find("id")
    data_bytes = next((c for c in g["channels"] if c["name"].lower().split(".")[-1] == "databytes"), None)
    name_has_can = "can" in g["acq"].lower() or any("can_" in c["name"].lower() for c in g["channels"])
    is_error = "errorframe" in g["acq"].lower() or any("errorframe" in c["name"].lower() for c in g["channels"])
    if not master or (not idc and not is_error):
        return None
    if not name_has_can and not idc:
        return None
    return {
        "master": master, "id": idc, "data_bytes": data_bytes,
        "ide": find("ide"), "dlc": find("dlc"), "data_length": find("datalength"),
        "dir": find("dir"), "fd": find("edl") or find("fdf"),
        "brs": find("brs"), "esi": find("esi"), "bus": find("buschannel"),
        "is_error": is_error, "conv": _read_conversion(b, master["cc"]),
    }


def _decode_dg(b, store, data, groups, rec_id_size):
    for g in groups:
        g["can"] = None if g["vlsd"] else _classify(b, g)
    added = 0
    n = len(data)
    if rec_id_size == 0:
        if not groups:
            return 0
        g = groups[0]
        pos = 0
        for _ in range(g["cycle_count"]):
            if pos + g["rec_size"] > n:
                break
            added += _emit(store, data, pos, g)
            pos += g["rec_size"]
        return added
    by_id = {g["record_id"]: g for g in groups}
    pos = 0
    while pos + rec_id_size <= n:
        rid = int.from_bytes(data[pos:pos + rec_id_size], "little")
        pos += rec_id_size
        g = by_id.get(rid)
        if not g or pos + g["rec_size"] > n:
            break
        added += _emit(store, data, pos, g)
        pos += g["rec_size"]
    return added


def _emit(store, data, base, g):
    can = g["can"]
    if not can:
        return 0
    t_raw = _read_field(data, base, can["master"])
    t = can["conv"][0] + can["conv"][1] * t_raw if can["conv"] else t_raw
    if can["is_error"] and not can["id"]:
        ch = _read_field(data, base, can["bus"]) if can["bus"] else 0
        store.add(t, 0, False, ch, ERR, None)
        return 1
    idv = _read_field(data, base, can["id"]) & 0xFFFFFFFF
    if can["ide"]:
        ext = _read_field(data, base, can["ide"]) != 0
    else:
        ext = bool(idv & 0x80000000)
    idv &= 0x1FFFFFFF
    ch = _read_field(data, base, can["bus"]) if can["bus"] else 0
    flags = ERR if can["is_error"] else 0
    if can["fd"] and _read_field(data, base, can["fd"]):
        flags |= FD
    if can["brs"] and _read_field(data, base, can["brs"]):
        flags |= BRS
    if can["esi"] and _read_field(data, base, can["esi"]):
        flags |= ESI
    if can["dir"] and _read_field(data, base, can["dir"]):
        flags |= TX
    fd = bool(flags & FD)
    if can["data_length"]:
        length = _read_field(data, base, can["data_length"])
    elif can["dlc"]:
        length = dlc_to_length(_read_field(data, base, can["dlc"]), fd)
    else:
        length = can["data_bytes"]["bit_count"] // 8 if can["data_bytes"] else 0
    length = max(0, min(64, int(length)))
    payload = None
    if can["data_bytes"]:
        off = base + can["data_bytes"]["byte_offset"]
        width = can["data_bytes"]["bit_count"] // 8
        payload = data[off:off + min(length, width)]
    store.add(t, idv, ext, ch, flags, payload)
    return 1


register_format(Format(
    name="ASAM MDF v4 (MF4)",
    extensions=["mf4", "mdf"],
    sniff=lambda head, name: head[:3] == b"MDF",
    read=parse_mdf,
))
