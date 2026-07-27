"""Vector BLF reader. Port of the JS blf-reader.

Parses the 144-byte header, inflates every LOG_CONTAINER, joins them (objects
can straddle container boundaries), then walks the object stream with a
validating scan that resyncs on the LOBJ signature and rejects false matches.
"""
from __future__ import annotations

import struct
import zlib
from datetime import datetime

from ..core.frame_store import FrameStore, FD, TX, ERR, RTR, BRS, ESI
from .registry import Format, register_format

OBJ_CAN_MESSAGE = 1
OBJ_CAN_ERROR = 2
OBJ_LOG_CONTAINER = 10
OBJ_CAN_ERROR_EXT = 73
OBJ_CAN_MESSAGE2 = 86
OBJ_CAN_FD_MESSAGE = 100
OBJ_CAN_FD_MESSAGE_64 = 101
_RELIABLE = {OBJ_CAN_MESSAGE, OBJ_CAN_ERROR, OBJ_LOG_CONTAINER, OBJ_CAN_ERROR_EXT,
             OBJ_CAN_MESSAGE2, OBJ_CAN_FD_MESSAGE, OBJ_CAN_FD_MESSAGE_64}

ID_MASK = 0x1FFFFFFF
ID_EXT = 0x80000000
CANFD_EDL = 0x01
CANFD_BRS = 0x02
CANFD_ESI = 0x04
TX_FLAG = 0x01
MAX_TS = 48 * 3600
_LOBJ = b"LOBJ"


def _sane(ts, ch):
    return ch <= 63 and 0 <= ts < MAX_TS


def _is_lobj(b, o):
    return b[o:o + 4] == _LOBJ


def _plausible(b, o, end):
    if o + 16 > end or b[o:o + 4] != _LOBJ:
        return False
    hs = b[o + 4] | (b[o + 5] << 8)
    size = struct.unpack_from("<I", b, o + 8)[0]
    return hs in (16, 32) and size >= 16 and o + size <= end


def _scan_valid(b, frm, end):
    o = frm
    while o + 16 <= end:
        if _plausible(b, o, end):
            size = struct.unpack_from("<I", b, o + 8)[0]
            nx = o + size
            if nx == end:
                return o
            steps = 0
            while nx + 4 <= end and not _is_lobj(b, nx) and steps < 32:
                nx += 1
                steps += 1
            if nx >= end or _plausible(b, nx, end):
                return o
        o += 1
    return end


def _next_object(b, obj_end, end):
    if obj_end >= end:
        return end
    if _plausible(b, obj_end, end):
        return obj_end
    return _scan_valid(b, obj_end + 1, end)


def parse_blf(buf: bytes) -> FrameStore:
    store = FrameStore()
    if buf[:4] != b"LOGG":
        raise ValueError("Not a BLF file (missing LOGG signature)")
    header_size = struct.unpack_from("<I", buf, 4)[0]
    store.t0_epoch = _read_systemtime(buf, 40)
    pos = header_size or 144
    n = len(buf)

    chunks = []
    while pos + 16 <= n:
        obj_start = pos
        if buf[obj_start:obj_start + 4] != _LOBJ:
            nxt = buf.find(_LOBJ, obj_start + 1)
            if nxt < 0:
                break
            pos = nxt
            continue
        object_size = struct.unpack_from("<I", buf, obj_start + 8)[0]
        object_type = struct.unpack_from("<I", buf, obj_start + 12)[0]
        obj_end = obj_start + object_size
        if obj_end <= obj_start or obj_end > n:
            break
        if object_type == OBJ_LOG_CONTAINER:
            method = struct.unpack_from("<H", buf, obj_start + 16)[0]
            payload = buf[obj_start + 32:obj_end]
            raw = payload if method == 0 else zlib.decompress(payload)
            chunks.append(raw)
        pos = (obj_end + 3) & ~3

    joined = chunks[0] if len(chunks) == 1 else b"".join(chunks)
    _parse_objects(joined, store)
    return store


