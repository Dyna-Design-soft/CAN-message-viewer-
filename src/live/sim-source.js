// Simulated live CAN source.
//
// Speaks the exact same message protocol as the WebView2 bridge (live/bridge.js),
// so the whole live UI can be developed and tested in a plain browser without
// the host application. See docs in bridge.js for the message schema.
//
// Simulated traffic (matches test/fixtures/demo.dbc):
//   0x100 EngineData   10 ms  classic std  8B : EngineSpeed (rpm sine), VehicleSpeed, EngineTemp
//   0x200 SensorArray  50 ms  CAN FD  std 64B : counter + sawtooth pattern
//   0x1CFF00EE Counter 100 ms classic ext  8B : free-running 32-bit counter
//   0x300 Climate      500 ms classic std  4B : slow temperature ramp + mux demo
//   error frame roughly every 5 s on channel 1

export class SimSource {
  constructor({ batchMs = 100 } = {}) {
    this.batchMs = batchMs;
    this.onMessage = null; // fn(msg) — consumer sets this
    this.running = false;
    this.#timer = null;
    this.#simT = 0;
  }

  #timer;
  #simT; // simulated bus time, seconds
  #seq = 0;
  #next = { engine: 0, sensor: 0, counter: 0, climate: 0, error: 4.7 };
  #counter = 0;

  get name() {
    return 'Simulated bus';
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.#emit({
      type: 'hello',
      protocolVersion: 1,
      hostVersion: 'sim-1.0',
      channels: [
        { ch: 1, name: 'CAN1 (sim)', fd: true, bitrate: 500000, dataBitrate: 2000000 },
      ],
      t0Epoch: Date.now() / 1000 - this.#simT,
    });
    let last = performance.now();
    this.#timer = setInterval(() => {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, 1); // clamp after tab-sleep
      last = now;
      this.#tick(dt);
    }, this.batchMs);
  }

  stop() {
    if (!this.#timer) return;
    clearInterval(this.#timer);
    this.#timer = null;
    this.running = false;
  }

  /** Handle a control message from the UI (same surface as the bridge). */
  post(msg) {
    if (msg?.type !== 'control') return;
    if (msg.action === 'start') this.start();
    else if (msg.action === 'stop' || msg.action === 'pause') this.stop();
  }

  #emit(msg) {
    this.onMessage?.(msg);
  }

  #tick(dt) {
    const tEnd = this.#simT + dt;
    const frames = [];
    const push = (t, id, ext, fd, data, err = false) =>
      frames.push({
        t, ch: 1, id, ext, fd,
        brs: fd, esi: false, rtr: false, dir: 'rx', err,
        data,
      });

    // EngineData @10ms
    while (this.#next.engine <= tEnd) {
      const t = this.#next.engine;
      const rpm = 3000 + 2000 * Math.sin(t * 0.8); // rpm
      const speed = 60 + 40 * Math.sin(t * 0.3 + 1); // km/h
      const temp = 90 + 15 * Math.sin(t * 0.05); // degC
      const rawRpm = Math.round(rpm / 0.25) & 0xffff; // factor 0.25
      const rawSpd = Math.round(speed / 0.01) & 0xffff; // factor 0.01
      const rawTmp = Math.round(temp + 40) & 0xff; // offset -40
      const b = new Uint8Array(8);
      b[0] = rawRpm & 0xff; b[1] = rawRpm >> 8; // Intel u16
      b[2] = rawSpd & 0xff; b[3] = rawSpd >> 8;
      b[4] = rawTmp;
      b[5] = Math.round(20 + 80 * (0.5 + 0.5 * Math.sin(t * 1.7))); // ThrottlePos %
      push(t, 0x100, false, false, hex(b));
      this.#next.engine += 0.01;
    }

    // SensorArray @50ms — CAN FD, 64 bytes
    while (this.#next.sensor <= tEnd) {
      const t = this.#next.sensor;
      const b = new Uint8Array(64);
      const c = this.#counter & 0xffff;
      b[0] = c & 0xff; b[1] = c >> 8;
      for (let i = 2; i < 64; i++) b[i] = (i * 4 + this.#counter) & 0xff;
      push(t, 0x200, false, true, hex(b));
      this.#next.sensor += 0.05;
    }

    // Counter @100ms — extended ID
    while (this.#next.counter <= tEnd) {
      const t = this.#next.counter;
      this.#counter++;
      const b = new Uint8Array(8);
      const v = this.#counter >>> 0;
      b[0] = v & 0xff; b[1] = (v >> 8) & 0xff; b[2] = (v >> 16) & 0xff; b[3] = (v >> 24) & 0xff;
      push(t, 0x1cff00ee, true, false, hex(b));
      this.#next.counter += 0.1;
    }

    // Climate @500ms — multiplexed message: selector byte 0 (m0: cabin, m1: ambient)
    while (this.#next.climate <= tEnd) {
      const t = this.#next.climate;
      const sel = Math.floor(t * 2) % 2;
      const cabin = 22 + 3 * Math.sin(t * 0.1);
      const ambient = 15 + 10 * Math.sin(t * 0.02);
      const raw = Math.round(((sel ? ambient : cabin) + 40) * 10) & 0xffff; // 0.1°C, -40 offset
      const b = new Uint8Array([sel, raw & 0xff, raw >> 8, 0]);
      push(t, 0x300, false, false, hex(b));
      this.#next.climate += 0.5;
    }

    // Occasional error frame
    while (this.#next.error <= tEnd) {
      push(this.#next.error, 0, false, false, '', true);
      this.#next.error += 5 + Math.random() * 3;
    }

    this.#simT = tEnd;
    if (frames.length) {
      frames.sort((a, b) => a.t - b.t);
      this.#emit({ type: 'frames', seq: this.#seq++, frames });
    }
    // Bus status once a second
    if (Math.floor(tEnd) !== Math.floor(tEnd - dt)) {
      this.#emit({
        type: 'busStatus',
        ch: 1,
        state: 'errorActive',
        busLoad: 18 + 6 * Math.sin(tEnd * 0.2),
        rxErrCount: 0,
        txErrCount: 0,
      });
    }
  }
}

function hex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s.toUpperCase();
}
