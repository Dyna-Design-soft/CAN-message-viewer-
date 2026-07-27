"""CSV reader (round-trips the viewer's CSV writer). Port of the JS csv parser."""
from __future__ import annotations

from ..core.frame_store import FrameStore, FD, TX, ERR, BRS, ESI
from .registry import Format, register_format


def parse_csv(text: str) -> FrameStore:
    store = FrameStore()
    lines = text.splitlines()
    if not lines:
        return store
    header = lines[0].lower().split(",")

    def col(name):
        return header.index(name) if name in header else -1

    ci = {k: col(k) for k in
          ["timestamp", "channel", "id", "extended", "dir", "fd", "brs", "esi", "error", "data"]}
    if ci["timestamp"] < 0 or ci["id"] < 0:
        return store
    for line in lines[1:]:
        line = line.strip()
        if not line:
            continue
        c = line.split(",")
        try:
            t = float(c[ci["timestamp"]])
        except (ValueError, IndexError):
            continue
        flags = 0
        if ci["dir"] >= 0 and c[ci["dir"]] == "Tx":
            flags |= TX
        if ci["fd"] >= 0 and c[ci["fd"]] == "1":
            flags |= FD
        if ci["brs"] >= 0 and c[ci["brs"]] == "1":
            flags |= BRS
        if ci["esi"] >= 0 and c[ci["esi"]] == "1":
            flags |= ESI
        if ci["error"] >= 0 and c[ci["error"]] == "1":
            flags |= ERR
        hexs = c[ci["data"]] if ci["data"] >= 0 and ci["data"] < len(c) else ""
        data = bytes.fromhex(hexs) if hexs and len(hexs) % 2 == 0 else b""
        idv = int(c[ci["id"]]) if c[ci["id"]].lstrip("-").isdigit() else 0
        ext = ci["extended"] >= 0 and c[ci["extended"]] == "1"
        ch = int(c[ci["channel"]]) if ci["channel"] >= 0 and c[ci["channel"]].isdigit() else 0
        store.add(t, idv, ext, ch, flags, data)
    return store


register_format(Format(
    name="CSV",
    extensions=["csv"],
    sniff=lambda head, name: name.lower().endswith(".csv")
    and head.decode("latin-1", "ignore").lower().startswith("timestamp,"),
    read=lambda data: parse_csv(data.decode("latin-1")),
))
