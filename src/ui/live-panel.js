// Live panel: connect to a live source (WebView2 host or the simulator),
// show incoming frames four ways (raw grid, decoded signals, scrolling trend,
// trace list) and record to ASC/CSV/BLF.

/* global uPlot */
import { SimSource } from '../live/sim-source.js';
import { WebView2Bridge } from '../live/bridge.js';
import { Recorder } from '../live/recorder.js';
import { normalizeFrame } from '../live/ingest.js';
import { FrameFlags } from '../core/frame-store.js';
import { decodeSignal, valueLabel } from '../core/decoder.js';
import { formatId, bytesToHex } from '../util/hex.js';

const LIVE_CAP = 200000; // ring-buffer frame cap for the live store
const TRIM_CHUNK = 20000;
const TRACE_CAP = 4000;

export function initLivePanel(app) {
  const sourceSel = document.getElementById('live-source');
  const startBtn = document.getElementById('live-start');
  const stopBtn = document.getElementById('live-stop');
  const statusEl = document.getElementById('live-status');
  const recBtn = document.getElementById('rec-toggle');
  const recStatus = document.getElementById('rec-status');

  const recorder = new Recorder();
  app.recorder = recorder;

  let source = null;
  let running = false;
  let activeView = 'live-grid';
  const grid = new Map(); // key -> {ch,id,ext,name,dlc,hex,count,lastT,cycleMs,flags}
  const trace = []; // rolling formatted lines
  const liveTrend = new LiveTrend(app, document.getElementById('live-trend-plot'));

  // ---- subtab switching ----
  const subtabs = document.querySelectorAll('.subtab-bar .subtab');
  for (const st of subtabs) {
    st.addEventListener('click', () => {
      for (const s of subtabs) s.classList.toggle('active', s === st);
      for (const v of document.querySelectorAll('.live-view')) {
        v.classList.toggle('active', v.id === st.dataset.view);
      }
      activeView = st.dataset.view;
      if (activeView === 'live-trend') liveTrend.resize();
      refresh(true);
    });
  }

  // ---- source lifecycle ----
  startBtn.addEventListener('click', start);
  stopBtn.addEventListener('click', stop);

  function start() {
    if (running) return;
    source = sourceSel.value === 'sim' ? new SimSource({ batchMs: 100 }) : new WebView2Bridge();
    source.onMessage = onMessage;
    grid.clear();
    trace.length = 0;
    app.liveStore.clear();
    liveTrend.reset();
    source.start();
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    recBtn.disabled = false;
    sourceSel.disabled = true;
    setStatus('running', 'connecting…');
    app.bus.emit('live:state', { state: 'running', source: source.name });
  }

  function stop() {
    if (!running) return;
    source?.stop();
    running = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    recBtn.disabled = true;
    sourceSel.disabled = false;
    if (recorder.recording) toggleRecord();
    setStatus('', 'stopped');
    app.bus.emit('live:state', { state: 'stopped', source: source?.name });
  }

  // ---- recording ----
  recBtn.addEventListener('click', toggleRecord);
  async function toggleRecord() {
    if (!recorder.recording) {
      recorder.start(app.liveStore.t0Epoch);
      recBtn.classList.add('recording');
      recBtn.textContent = '■ Stop & save';
      recStatus.textContent = 'recording…';
    } else {
      recorder.stop();
      recBtn.classList.remove('recording');
      recBtn.textContent = '● Record';
      const n = recorder.count;
      recStatus.textContent = `saving ${n.toLocaleString()} frames…`;
      const fmt = await pickFormat();
      if (fmt) {
        try {
          await recorder.save(fmt);
          recStatus.textContent = `saved ${n.toLocaleString()} frames (${fmt.toUpperCase()})`;
        } catch (err) {
          recStatus.textContent = 'save failed: ' + err.message;
        }
      } else {
        recStatus.textContent = `${n.toLocaleString()} frames recorded (not saved)`;
      }
    }
  }

  // ---- incoming messages ----
  function onMessage(msg) {
    switch (msg.type) {
      case 'hello':
        app.liveStore.t0Epoch = msg.t0Epoch ?? Date.now() / 1000;
        app.liveChannels = msg.channels || [];
        setStatus('running', `${source.name} · ${(msg.channels || []).length} ch`);
        break;
      case 'frames':
        ingestFrames(msg.frames || []);
        break;
      case 'busStatus':
        setStatus('running', `bus ${msg.state} · load ${(msg.busLoad ?? 0).toFixed(0)}%`);
        break;
      case 'error':
        setStatus('error', msg.message || 'error');
        break;
    }
  }

  function ingestFrames(frames) {
    const store = app.liveStore;
    for (const raw of frames) {
      const f = normalizeFrame(raw);
      store.add(f.t, f.id, f.ext, f.ch, f.flags, f.data);
      recorder.feed(f.t, f.id, f.ext, f.ch, f.flags, f.data);
      updateGrid(f);
      if (activeView === 'live-trace') pushTrace(f);
      liveTrend.feed(f);
    }
    // ring-buffer trim
    if (store.count > LIVE_CAP) store.dropOldest(TRIM_CHUNK);
  }

  function updateGrid(f) {
    const key = f.ch * 0x100000000 + ((f.id >>> 0) | (f.ext ? 0x80000000 : 0));
    let row = grid.get(key);
    if (!row) {
      row = { ch: f.ch, id: f.id, ext: f.ext, count: 0, lastT: f.t, cycleMs: null };
      grid.set(key, row);
    } else {
      const dt = (f.t - row.lastT) * 1000;
      if (dt > 0) row.cycleMs = row.cycleMs == null ? dt : row.cycleMs * 0.8 + dt * 0.2;
      row.lastT = f.t;
    }
    row.count++;
    row.flags = f.flags;
    row.dlc = f.data.length;
    row.hex = f.flags & FrameFlags.ERR ? '(error frame)' : bytesToHex(f.data);
  }

  function pushTrace(f) {
    const dir = f.flags & FrameFlags.TX ? 'Tx' : 'Rx';
    const kind = f.flags & FrameFlags.ERR ? 'ERR ' : f.flags & FrameFlags.FD ? 'FD  ' : '    ';
    const idStr = (f.flags & FrameFlags.ERR ? '' : formatId(f.id, f.ext)).padEnd(10);
    const line = `${f.t.toFixed(6)}  ${f.ch}  ${kind}${idStr} ${dir} [${String(f.data.length).padStart(2)}]  ${f.flags & FrameFlags.ERR ? '' : bytesToHex(f.data)}`;
    trace.push({ line, err: !!(f.flags & FrameFlags.ERR) });
    if (trace.length > TRACE_CAP) trace.splice(0, trace.length - TRACE_CAP);
  }

  // ---- rendering (throttled) ----
  const gridBody = document.querySelector('#live-grid-table tbody');
  const sigBody = document.querySelector('#live-signal-table tbody');
  const traceEl = document.getElementById('trace-list');
  const autoscroll = document.getElementById('trace-autoscroll');
  document.getElementById('trace-clear').addEventListener('click', () => {
    trace.length = 0;
    traceEl.textContent = '';
  });

  function refresh(force) {
    if (!running && !force) return;
    if (activeView === 'live-grid') renderGrid();
    else if (activeView === 'live-signals') renderSignals();
    else if (activeView === 'live-trace') renderTrace();
    else if (activeView === 'live-trend') liveTrend.render();
  }

  function renderGrid() {
    const rows = [...grid.values()].sort((a, b) => a.ch - b.ch || a.id - b.id);
    gridBody.textContent = '';
    for (const r of rows) {
      const msg = r.ext || !(r.flags & FrameFlags.ERR) ? app.channelMap.messageFor(r.ch, r.id, r.ext) : null;
      const tr = document.createElement('tr');
      cells(tr, [
        r.ch,
        r.flags & FrameFlags.ERR ? '—' : formatId(r.id, r.ext),
        r.flags & FrameFlags.ERR ? 'Err' : r.ext ? 'Ext' : 'Std',
        msg?.name ?? '',
        r.dlc,
        r.hex,
        r.cycleMs != null ? r.cycleMs.toFixed(1) + ' ms' : '—',
        r.count,
      ]);
      if (r.flags & FrameFlags.ERR) tr.style.color = 'var(--err)';
      gridBody.appendChild(tr);
    }
  }

  function renderSignals() {
    sigBody.textContent = '';
    document.getElementById('live-signals-hint').hidden = app.selection.size > 0;
    for (const q of app.selection) {
      const sig = app.dbc.signalByQualifiedName(q);
      if (!sig) continue;
      const latest = latestFrameFor(sig.message);
      let value = null, raw = null, label = null;
      if (latest) {
        value = decodeSignal(latest.data, sig);
        if (value != null) {
          raw = Math.round((value - sig.offset) / sig.factor);
          label = valueLabel(sig, value);
        }
      }
      const tr = document.createElement('tr');
      cells(tr, [
        sig.name,
        value == null ? '—' : label ? `${fmt(value)} (${label})` : fmt(value),
        sig.unit || '',
        raw == null ? '—' : String(raw),
        sig.message.name,
      ]);
      sigBody.appendChild(tr);
    }
  }

  function latestFrameFor(message) {
    for (const [key, row] of grid) {
      if (row.id === message.id && row.ext === message.extended) {
        if (app.channelMap.messageFor(row.ch, row.id, row.ext) === message) {
          // reconstruct latest data from store's last matching frame
          const store = app.liveStore;
          for (let i = store.count - 1; i >= 0 && i > store.count - 5000; i--) {
            if (store.rawId(i) === message.id && store.isExt(i) === message.extended && store.ch[i] === row.ch) {
              return { data: store.data(i) };
            }
          }
        }
      }
    }
    return null;
  }

  function renderTrace() {
    traceEl.textContent = trace.map((t) => t.line).join('\n');
    if (autoscroll.checked) traceEl.scrollTop = traceEl.scrollHeight;
  }

  function setStatus(cls, text) {
    statusEl.className = 'live-status' + (cls ? ' ' + cls : '');
    statusEl.textContent = text;
  }

  // selection changes affect live signals + trend
  app.bus.on('selection:changed', () => {
    liveTrend.onSelectionChanged();
    if (activeView === 'live-signals') renderSignals();
  });
  app.bus.on('tab:changed', ({ panel }) => {
    if (panel === 'panel-live' && activeView === 'live-trend') liveTrend.resize();
  });
  document.getElementById('live-trend-window').addEventListener('change', (e) => {
    liveTrend.windowSec = Number(e.target.value);
  });

  // render loop ~10 Hz
  setInterval(() => refresh(false), 100);
}

