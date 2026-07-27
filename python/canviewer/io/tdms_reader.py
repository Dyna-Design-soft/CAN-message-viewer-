"""NI TDMS reader (NI-XNET CAN raw frames). Port of the JS tdms-reader.

Parses TDMS segments/metadata + contiguous raw data, then maps the NI-XNET
raw-frame byte channel (records = 16-byte header + payload padded to 8 bytes)
into a FrameStore. A per-field channel layout is also supported as a fallback.
"""
from __future__ import annotations

import struct

from ..core.frame_store import FrameStore, FD
from .registry import Format, register_format

_TOC_META = 1 << 1
_TOC_NEW_OBJ = 1 << 2
_TOC_RAW = 1 << 3
_TOC_INTERLEAVED = 1 << 5
_TOC_BIG_ENDIAN = 1 << 6
_TOC_DAQMX = 1 << 7

_TYPE_SIZE = {1: 1, 2: 2, 3: 4, 4: 8, 5: 1, 6: 2, 7: 4, 8: 8, 9: 4, 10: 8, 0x21: 1, 0x44: 16}
_NI_EPOCH_OFFSET = 2082844800
_FILETIME_UNIX_OFFSET = 11644473600
_NIX_ID_MASK = 0x1FFFFFFF
_NIX_EXT_FLAG = 0x20000000


class _R:
    """Little-endian cursor over a bytes buffer."""
    def __init__(self, buf, pos=0):
        self.b = buf
        self.pos = pos

    def u32(self):
        v = struct.unpack_from("<I", self.b, self.pos)[0]; self.pos += 4; return v

    def i32(self):
        v = struct.unpack_from("<i", self.b, self.pos)[0]; self.pos += 4; return v

    def u64(self):
        v = struct.unpack_from("<Q", self.b, self.pos)[0]; self.pos += 8; return v

    def f32(self):
        v = struct.unpack_from("<f", self.b, self.pos)[0]; self.pos += 4; return v

    def f64(self):
        v = struct.unpack_from("<d", self.b, self.pos)[0]; self.pos += 8; return v

    def u8(self):
        v = self.b[self.pos]; self.pos += 1; return v

    def strn(self, n):
        s = self.b[self.pos:self.pos + n].decode("utf-8", "replace"); self.pos += n; return s


def _read_value(r, t):
    if t == 0x20:
        return r.strn(r.u32())
    if t in (1,):
        v = struct.unpack_from("<b", r.b, r.pos)[0]; r.pos += 1; return v
    if t == 3:
        return r.i32()
    if t in (5, 0x21):
        return r.u8()
    if t == 7:
        return r.u32()
    if t == 8:
        return r.u64()
    if t == 9:
        return r.f32()
    if t == 10:
        return r.f64()
    if t == 4:
        v = struct.unpack_from("<q", r.b, r.pos)[0]; r.pos += 8; return v
    if t == 0x44:
        frac = r.u64(); secs = struct.unpack_from("<q", r.b, r.pos)[0]; r.pos += 8
        return secs - _NI_EPOCH_OFFSET + frac / 2 ** 64
    raise ValueError(f"Unsupported TDMS type {t}")


