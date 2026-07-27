"""Columnar CAN frame storage — the Python port of the JS FrameStore.

Frames accumulate in per-field Python lists during load (payload bytes go into
one shared bytearray); numpy views are materialised on demand for fast
per-signal series extraction and stats.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

# Flag bits (match the JS FrameFlags).
FD = 1
BRS = 2
ESI = 4
RTR = 8
ERR = 16
TX = 32

EXT_BIT = 0x80000000

_FD_DLC_TO_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64]


def dlc_to_length(dlc: int, fd: bool) -> int:
    if dlc <= 8:
        return dlc
    return _FD_DLC_TO_LEN[min(dlc, 15)] if fd else 8


def length_to_dlc(n: int) -> int:
    if n <= 8:
        return n
    for dlc in range(9, 16):
        if _FD_DLC_TO_LEN[dlc] >= n:
            return dlc
    return 15


@dataclass
class PerId:
    ch: int
    id: int
    ext: bool
    err: bool
    count: int
    cycle_ms: float | None
    rate: float | None


class FrameStore:
    def __init__(self) -> None:
        self.t: list[float] = []
        self.id: list[int] = []       # raw id with EXT_BIT in bit 31
        self.flags: list[int] = []
        self.length: list[int] = []
        self.ch: list[int] = []
        self._pool = bytearray()
        self._ofs: list[int] = []
        self.t0_epoch: float | None = None
        self._index: dict[int, list[int]] | None = None

    # ---- basics ----
    @property
    def count(self) -> int:
        return len(self.t)

    @property
    def is_empty(self) -> bool:
        return not self.t

    def add(self, t, idv, ext, ch, flags, data) -> int:
        i = len(self.t)
        self.t.append(float(t))
        self.id.append((int(idv) & 0xFFFFFFFF) | (EXT_BIT if ext else 0))
        self.flags.append(int(flags))
        self.ch.append(int(ch))
        n = len(data) if data is not None else 0
        self.length.append(n)
        self._ofs.append(len(self._pool))
        if n:
            self._pool += bytes(memoryview(data)[:n])
        self._index = None
        return i

    def data(self, i: int) -> bytes:
        o = self._ofs[i]
        return bytes(self._pool[o:o + self.length[i]])

    def raw_id(self, i: int) -> int:
        return self.id[i] & 0x7FFFFFFF

    def is_ext(self, i: int) -> bool:
        return bool(self.id[i] & EXT_BIT)

    # ---- per (channel,id) index ----
    def index(self) -> dict[int, list[int]]:
        if self._index is None:
            idx: dict[int, list[int]] = {}
            for i in range(self.count):
                key = self.ch[i] * 0x100000000 + self.id[i]
                idx.setdefault(key, []).append(i)
            self._index = idx
        return self._index

    # ---- numpy views (materialised once) ----
    def times(self) -> np.ndarray:
        return np.asarray(self.t, dtype=np.float64)

    # ---- statistics (mirrors JS computeStats) ----
    def compute_stats(self) -> dict:
        n = self.count
        if n == 0:
            return {
                "frame_count": 0, "duration": 0.0, "frame_rate": 0.0,
                "unique_ids": 0, "channels": [], "fd_frames": 0,
                "error_frames": 0, "per_id": [], "t_first": 0.0, "t_last": 0.0,
            }
        t_first = min(self.t)
        t_last = max(self.t)
        duration = t_last - t_first
        fd_frames = sum(1 for f in self.flags if f & FD)
        error_frames = sum(1 for f in self.flags if f & ERR)
        channels = sorted(set(self.ch))
        per_id: list[PerId] = []
        for key, indices in self.index().items():
            ch = key // 0x100000000
            idw = key % 0x100000000
            ext = bool(idw & EXT_BIT)
            rid = idw & 0x7FFFFFFF
            err = bool(self.flags[indices[0]] & ERR)
            count = len(indices)
            cycle_ms = None
            rate = None
            if count > 1:
                span = self.t[indices[-1]] - self.t[indices[0]]
                if span > 0:
                    cycle_ms = span / (count - 1) * 1000.0
                    rate = (count - 1) / span
            per_id.append(PerId(ch, rid, ext, err, count, cycle_ms, rate))
        per_id.sort(key=lambda p: (p.ch, p.id))
        return {
            "frame_count": n,
            "duration": duration,
            "frame_rate": (n / duration) if duration > 0 else 0.0,
            "unique_ids": len({(p.ch, p.id, p.ext) for p in per_id if not p.err}),
            "channels": channels,
            "fd_frames": fd_frames,
            "error_frames": error_frames,
            "per_id": per_id,
            "t_first": t_first,
            "t_last": t_last,
        }
