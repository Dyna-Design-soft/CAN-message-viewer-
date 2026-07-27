"""Vector DBC text parser. Port of the JS dbc-parser.

Supports VERSION, BU_, BO_, SG_ (incl. simple m<N>/M multiplexing), VAL_,
VAL_TABLE_, CM_ (multi-line), BA_DEF_DEF_/BA_ GenSigStartValue, SIG_VALTYPE_.
Extended multiplexing (SG_MUL_VAL_) is recorded as a warning, not decoded.
"""
from __future__ import annotations

import re

from .dbc_model import Cluster, Message, Signal

DBC_EXT_FLAG = 0x80000000

RE_BO = re.compile(r"^BO_\s+(\d+)\s+([A-Za-z_][\w-]*)\s*:\s*(\d+)\s+(\S+)\s*$")
RE_SG = re.compile(
    r"^SG_\s+([A-Za-z_][\w-]*)\s*(m\d+M?|M)?\s*:\s*(\d+)\|(\d+)@([01])([+-])"
    r"\s*\(\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\)\s*\[\s*([^|]*?)\s*\|\s*([^\]]*?)\s*\]"
    r'\s*"([^"]*)"\s*(.*)$'
)
RE_VAL = re.compile(r"^VAL_\s+(\d+)\s+([A-Za-z_][\w-]*)\s+(.*?);?\s*$")
RE_VALTABLE = re.compile(r"^VAL_TABLE_\s+([A-Za-z_][\w-]*)\s+(.*?);?\s*$")
RE_VALPAIRS = re.compile(r'(-?\d+)\s+"((?:[^"\\]|\\.)*)"')
RE_CM_SG = re.compile(r'^CM_\s+SG_\s+(\d+)\s+([A-Za-z_][\w-]*)\s+"([\s\S]*)"\s*;?\s*$')
RE_CM_BO = re.compile(r'^CM_\s+BO_\s+(\d+)\s+"([\s\S]*)"\s*;?\s*$')
RE_CM_GLOBAL = re.compile(r'^CM_\s+"([\s\S]*)"\s*;?\s*$')
RE_BADEFDEF = re.compile(r'^BA_DEF_DEF_\s+"([^"]+)"\s+(.+?)\s*;?\s*$')
RE_BA_SG = re.compile(r'^BA_\s+"([^"]+)"\s+SG_\s+(\d+)\s+([A-Za-z_][\w-]*)\s+(.+?)\s*;?\s*$')
RE_SIGVALTYPE = re.compile(r"^SIG_VALTYPE_\s+(\d+)\s+([A-Za-z_][\w-]*)\s*:?\s*(\d+)\s*;?\s*$")
RE_BU = re.compile(r"^BU_\s*:\s*(.*)$")
RE_SGMULVAL = re.compile(r"^SG_MUL_VAL_\s")


def _unescape(s: str) -> str:
    return s.replace('\\"', '"')


def _strip_quotes(s: str) -> str:
    m = re.match(r'^"(.*)"$', s, re.S)
    return m.group(1) if m else s


def _truncate(s, n=80):
    return s[:n] + "…" if len(s) > n else s


def _count_unescaped_quotes(s: str) -> int:
    n = 0
    for i, ch in enumerate(s):
        if ch == '"' and (i == 0 or s[i - 1] != "\\"):
            n += 1
    return n


def _split_statements(text: str):
    out = []
    lines = re.split(r"\r\n|\r|\n", text)
    buf = ""
    buf_line = 0
    in_quote = False
    for i, line in enumerate(lines):
        if not in_quote:
            buf = line.strip()
            buf_line = i + 1
            if not buf:
                continue
        else:
            buf += "\n" + line
        in_quote = _count_unescaped_quotes(buf) % 2 == 1
        if not in_quote:
            out.append((buf_line, buf))
    if in_quote and buf.strip():
        out.append((buf_line, buf))
    return out


def _parse_value_pairs(s: str) -> dict:
    return {int(m.group(1)): _unescape(m.group(2)) for m in RE_VALPAIRS.finditer(s)}


def _find_signal(by_id, dbc_id, name):
    msg = by_id.get(dbc_id & 0xFFFFFFFF)
    if not msg:
        return None
    for s in msg.signals:
        if s.name == name:
            return s
    return None


