"""Vector ASC reader. Port of the JS asc-reader."""
from __future__ import annotations

import re
from datetime import datetime

from ..core.frame_store import FrameStore, FD, TX, ERR, RTR, BRS, ESI
from .registry import Format, register_format

_MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
_DATE_RE = re.compile(
    r"date\s+\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)(?:\.(\d+))?\s+(?:[ap]m\s+)?(\d{4})", re.I)


def parse_asc_text(text: str):
    store = FrameStore()
    base = 16
    skipped = 0
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("date "):
            m = _DATE_RE.search(line)
            if m and m.group(1) in _MONTHS:
                dt = datetime(int(m.group(7)), _MONTHS[m.group(1)] + 1, int(m.group(2)),
                              int(m.group(3)), int(m.group(4)), int(m.group(5)),
                              int((m.group(6) or "0").ljust(3, "0")[:3]) * 1000)
                store.t0_epoch = dt.timestamp()
            continue
        if line.startswith("base "):
            base = 10 if re.search(r"base\s+dec", line, re.I) else 16
            continue
        if re.match(r"^(begin|end|internal|version)\b", line, re.I):
            continue

        tok = line.split()
        try:
            t = float(tok[0])
        except (ValueError, IndexError):
            continue

        if len(tok) > 1 and tok[1] == "CANFD":
            ch = _int(tok[2], 10) or 1
            dir_ = tok[3] if len(tok) > 3 else "Rx"
            id_tok = tok[4] if len(tok) > 4 else None
            if not id_tok:
                skipped += 1
                continue
            ext = id_tok.endswith("x")
            idv = _int(id_tok[:-1] if ext else id_tok, 16)
            if idv is None:
                skipped += 1
                continue
            flags = FD | (TX if dir_ == "Tx" else 0)
            data = b""
            j = 5
            while j + 3 < len(tok):
                if (re.fullmatch(r"[01]", tok[j]) and re.fullmatch(r"[01]", tok[j + 1])
                        and re.fullmatch(r"[0-9a-fA-F]", tok[j + 2])
                        and re.fullmatch(r"\d{1,2}", tok[j + 3]) and int(tok[j + 3]) <= 64):
                    if tok[j] == "1":
                        flags |= BRS
                    if tok[j + 1] == "1":
                        flags |= ESI
                    n = min(int(tok[j + 3]), len(tok) - (j + 4))
                    data = bytes((_int(tok[j + 4 + i], 16) or 0) for i in range(n))
                    break
                j += 1
            store.add(t, idv, ext, ch, flags, data)
            continue

        ch = _int(tok[1], 10) if len(tok) > 1 else None
        if ch is None:
            skipped += 1
            continue
        third = tok[2] if len(tok) > 2 else ""
        if re.match(r"^ErrorFrame", third, re.I):
            store.add(t, 0, False, ch, ERR, None)
            continue
        if re.match(r"^(Statistic|J1939TP|TriggerEvent|BusStatistics)", third, re.I):
            skipped += 1
            continue

        id_tok = third
        ext = id_tok[-1:] in ("x", "X")
        idv = _int(id_tok[:-1] if ext else id_tok, base)
        if idv is None:
            skipped += 1
            continue
        dir_ = tok[3] if len(tok) > 3 else "Rx"
        flags = TX if dir_ == "Tx" else 0
        k = 4
        if k < len(tok) and tok[k] == "r":
            store.add(t, idv, ext, ch, flags | RTR, b"")
            continue
        if k < len(tok) and tok[k] == "d":
            k += 1
        dlc = _int(tok[k], 10) if k < len(tok) else None
        if dlc is None:
            skipped += 1
            continue
        k += 1
        n = min(dlc, 64)
        vals = []
        ok = True
        for i in range(n):
            b = _int(tok[k + i], 16) if k + i < len(tok) else None
            if b is None:
                ok = False
                break
            vals.append(b)
        if not ok:
            skipped += 1
            continue
        store.add(t, idv, ext, ch, flags, bytes(vals))
    return store, skipped


def _int(s, base):
    try:
        return int(s, base)
    except (ValueError, TypeError):
        return None


register_format(Format(
    name="Vector ASC",
    extensions=["asc"],
    sniff=lambda head, name: name.lower().endswith(".asc"),
    read=lambda data: parse_asc_text(data.decode("latin-1"))[0],
))
