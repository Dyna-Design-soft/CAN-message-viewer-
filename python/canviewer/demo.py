"""First-run demo: an embedded DBC + a synthetic ~30 s log (mirrors the web app)."""
from __future__ import annotations

import math
import time

from .core.dbc_parser import parse_dbc
from .core.frame_store import FrameStore, ERR

DEMO_DBC = """VERSION "demo 1.0"
BU_ ECU1 Gateway
BO_ 256 EngineData: 8 ECU1
 SG_ EngineSpeed : 0|16@1+ (0.25,0) [0|16383.75] "rpm" Gateway
 SG_ VehicleSpeed : 16|16@1+ (0.01,0) [0|655.35] "km/h" Gateway
 SG_ EngineTemp : 32|8@1+ (1,-40) [-40|215] "degC" Gateway
 SG_ ThrottlePos : 40|8@1+ (1,0) [0|100] "%" Gateway
BO_ 768 Climate: 4 ECU1
 SG_ TempSelect M : 0|8@1+ (1,0) [0|1] "" Gateway
 SG_ CabinTemp m0 : 8|16@1+ (0.1,-40) [-40|80] "degC" Gateway
 SG_ AmbientTemp m1 : 8|16@1+ (0.1,-40) [-40|80] "degC" Gateway
CM_ BO_ 256 "Engine status frame";
VAL_ 768 TempSelect 0 "Cabin" 1 "Ambient" ;
"""

DURATION = 30.0


def build_demo_store() -> FrameStore:
    s = FrameStore()
    s.t0_epoch = time.time() - DURATION
    steps = int(DURATION / 0.01)
    for k in range(steps + 1):
        t = k * 0.01
        rpm = 3000 + 2000 * math.sin(t * 0.8)
        speed = 60 + 40 * math.sin(t * 0.3 + 1)
        temp = 90 + 15 * math.sin(t * 0.05)
        throttle = 20 + 80 * (0.5 + 0.5 * math.sin(t * 1.7))
        raw_rpm = int(round(rpm / 0.25)) & 0xFFFF
        raw_spd = int(round(speed / 0.01)) & 0xFFFF
        s.add(t, 0x100, False, 1, 0, bytes([
            raw_rpm & 0xFF, raw_rpm >> 8, raw_spd & 0xFF, raw_spd >> 8,
            (int(round(temp)) + 40) & 0xFF, int(round(throttle)) & 0xFF, 0, 0]))
        if k % 50 == 0:
            sel = int(t // 2) % 2
            val = (15 + 10 * math.sin(t * 0.02)) if sel else (22 + 3 * math.sin(t * 0.1))
            raw = int(round((val + 40) * 10)) & 0xFFFF
            s.add(t, 0x300, False, 1, 0, bytes([sel, raw & 0xFF, raw >> 8, 0]))
        if k > 0 and k % 700 == 0:
            s.add(t, 0, False, 1, ERR, None)
    return s


def load_demo():
    cluster = parse_dbc(DEMO_DBC, "demo.dbc")
    cluster.source = DEMO_DBC
    return cluster, build_demo_store()