def parse_dbc(text: str, file_name: str) -> Cluster:
    name = re.sub(r"\.[^.]*$", "", file_name)
    cluster = Cluster(name, file_name)
    by_id: dict[int, Message] = {}
    value_tables: dict[str, dict] = {}
    default_start = None
    current = None
    ext_mux_warned = False

    def err(line, msg):
        cluster.parse_errors.append({"line": line, "text": msg})

    for line, stmt in _split_statements(text):
        try:
            if stmt.startswith("BO_ "):
                m = RE_BO.match(stmt)
                if not m:
                    err(line, f"Malformed BO_ statement: {_truncate(stmt)}")
                    current = None
                    continue
                dbc_id = int(m.group(1)) & 0xFFFFFFFF
                extended = bool(dbc_id & DBC_EXT_FLAG)
                msg = Message(
                    id=dbc_id & ~DBC_EXT_FLAG & 0xFFFFFFFF,
                    extended=extended,
                    name=m.group(2),
                    dlc=int(m.group(3)),
                    transmitter="" if m.group(4) == "Vector__XXX" else m.group(4),
                )
                by_id[dbc_id] = msg
                cluster.messages[dbc_id] = msg
                current = msg
            elif stmt.startswith("SG_ "):
                if current is None:
                    err(line, "SG_ outside of a BO_ block")
                    continue
                m = RE_SG.match(stmt)
                if not m:
                    err(line, f"Malformed SG_ statement: {_truncate(stmt)}")
                    continue
                mux = m.group(2) or ""
                mux_value = int(re.match(r"^m(\d+)", mux).group(1)) if re.match(r"^m\d+", mux) else None
                sig = Signal(
                    name=m.group(1),
                    start_bit=int(m.group(3)),
                    bit_length=int(m.group(4)),
                    byte_order=int(m.group(5)),
                    signed=m.group(6) == "-",
                    factor=float(m.group(7)),
                    offset=float(m.group(8)),
                    min=0.0 if m.group(9) == "" else float(m.group(9)),
                    max=0.0 if m.group(10) == "" else float(m.group(10)),
                    unit=m.group(11),
                    receivers=[r for r in re.split(r"[,\s]+", m.group(12)) if r and r != "Vector__XXX"],
                    mux_role="multiplexor" if mux == "M" else ("multiplexed" if mux else "none"),
                    mux_value=mux_value,
                )
                current.signals.append(sig)
            elif stmt.startswith("VAL_TABLE_ "):
                m = RE_VALTABLE.match(stmt)
                if m:
                    value_tables[m.group(1)] = _parse_value_pairs(m.group(2))
                else:
                    err(line, f"Malformed VAL_TABLE_: {_truncate(stmt)}")
            elif stmt.startswith("VAL_ "):
                m = RE_VAL.match(stmt)
                if not m:
                    err(line, f"Malformed VAL_: {_truncate(stmt)}")
                    continue
                sig = _find_signal(by_id, int(m.group(1)), m.group(2))
                if sig:
                    rest = m.group(3).strip()
                    table = value_tables.get(rest) or _parse_value_pairs(rest)
                    sig.value_table = table if table else None
            elif stmt.startswith("CM_"):
                m = RE_CM_SG.match(stmt)
                if m:
                    sig = _find_signal(by_id, int(m.group(1)), m.group(2))
                    if sig:
                        sig.comment = _unescape(m.group(3))
                    continue
                m = RE_CM_BO.match(stmt)
                if m:
                    msg = by_id.get(int(m.group(1)) & 0xFFFFFFFF)
                    if msg:
                        msg.comment = _unescape(m.group(2))
                    continue
                m = RE_CM_GLOBAL.match(stmt)
                if m:
                    cluster.comment = _unescape(m.group(1))
            elif stmt.startswith("BA_DEF_DEF_ "):
                m = RE_BADEFDEF.match(stmt)
                if m and m.group(1) == "GenSigStartValue":
                    try:
                        d = float(_strip_quotes(m.group(2)))
                        if d != 0:
                            default_start = d
                    except ValueError:
                        pass
            elif stmt.startswith("BA_ "):
                m = RE_BA_SG.match(stmt)
                if m and m.group(1) == "GenSigStartValue":
                    sig = _find_signal(by_id, int(m.group(2)), m.group(3))
                    try:
                        v = float(_strip_quotes(m.group(4)))
                        if sig:
                            sig.start_value = v
                    except ValueError:
                        pass
            elif stmt.startswith("SIG_VALTYPE_ "):
                m = RE_SIGVALTYPE.match(stmt)
                if m:
                    sig = _find_signal(by_id, int(m.group(1)), m.group(2))
                    if sig:
                        sig.is_float = m.group(3) in ("1", "2")
                        sig.is_double = m.group(3) == "2"
            elif RE_SGMULVAL.match(stmt):
                if not ext_mux_warned:
                    err(line, "Extended multiplexing (SG_MUL_VAL_) is not decoded.")
                    ext_mux_warned = True
            elif stmt.startswith("BU_"):
                m = RE_BU.match(stmt)
                if m:
                    cluster.nodes = [n for n in re.split(r"\s+", m.group(1)) if n and n != "Vector__XXX"]
        except Exception as e:  # noqa: BLE001 - collect and continue
            err(line, f"Parser error: {e}")

    if default_start is not None:
        for msg in cluster.messages.values():
            for sig in msg.signals:
                if sig.start_value is None:
                    sig.start_value = default_start

    for msg in cluster.messages.values():
        msg.signals.sort(key=lambda s: (s.start_bit, s.name))
    return cluster
