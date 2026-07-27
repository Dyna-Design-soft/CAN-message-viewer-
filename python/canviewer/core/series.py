"""Decode a per-signal (t, v) time series from a FrameStore + DBC."""
from __future__ import annotations

import numpy as np

from .decoder import extract_raw
from .frame_store import ERR, EXT_BIT


def extract_series(store, signal):
    """Return (t, v) numpy arrays for a signal across all channels."""
    message = signal.message
    key = (message.id & 0xFFFFFFFF) | (EXT_BIT if message.extended else 0)
    mux = message.multiplexor if signal.mux_role == "multiplexed" else None

    ts: list[float] = []
    vs: list[float] = []
    for chkey, indices in store.index().items():
        if (chkey % 0x100000000) != key:
            continue
        for i in indices:
            if store.flags[i] & ERR:
                continue
            data = store.data(i)
            if mux is not None:
                sel = extract_raw(data, mux)
                if sel is None or sel != signal.mux_value:
                    continue
            raw = extract_raw(data, signal)
            if raw is None:
                continue
            ts.append(store.t[i])
            vs.append(raw * signal.factor + signal.offset)

    t = np.asarray(ts, dtype=np.float64)
    v = np.asarray(vs, dtype=np.float64)
    if t.size > 1 and np.any(np.diff(t) < 0):
        order = np.argsort(t, kind="stable")
        t, v = t[order], v[order]
    return t, v


def value_at(t, v, tq):
    """Sample-and-hold value of a series at time tq (last sample <= tq)."""
    if t.size == 0:
        return None
    i = int(np.searchsorted(t, tq, side="right")) - 1
    return None if i < 0 else float(v[i])
