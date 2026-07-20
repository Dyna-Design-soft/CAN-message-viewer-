// Demo dataset for first-run experience: an embedded DBC plus a synthetic
// ~30 s log generated in-code (no fetch, so it works served or from file://).
// Loaded on startup only when nothing else is loaded; users can Close file /
// unload the DBC to start fresh.

import { parseDbc } from './core/dbc-parser.js';
import { FrameStore, FrameFlags } from './core/frame-store.js';

const DEMO_DBC = `VERSION "demo 1.0"
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
BO_ 2633957614 CounterMsg: 8 ECU1
 SG_ FreeCounter : 0|32@1+ (1,0) [0|4294967295] "" Gateway
CM_ BO_ 256 "Engine status frame";
VAL_ 768 TempSelect 0 "Cabin" 1 "Ambient" ;
`;

const DURATION = 30; // seconds

function buildDemoStore() {
  const s = new FrameStore();
  s.t0Epoch = Date.now() / 1000 - DURATION;
  let counter = 0;
  const steps = Math.round(DURATION / 0.01);
  for (let k = 0; k <= steps; k++) {
    const t = k * 0.01;

    // EngineData @10 ms
    const rpm = 3000 + 2000 * Math.sin(t * 0.8);
    const speed = 60 + 40 * Math.sin(t * 0.3 + 1);
    const temp = 90 + 15 * Math.sin(t * 0.05);
    const throttle = 20 + 80 * (0.5 + 0.5 * Math.sin(t * 1.7));
    const rawRpm = Math.round(rpm / 0.25) & 0xffff;
    const rawSpd = Math.round(speed / 0.01) & 0xffff;
    s.add(t, 0x100, false, 1, 0, new Uint8Array([
      rawRpm & 0xff, rawRpm >> 8,
      rawSpd & 0xff, rawSpd >> 8,
      (Math.round(temp) + 40) & 0xff,
      Math.round(throttle) & 0xff, 0, 0,
    ]));

    // CounterMsg @100 ms (extended id)
    if (k % 10 === 0) {
      counter++;
      s.add(t, 0x1cff00ee, true, 1, 0, new Uint8Array([
        counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff, (counter >> 24) & 0xff, 0, 0, 0, 0,
      ]));
    }

    // Climate @500 ms (multiplexed: alternate cabin / ambient)
    if (k % 50 === 0) {
      const sel = Math.floor(t / 2) % 2;
      const val = sel ? 15 + 10 * Math.sin(t * 0.02) : 22 + 3 * Math.sin(t * 0.1);
      const raw = Math.round((val + 40) * 10) & 0xffff;
      s.add(t, 0x300, false, 1, 0, new Uint8Array([sel, raw & 0xff, raw >> 8, 0]));
    }

    // occasional error frame
    if (k > 0 && k % 700 === 0) s.add(t, 0, false, 1, FrameFlags.ERR, null);
  }
  return s;
}

/** Load demo DBC + log and jump to the Analysis tab with signals pre-plotted. */
export function loadDemo(app) {
  app.dbc.add(parseDbc(DEMO_DBC, 'demo.dbc'));
  app.bus.emit('dbc:changed', { clusters: app.dbc.clusters });

  const store = buildDemoStore();
  app.adoptLog(store, 'demo.asc (sample data)', 'Demo');

  // Show the Analysis tab first so the graph panes have real layout dimensions,
  // then plot a few signals in split view.
  app.selectPanel('panel-analysis');
  app.applySelection([
    'demo/EngineData/EngineSpeed',
    'demo/EngineData/VehicleSpeed',
    'demo/EngineData/EngineTemp',
  ]);
}