def parse_tdms_channels(buf: bytes) -> dict:
    channels: dict[str, dict] = {}
    active: list[str] = []
    pos = 0
    n = len(buf)
    while pos + 28 <= n:
        if buf[pos:pos + 4] != b"TDSm":
            break
        r = _R(buf, pos + 4)
        toc = r.u32()
        if toc & _TOC_BIG_ENDIAN:
            raise ValueError("Big-endian TDMS is not supported")
        if toc & _TOC_DAQMX:
            raise ValueError("DAQmx raw data in TDMS is not supported")
        r.u32()  # version
        next_off = r.u64()
        raw_off = r.u64()
        lead_end = pos + 28
        meta_end = lead_end + raw_off
        next_seg = n if next_off in (0xFFFFFFFFFFFFFFFF,) else lead_end + next_off

        seg = []
        if toc & _TOC_META:
            m = _R(buf, lead_end)
            num = m.u32()
            if toc & _TOC_NEW_OBJ:
                active = []
            for _ in range(num):
                path = m.strn(m.u32())
                raw_idx = m.u32()
                ch = channels.get(path)
                if ch is None:
                    ch = {"path": path, "type": None, "chunks": [], "num": 0, "props": {}}
                    channels[path] = ch
                if raw_idx == 0xFFFFFFFF:
                    pass
                elif raw_idx == 0:
                    if ch["type"] is not None and path not in active:
                        active.append(path)
                else:
                    dt = m.u32()
                    m.u32()  # dimension
                    numv = m.u64()
                    if dt == 0x20:
                        m.u64()  # string total
                    ch["type"] = dt
                    ch["num"] = numv
                    if path not in active:
                        active.append(path)
                nprops = m.u32()
                for _ in range(nprops):
                    pname = m.strn(m.u32())
                    ptype = m.u32()
                    ch["props"][pname] = _read_value(m, ptype)
            for path in active:
                seg.append(channels[path])
        else:
            seg = [channels[p] for p in active]

        if (toc & _TOC_RAW) and next_seg > meta_end:
            if toc & _TOC_INTERLEAVED:
                raise ValueError("Interleaved TDMS raw data is not supported")
            rr = _R(buf, meta_end)
            for ch in seg:
                ch["chunks"].append(_read_channel(rr, ch["type"], ch["num"]))

        if next_seg <= pos:
            break
        pos = next_seg

    for ch in channels.values():
        ch["data"] = _flatten(ch["chunks"])
        del ch["chunks"]
    return channels


def _read_channel(r, t, num):
    if t == 5 or t == 0x21:  # u8 — the common NI-XNET raw byte channel
        out = r.b[r.pos:r.pos + num]
        r.pos += num
        return bytes(out)
    size = _TYPE_SIZE.get(t)
    if not size:
        raise ValueError(f"Unsupported TDMS data type: {t}")
    out = [_read_value(r, t) for _ in range(num)]
    return out


def _flatten(chunks):
    if not chunks:
        return b""
    if len(chunks) == 1:
        return chunks[0]
    if isinstance(chunks[0], (bytes, bytearray)):
        return b"".join(chunks)
    out = []
    for c in chunks:
        out.extend(c)
    return out


def decode_nixnet_frames(data: bytes) -> FrameStore:
    store = FrameStore()
    n = len(data)
    pos = 0
    t0 = None
    while pos + 16 <= n:
        ticks = struct.unpack_from("<Q", data, pos)[0]
        id_raw = struct.unpack_from("<I", data, pos + 8)[0]
        plen = data[pos + 15]
        step = 16 + ((plen + 7) // 8) * 8
        if pos + step > n:
            break
        sec = ticks / 1e7
        if t0 is None:
            t0 = sec
            store.t0_epoch = sec - _FILETIME_UNIX_OFFSET
        payload = data[pos + 16:pos + 16 + min(plen, 64)]
        flags = FD if plen > 8 else 0
        store.add(sec - t0, id_raw & _NIX_ID_MASK, bool(id_raw & _NIX_EXT_FLAG), 1, flags, payload)
        pos += step
    return store


def tdms_to_frame_store(channels: dict) -> FrameStore:
    chans = [c for c in channels.values() if c.get("data") is not None and len(c["data"])]
    nixnet = next((c for c in chans
                   if any(k.startswith("NI_network") for k in c["props"])), None)
    if nixnet is not None:
        return decode_nixnet_frames(bytes(nixnet["data"]))
    raise ValueError(
        "TDMS: could not find an NI-XNET raw-frame channel. Channels: "
        + ", ".join(c["path"] for c in chans))


register_format(Format(
    name="NI TDMS (XNET)",
    extensions=["tdms"],
    sniff=lambda head, name: head[:4] == b"TDSm",
    read=lambda data: tdms_to_frame_store(parse_tdms_channels(data)),
))