// Lightweight live scrolling trend: per-signal rolling buffers + one uPlot,
// grouped onto multiple Y axes by unit. Independent of the analysis graphs.
class LiveTrend {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.windowSec = 30;
    this.buffers = new Map(); // qname -> {t:[], v:[], signal}
    this.uplot = null;
    this.tNow = 0;
  }

  reset() {
    this.buffers.clear();
    this.tNow = 0;
    this.#build();
  }

  onSelectionChanged() {
    for (const q of this.app.selection) {
      if (!this.buffers.has(q)) {
        const sig = this.app.dbc.signalByQualifiedName(q);
        if (sig) this.buffers.set(q, { t: [], v: [], signal: sig });
      }
    }
    for (const q of [...this.buffers.keys()]) {
      if (!this.app.selection.has(q)) this.buffers.delete(q);
    }
    this.#build();
  }

  feed(f) {
    this.tNow = Math.max(this.tNow, f.t);
    if (this.buffers.size === 0) return;
    for (const [q, buf] of this.buffers) {
      const sig = buf.signal;
      const msg = sig.message;
      if (f.id !== msg.id || f.ext !== msg.extended) continue;
      if (this.app.channelMap.messageFor(f.ch, f.id, f.ext) !== msg) continue;
      const v = decodeSignal(f.data, sig);
      if (v == null) continue;
      buf.t.push(f.t);
      buf.v.push(v);
    }
  }

  #trim() {
    const cutoff = this.tNow - this.windowSec * 1.2;
    for (const buf of this.buffers.values()) {
      let drop = 0;
      while (drop < buf.t.length && buf.t[drop] < cutoff) drop++;
      if (drop > 0) {
        buf.t.splice(0, drop);
        buf.v.splice(0, drop);
      }
    }
  }

  #build() {
    this.uplot?.destroy();
    this.uplot = null;
    this.container.textContent = '';
    if (this.buffers.size === 0) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = 'Tick signals in the Analysis tab to trend them live.';
      this.container.appendChild(p);
      return;
    }
    const unitScales = new Map();
    const series = [{}];
    const axes = [{ stroke: '#8b949e', grid: { stroke: '#2b3138' } }];
    let side = 0;
    let ci = 0;
    for (const buf of this.buffers.values()) {
      const unit = buf.signal.unit || '—';
      let scale = unitScales.get(unit);
      if (!scale) {
        scale = 'y' + unitScales.size;
        unitScales.set(unit, scale);
        axes.push({ scale, stroke: '#8b949e', side: side % 2 === 0 ? 3 : 1, label: unit, size: 44, grid: { show: unitScales.size === 1, stroke: '#2b3138' } });
        side++;
      }
      series.push({
        label: buf.signal.name,
        stroke: COLORS[ci++ % COLORS.length],
        width: 1.3,
        scale,
        spanGaps: false,
      });
    }
    this.uplot = new uPlot(
      { width: this.container.clientWidth || 600, height: 260, series, axes, scales: { x: { time: false } }, cursor: { show: true } },
      [[], ...[...this.buffers.values()].map(() => [])],
      this.container,
    );
  }

  render() {
    if (!this.uplot) {
      if (this.buffers.size > 0) this.#build();
      if (!this.uplot) return;
    }
    this.#trim();
    // shared x = union of all buffer timestamps (they differ per message rate)
    const xsSet = new Set();
    for (const buf of this.buffers.values()) for (const t of buf.t) xsSet.add(t);
    const xs = [...xsSet].sort((a, b) => a - b);
    const cols = [...this.buffers.values()].map((buf) => {
      const col = new Array(xs.length).fill(null);
      let p = 0;
      for (let i = 0; i < xs.length; i++) {
        while (p < buf.t.length && buf.t[p] <= xs[i]) p++;
        if (p > 0) col[i] = buf.v[p - 1];
      }
      return col;
    });
    this.uplot.setData([xs, ...cols]);
    if (this.tNow > 0) this.uplot.setScale('x', { min: this.tNow - this.windowSec, max: this.tNow });
  }

  resize() {
    if (this.uplot) this.uplot.setSize({ width: this.container.clientWidth || 600, height: this.uplot.height });
  }
}

const COLORS = ['#4da3ff', '#ff8f6b', '#7be0a8', '#e0c93c', '#c58bff', '#6be0ff', '#ff7ba8', '#9bd85a'];

// Small modal asking which format to save the recording as.
function pickFormat() {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    back.innerHTML = `
      <div class="modal" style="width:min(420px,90vw)">
        <div class="modal-head"><h2>Save recording as</h2></div>
        <div class="modal-toolbar" style="justify-content:center;gap:10px">
          <button class="btn btn-accent" data-fmt="asc">ASC</button>
          <button class="btn" data-fmt="csv">CSV</button>
          <button class="btn" data-fmt="blf">BLF</button>
          <button class="btn" data-fmt="">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(back);
    back.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fmt]');
      if (!b && e.target !== back) return;
      const fmt = b ? b.dataset.fmt : '';
      back.remove();
      resolve(fmt || null);
    });
  });
}

function cells(tr, values) {
  for (const v of values) {
    const td = document.createElement('td');
    td.textContent = String(v);
    tr.appendChild(td);
  }
}
function fmt(v) {
  if (v == null || !isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : (+v.toPrecision(6)).toString();
}
