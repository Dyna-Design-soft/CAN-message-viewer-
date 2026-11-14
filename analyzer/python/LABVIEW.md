# Streaming from LabVIEW

1. Start the bridge: `python ia_bridge.py` (or `--host 0.0.0.0` when LabVIEW runs on another PC).
2. In LabVIEW: **TCP Open Connection** (address `localhost`, port `8766`).
3. Send the channel description once, as a JSON string ending in a line feed:
   `{"type":"meta","names":["AI0","AI1"],"units":["V","V"],"rate":20000}` + `\n`
4. In the acquisition loop, after **DAQmx Read (Analog 2D DBL, NChan NSamp)**:
   * **Simple (JSON):** *Flatten To JSON* a cluster `{dt: DBL, ch: 2D array}` → append `\n` → **TCP Write**.
     The 2D array must be channel-major (row = channel), which is what DAQmx Read returns.
   * **Fast (binary, recommended ≥ 10 kS/s):** build a string with
     `"IAL1"` + U32 channels + U32 samples + DBL t0 + DBL dt + SGL data (row by row), all **little-endian**.
     Use *Flatten To String* with byte order = little-endian, *prepend array or string size* = FALSE,
     after converting the 2D array to SGL. Set t0 = NaN to continue from the previous block.
5. **TCP Close Connection** when done.

UDP alternative: **UDP Open** + **UDP Write** to port `8767`, one message per datagram (keep each under ~60 kB).
