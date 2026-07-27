"""Golden-vector tests for the Python core: decoder, DBC parse, readers."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from canviewer.core.dbc_parser import parse_dbc
from canviewer.core.dbc_model import Signal, Message
from canviewer.core.decoder import extract_raw, decode_signal, value_label
from canviewer.core.frame_store import FrameStore, FD
from canviewer.core.series import extract_series, value_at
from canviewer.io.registry import load_all_readers

load_all_readers()

DEMO_DBC = """VERSION "demo 1.0"
BU_ ECU1 Gateway
BO_ 256 EngineData: 8 ECU1
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" Gateway
 SG_ VehicleSpeed : 16|16@1+ (0.01,0) [0|655.35] "km/h" Gateway
 SG_ EngineTemp : 32|8@1+ (1,-40) [-40|215] "degC" Gateway
BO_ 768 Climate: 4 ECU1
 SG_ TempSelect M : 0|8@1+ (1,0) [0|1] "" Gateway
 SG_ CabinTemp m0 : 8|16@1+ (0.1,-40) [-40|80] "degC" Gateway
 SG_ AmbientTemp m1 : 8|16@1+ (0.1,-40) [-40|80] "degC" Gateway
VAL_ 768 TempSelect 0 "Cabin" 1 "Ambient" ;
"""


def _sig(**kw):
    return Signal(**kw)


def test_intel_le():
    s = _sig(start_bit=0, bit_length=16, byte_order=1, signed=False)
    assert extract_raw(bytes([0xE0, 0x2E, 0, 0, 0, 0, 0, 0]), s) == 0x2EE0


def test_motorola_be():
    # MSB-first: startBit 7, 16 bits over bytes 0..1, value 0x1234
    s = _sig(start_bit=7, bit_length=16, byte_order=0, signed=False)
    assert extract_raw(bytes([0x12, 0x34, 0, 0, 0, 0, 0, 0]), s) == 0x1234


def test_signed():
    s = _sig(start_bit=0, bit_length=8, byte_order=1, signed=True)
    assert extract_raw(bytes([0xFF, 0, 0, 0, 0, 0, 0, 0]), s) == -1


def test_too_short_returns_none():
    s = _sig(start_bit=0, bit_length=16, byte_order=1)
    assert extract_raw(bytes([0x10]), s) is None


def test_dbc_parse_and_mux():
    c = parse_dbc(DEMO_DBC, "demo.dbc")
    assert len(c.messages) == 2
    eng = c.messages[256]
    assert eng.name == "EngineData"
    rpm = next(s for s in eng.signals if s.name == "EngineSpeed")
    assert rpm.factor == 0.25 and rpm.unit == "rpm"
    clim = c.messages[768]
    ts = next(s for s in clim.signals if s.name == "TempSelect")
    assert ts.mux_role == "multiplexor"
    assert ts.value_table == {0: "Cabin", 1: "Ambient"}
    cabin = next(s for s in clim.signals if s.name == "CabinTemp")
    assert cabin.mux_role == "multiplexed" and cabin.mux_value == 0


def test_decode_physical_and_label():
    c = parse_dbc(DEMO_DBC, "demo.dbc")
    for m in c.messages.values():
        m.cluster = c
        for s in m.signals:
            s.message = m
    rpm = next(s for s in c.messages[256].signals if s.name == "EngineSpeed")
    # raw 0x2EE0 = 12000 -> *0.25 = 3000 rpm
    assert decode_signal(bytes([0xE0, 0x2E, 0, 0, 0, 0, 0, 0]), rpm) == 3000.0
    ts = next(s for s in c.messages[768].signals if s.name == "TempSelect")
    assert value_label(ts, 1) == "Ambient"


def test_series_and_value_at():
    c = parse_dbc(DEMO_DBC, "demo.dbc")
    for m in c.messages.values():
        m.cluster = c
        for s in m.signals:
            s.message = m
    store = FrameStore()
    for k in range(5):
        rpm = int((3000 + k * 100) / 0.25) & 0xFFFF
        store.add(k * 0.01, 256, False, 1, 0, bytes([rpm & 0xFF, rpm >> 8, 0, 0, 0, 0, 0, 0]))
    rpm_sig = next(s for s in c.messages[256].signals if s.name == "EngineSpeed")
    t, v = extract_series(store, rpm_sig)
    assert len(t) == 5
    assert abs(v[0] - 3000.0) < 1e-6
    assert abs(value_at(t, v, 0.025) - 3200.0) < 1e-6
