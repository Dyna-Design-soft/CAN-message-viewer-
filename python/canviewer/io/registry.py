"""Pluggable log-format registry. Readers register {name, extensions, sniff, read}."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from ..core.frame_store import FrameStore


@dataclass
class Format:
    name: str
    extensions: list[str]
    sniff: Callable[[bytes, str], bool]
    read: Callable[[bytes], FrameStore]


_FORMATS: list[Format] = []


def register_format(fmt: Format):
    _FORMATS.append(fmt)


def list_formats():
    return list(_FORMATS)


def detect_format(path: str, head: bytes):
    import os
    for f in _FORMATS:
        try:
            if f.sniff and f.sniff(head, os.path.basename(path)):
                return f
        except Exception:
            pass
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    for f in _FORMATS:
        if ext in f.extensions:
            return f
    return None


def load_log_file(path: str):
    """Read a log file into a FrameStore, returning (store, format_name)."""
    with open(path, "rb") as fh:
        data = fh.read()
    fmt = detect_format(path, data[:256])
    if not fmt:
        names = ", ".join(f.name for f in _FORMATS)
        raise ValueError(f'Unsupported file format: "{path}". Supported: {names}')
    return fmt.read(data), fmt.name


def load_all_readers():
    """Import every reader module so it registers itself."""
    from . import asc_reader, csv_reader, tdms_reader, blf_reader, mdf_reader  # noqa: F401