def _parse_objects(b: bytes, store: FrameStore):
    end = len(b)
    pos = 0
    while pos + 16 <= end:
        if not _is_lobj(b, pos):
            pos = _scan_valid(b, pos + 1, end)
            continue
        obj_start = pos
        header_size = b[obj_start + 4] | (b[obj_start + 5] << 8)
        object_size = struct.unpack_from("<I", b, obj_start + 8)[0]
        object_type = struct.unpack_from("<I", b, obj_start + 12)[0]
        obj_end = obj_start + object_size
        if header_size not in (16, 32) or object_size < 16 or obj_end > end:
            pos = _scan_valid(b, obj_start + 4, end)
            continue
        if header_size == 32:
            obj_flags = struct.unpack_from("<I", b, obj_start + 16)[0]
            ts_raw = struct.unpack_from("<Q", b, obj_start + 24)[0]
            ts = ts_raw * 1e-5 if obj_flags == 1 else ts_raw * 1e-9
            body = obj_start + 32
            if object_type in (OBJ_CAN_MESSAGE, OBJ_CAN_MESSAGE2):
                _can_msg(b, body, store, ts)
            elif object_type == OBJ_CAN_FD_MESSAGE:
                _can_fd(b, body, store, ts)
            elif object_type == OBJ_CAN_FD_MESSAGE_64:
                _can_fd64(b, body, store, ts)
            elif object_type in (OBJ_CAN_ERROR, OBJ_CAN_ERROR_EXT):
                ch = struct.unpack_from("<H", b, body)[0]
                if _sane(ts, ch):
                    store.add(ts, 0, False, ch, ERR, None)
        if object_type in _RELIABLE:
            pos = _next_object(b, obj_end, end)
        else:
            pos = _scan_valid(b, obj_start + 32, end)


def _can_msg(b, o, store, ts):
    ch, flags, dlc = struct.unpack_from("<HBB", b, o)
    idv = struct.unpack_from("<I", b, o + 4)[0]
    data = b[o + 8:o + 8 + min(dlc, 8)]
    if not _sane(ts, ch):
        return
    ff = (TX if flags & TX_FLAG else 0) | (RTR if flags & 0x80 else 0)
    store.add(ts, idv & ID_MASK, bool(idv & ID_EXT), ch, ff, data)


def _can_fd(b, o, store, ts):
    ch, flags, dlc = struct.unpack_from("<HBB", b, o)
    idv = struct.unpack_from("<I", b, o + 4)[0]
    canfd_flags = b[o + 13]
    valid = b[o + 14]
    data = b[o + 24:o + 24 + min(valid, 64)]
    if not _sane(ts, ch):
        return
    ff = FD
    if flags & TX_FLAG:
        ff |= TX
    if canfd_flags & CANFD_BRS:
        ff |= BRS
    if canfd_flags & CANFD_ESI:
        ff |= ESI
    if not (canfd_flags & CANFD_EDL):
        ff &= ~FD
    store.add(ts, idv & ID_MASK, bool(idv & ID_EXT), ch, ff, data)


def _can_fd64(b, o, store, ts):
    ch = b[o]
    valid = b[o + 2]
    idv = struct.unpack_from("<I", b, o + 4)[0]
    flags = struct.unpack_from("<I", b, o + 12)[0]
    dir_ = b[o + 38]
    data = b[o + 44:o + 44 + min(valid, 64)]
    if not _sane(ts, ch):
        return
    ff = FD
    if dir_ == 1:
        ff |= TX
    if flags & 0x2000:
        ff |= BRS
    if flags & 0x4000:
        ff |= ESI
    store.add(ts, idv & ID_MASK, bool(idv & ID_EXT), ch, ff, data)


def _read_systemtime(b, o):
    year, month, _dow, day, hour, minute, sec, ms = struct.unpack_from("<8H", b, o)
    if year < 1970 or year > 2200 or month < 1 or month > 12:
        return None
    try:
        return datetime(year, month, day, hour, minute, sec, ms * 1000).timestamp()
    except ValueError:
        return None


register_format(Format(
    name="Vector BLF",
    extensions=["blf"],
    sniff=lambda head, name: head[:4] == b"LOGG",
    read=parse_blf,
))
