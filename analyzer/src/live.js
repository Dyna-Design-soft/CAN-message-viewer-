// LIVE mode: streams data from a Python / LabVIEW application into the analyzer.
// Browsers can only open WebSocket connections, so TCP / UDP producers go through the
// bundled zero-dependency bridge (python/ia_bridge.py) which forwards to WebSocket.
// Wire formats accepted (from the bridge or any WebSocket server):
//   JSON text:  {"type":"meta","names":[..],"units":[..],"rate":20000}
//               {"t0":0.0,"dt":5e-5,"ch":[[..ch0..],[..ch1..]]}       channel-major block
//               {"t":[..],"ch":[[..],[..]]}  |  {"t":1.23,"v":[..]}  |  {"t":1.23,"values":{"name":v}}
//   Binary:     "IAL1" | u32 nch | u32 ns | f64 t0 | f64 dt | f32[nch*ns] channel-major (little endian)
//               (t0 = NaN → continue from the previous block)
import { state, compactFull } from './bigdata.js';

const L = {
  ws: null, sim: null, connected: false, paused: false,
  names: [], units: [], nch: 0, rate: 0, metaRate: 0,
  cap: 0, head: 0, count: 0, t: null, ch: [], lastT: NaN, nextT: 0,
  rec: null, stats: { msgs: 0, samples: 0, bytes: 0, last: performance.now(), msgRate: 0, sRate: 0, drops: 0 },
  bufSec: 30, winSec: 10, visible: new Set(), mirror: false, offlineFull: null, reconnect: true, lastMsg: 0,
};
let api, ui = {};

// ---------------- ring buffer ----------------
function ensureChannels(n) {
  if (n <= L.nch && L.t) return;
  for (let i = L.nch; i < n; i++) { if (!L.names[i]) L.names[i] = `CH${i}`; if (L.units[i] == null) L.units[i] = ''; }
  L.nch = n; allocate(true); buildTiles();
}
function allocate(keep) {
  const rate = L.metaRate || L.rate || 1000;
  const cap = Math.min(Math.max(20000, Math.ceil(rate * L.bufSec * 1.1)), Math.floor(1.5e8 / Math.max(1, L.nch)));
  if (keep && L.t && L.cap === cap && L.ch.length === L.nch) return;
  const old = keep && L.t ? snapshotArrays() : null;
  L.cap = cap; L.t = new Float64Array(cap); L.ch = Array.from({ length: L.nch }, () => new Float32Array(cap)); L.head = 0; L.count = 0;
  if (old) push(old.t, old.ch);
}
function push(t, ch) { // t: Float64Array/Array, ch: arrays per channel (same length)
  const n = t.length; if (!n) return;
  let s = 0; if (n > L.cap) s = n - L.cap;
  let i = s;
  while (i < n) { // copy in contiguous runs up to the ring end
    const h = L.head, run = Math.min(n - i, L.cap - h);
    if (ArrayBuffer.isView(t)) L.t.set(t.subarray(i, i + run), h); else for (let k = 0; k < run; k++) L.t[h + k] = t[i + k];
    for (let c = 0; c < L.nch; c++) {
      const a = ch[c], dst = L.ch[c];
      if (!a) dst.fill(NaN, h, h + run);
      else if (ArrayBuffer.isView(a) && a.length >= i + run) dst.set(a.subarray(i, i + run), h);
      else for (let k = 0; k < run; k++) { const v = a[i + k]; dst[h + k] = v == null ? NaN : v; }
    }
    L.head = (h + run) % L.cap; i += run;
  }
  L.count = Math.min(L.cap, L.count + n - s);
  L.lastT = t[n - 1];
  if (L.rec) { L.rec.t.push(Float64Array.from(t)); L.rec.ch.push(Array.from({ length: L.nch }, (_, c) => Float32Array.from(ch[c] || new Float32Array(n).fill(NaN)))); L.rec.n += n; }
  L.stats.samples += n;
}
function snapshotArrays(sec) {
  let n = L.count; if (sec) { const lim = L.lastT - sec; n = 0; for (let k = 1; k <= L.count; k++) { if (L.t[(L.head - k + L.cap) % L.cap] < lim) break; n = k; } }
  const t = new Float64Array(n), ch = Array.from({ length: L.nch }, () => new Float32Array(n));
  const start = (L.head - n + L.cap) % L.cap;
  for (let i = 0; i < n; i++) { const j = (start + i) % L.cap; t[i] = L.t[j]; for (let c = 0; c < L.nch; c++) ch[c][i] = L.ch[c][j]; }
  return { t, ch };
}

// ---------------- message decoding ----------------
function ingest(msg) {
  if (L.paused) return;
  L.stats.msgs++; L.lastMsg = performance.now();
  if (msg instanceof ArrayBuffer) { L.stats.bytes += msg.byteLength; return ingestBinary(msg); }
  L.stats.bytes += msg.length;
  let j; try { j = JSON.parse(msg); } catch { L.stats.drops++; return; }
  if (Array.isArray(j)) { j.forEach(ingestJson); return; }
  ingestJson(j);
}
function ingestBinary(buf) {
  const dv = new DataView(buf);
  for (let off = 0; off + 28 <= buf.byteLength;) {
    if (dv.getUint32(off, false) !== 0x49414c31) { L.stats.drops++; return; } // 'IAL1'
    const nch = dv.getUint32(off + 4, true), ns = dv.getUint32(off + 8, true);
    let t0 = dv.getFloat64(off + 12, true); const dt = dv.getFloat64(off + 20, true);
    const len = 28 + 4 * nch * ns; if (off + len > buf.byteLength) { L.stats.drops++; return; }
    ensureChannels(nch);
    if (!(t0 === t0)) t0 = L.nextT;
    const t = new Float64Array(ns); for (let i = 0; i < ns; i++) t[i] = t0 + i * dt;
    const data = (off + 28) % 4 === 0 ? new Float32Array(buf, off + 28, nch * ns) : new Float32Array(buf.slice(off + 28, off + len));
    const ch = Array.from({ length: nch }, (_, c) => data.subarray(c * ns, (c + 1) * ns));
    if (dt > 0) L.rate = 1 / dt;
    L.nextT = t0 + ns * dt; push(t, ch); off += len;
  }
}
function ingestJson(j) {
  if (!j || typeof j !== 'object') return;
  if (j.type === 'meta' || j.names) {
    if (j.names) { L.names = j.names.map(String); L.units = (j.units || []).map((u) => String(u || '')); L.nch = 0; L.t = null; ensureChannels(L.names.length); }
    if (j.rate) { L.metaRate = Number(j.rate); allocate(true); }
    buildTiles();
    if (!j.ch && !j.v && !j.values && j.t == null) return;
  }
  if (j.values && typeof j.values === 'object' && !Array.isArray(j.values)) { // {t, values:{name:val}}
    for (const k of Object.keys(j.values)) if (!L.names.includes(k)) { L.names.push(k); L.units.push(''); }
    ensureChannels(L.names.length);
    j = { t: j.t, v: L.names.map((n) => j.values[n]) };
  }
  if (Array.isArray(j.v)) { // single sample
    ensureChannels(j.v.length);
    const t = j.t != null ? Number(j.t) : nowT();
    return push([t], j.v.map((x) => [x == null ? NaN : Number(x)]));
  }
  if (Array.isArray(j.ch)) { // block
    const ns = Math.max(...j.ch.map((a) => a.length)); ensureChannels(j.ch.length);
    let t;
    if (Array.isArray(j.t)) t = j.t.map(Number);
    else {
      const dt = Number(j.dt) || (L.metaRate ? 1 / L.metaRate : 0.001);
      const t0 = j.t0 != null ? Number(j.t0) : L.nextT || 0;
      t = new Float64Array(ns); for (let i = 0; i < ns; i++) t[i] = t0 + i * dt;
      L.nextT = t0 + ns * dt; L.rate = 1 / dt;
    }
    push(t, j.ch.map((a) => Float64Array.from(a, (x) => (x == null ? NaN : x))));
  }
}
let t0Wall = 0;
const nowT = () => { const n = performance.now() / 1000; if (!t0Wall) t0Wall = n; return n - t0Wall; };

// ---------------- connection ----------------
function connect() {
  disconnect(true);
  const src = ui.src.value;
  resetBuffer();
  if (src === 'sim') return startSim();
  let url = ui.url.value.trim(); if (!/^wss?:\/\//.test(url)) url = 'ws://' + url;
  L.reconnect = true;
  let ws;
  try { ws = L.ws = new WebSocket(url); } catch (e) { setStatus('err', 'Invalid address: ' + e.message); return; }
  ws.binaryType = 'arraybuffer';
  setStatus('wait', 'Connecting to ' + url + ' …');
  ws.onopen = () => { if (ws !== L.ws) return; L.connected = true; setStatus('ok', 'Connected · ' + url); try { ws.send(JSON.stringify({ type: 'hello', client: 'industrial-analyzer' })); } catch {} };
  ws.onmessage = (e) => { if (ws === L.ws) ingest(e.data); };
  ws.onerror = () => { if (ws === L.ws) setStatus('err', 'Connection error — is the bridge / server running at ' + url + '?'); };
  ws.onclose = () => {
    if (ws !== L.ws) return; // a superseded socket — ignore
    const was = L.connected; L.connected = false; L.ws = null;
    if (L.reconnect) { setStatus('err', (was ? 'Disconnected' : 'Cannot connect') + ' · retrying in 2 s'); clearTimeout(L.rt); L.rt = setTimeout(() => { if (L.reconnect) connect(); }, 2000); }
  };
}
function disconnect(quiet) {
  L.reconnect = false; clearTimeout(L.rt);
  if (L.ws) { const w = L.ws; L.ws = null; w.onmessage = w.onclose = w.onerror = w.onopen = null; try { w.close(); } catch {} }
  if (L.sim) { clearInterval(L.sim); L.sim = null; }
  L.connected = false; if (!quiet) setStatus('idle', 'Disconnected');
}
function resetBuffer() { L.names = []; L.units = []; L.nch = 0; L.t = null; L.count = 0; L.head = 0; L.rate = 0; L.metaRate = 0; L.nextT = 0; t0Wall = 0; L.visible = new Set(); buildTiles(); }
function startSim() {
  const fs = Number(ui.simRate.value) || 20000, nch = 8, block = Math.max(1, Math.round(fs / 50));
  ingestJson({ type: 'meta', names: ['Vibration X', 'Vibration Y', 'Motor current', 'Bus voltage', 'Pressure', 'Temperature', 'Speed', 'Torque'], units: ['g', 'g', 'A', 'V', 'bar', '°C', 'rpm', 'N·m'], rate: fs });
  let k = 0; const t0 = performance.now();
  L.connected = true; setStatus('ok', `Simulator · ${nch} channels @ ${fs.toLocaleString()} S/s`);
  L.sim = setInterval(() => {
    const due = Math.floor(((performance.now() - t0) / 1000) * fs) - k; if (due <= 0) return;
    const ns = Math.min(due, block * 4), ch = Array.from({ length: nch }, () => new Float32Array(ns));
    for (let i = 0; i < ns; i++) {
      const t = (k + i) / fs, r = () => Math.random() - 0.5;
      ch[0][i] = Math.sin(2 * Math.PI * 120 * t) * 0.8 + r() * 0.2 + (Math.random() < 2e-5 ? 4 : 0);
      ch[1][i] = Math.sin(2 * Math.PI * 85 * t + 1) * 0.6 + r() * 0.2;
      ch[2][i] = 12 + 3 * Math.sin(2 * Math.PI * 0.4 * t) + r() * 0.4;
      ch[3][i] = 400 + 4 * Math.sin(2 * Math.PI * 50 * t) + r();
      ch[4][i] = 5 + Math.sin(2 * Math.PI * 0.1 * t) + r() * 0.05;
      ch[5][i] = 60 + 10 * (1 - Math.exp(-t / 60)) + r() * 0.1;
      ch[6][i] = 1500 + 300 * Math.sin(2 * Math.PI * 0.05 * t) + r() * 5;
      ch[7][i] = 40 + 8 * Math.sin(2 * Math.PI * 0.4 * t + 0.5) + r();
    }
    const buf = new ArrayBuffer(28 + 4 * nch * ns), dv = new DataView(buf);
    dv.setUint32(0, 0x49414c31, false); dv.setUint32(4, nch, true); dv.setUint32(8, ns, true); dv.setFloat64(12, k / fs, true); dv.setFloat64(20, 1 / fs, true);
    const f = new Float32Array(buf, 28); ch.forEach((a, c) => f.set(a, c * ns));
    k += ns; ingest(buf);
  }, 20);
}

// ---------------- recording / hand-off to offline analysis ----------------
function toFull(t, ch, name) {
  const t0 = t.length ? t[0] : 0;
  const tt = Float64Array.from(t, (x) => x - t0);
  return { name, kind: 'Live', names: L.names.slice(0, L.nch), units: L.units.slice(0, L.nch), t: tt, data: ch.map((a) => a), sampleInfo: `Live capture (${L.rate ? Math.round(L.rate).toLocaleString() + ' S/s' : 'stream'})`, bytes: tt.length * (8 + 4 * ch.length), loadMs: 0 };
}
function analyze(full) {
  if (!full.t.length) return alert('No samples captured yet.');
  state.full = compactFull(full); state.a = 0; state.b = full.t.length;
  setMode('offline', true); api.showView(true); window.navigate('trends');
}
function toggleRecord() {
  if (L.rec) {
    const r = L.rec; L.rec = null; ui.rec.textContent = '● Record'; ui.rec.classList.remove('ia-recording');
    const n = r.n, t = new Float64Array(n), ch = Array.from({ length: L.nch }, () => new Float32Array(n));
    let o = 0; r.t.forEach((part, k) => { t.set(part, o); r.ch[k].forEach((a, c) => { if (ch[c]) ch[c].set(a.subarray(0, part.length), o); }); o += part.length; });
    L.lastRec = toFull(t, ch, `Live recording ${new Date(r.started).toLocaleString()}`);
    ui.recInfo.textContent = `Recorded ${n.toLocaleString()} samples × ${L.nch} ch`;
    ui.recActions.hidden = false;
  } else {
    if (!L.nch) return alert('Connect to a source first.');
    L.rec = { t: [], ch: [], n: 0, started: Date.now() }; ui.rec.textContent = '■ Stop'; ui.rec.classList.add('ia-recording'); ui.recActions.hidden = true;
  }
}
function saveCsv(full) {
  const blob = api.exportWindowCsv(full, 0, full.t.length), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = full.name.replace(/[^\w.-]+/g, '_') + '.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function mirrorTick() {
  if (!L.mirror || !L.nch || L.paused || document.hidden) return;
  if (mode !== 'live' || curPage() === 'live') return; // only while viewing analysis pages
  const s = snapshotArrays(L.winSec); if (s.t.length < 3) return;
  state.full = compactFull(toFull(s.t, s.ch, 'Live window')); state.a = 0; state.b = s.t.length; api.showView(false);
}

// ---------------- drawing ----------------
const COLORS = ['#58e0e0', '#ffbe67', '#a78bfa', '#f472b6', '#60a5fa', '#4ade80', '#f87171', '#facc15', '#2dd4bf', '#c084fc', '#fb923c', '#93c5fd'];
function draw() {
  requestAnimationFrame(draw);
  if (!ui.canvas || !document.body.contains(ui.canvas) || !ui.canvas.offsetParent) return;
  const now = performance.now(); if (now - (draw.last || 0) < 33) return; draw.last = now;
  const cv = ui.canvas, dpr = Math.min(2, devicePixelRatio || 1), W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const vis = [...L.visible].filter((i) => i < L.nch).slice(0, 12);
  c.font = '11px Segoe UI, system-ui, sans-serif';
  if (!L.count || !vis.length) { c.fillStyle = '#8fa7bc'; c.textAlign = 'center'; c.fillText(L.nch ? 'Select channels below to plot' : 'Waiting for data…', W / 2, H / 2); c.textAlign = 'left'; return; }
  const left = 8, right = 8, laneGap = 6, lanes = ui.overlay.checked ? 1 : vis.length, lh = (H - 22 - laneGap * (lanes - 1)) / lanes;
  const tEnd = L.lastT, tStart = tEnd - L.winSec, pw = W - left - right, px = Math.max(50, Math.floor(pw));
  // index range of window in ring (binary search over the ring in time order)
  const at = (k) => L.t[(L.head - L.count + k + L.cap) % L.cap];
  let lo = 0, hi = L.count; while (lo < hi) { const m = (lo + hi) >> 1; if (at(m) < tStart) lo = m + 1; else hi = m; }
  const first = lo, n = L.count - first, base = (L.head - L.count + first + L.cap) % L.cap;
  const mins = new Float32Array(px), maxs = new Float32Array(px);
  vis.forEach((ci, li) => {
    const lane = ui.overlay.checked ? 0 : li, y0 = 4 + lane * (lh + laneGap), arr = L.ch[ci];
    mins.fill(Infinity); maxs.fill(-Infinity);
    let gmin = Infinity, gmax = -Infinity;
    const x0 = n ? Math.max(0, Math.floor(((at(first) - tStart) / L.winSec) * px)) : 0, span = Math.max(1, px - x0), scale = span / Math.max(1, n);
    for (let k = 0, j = base; k < n; k++, j = j + 1 === L.cap ? 0 : j + 1) {
      const v = arr[j]; if (!(v > -Infinity && v < Infinity)) continue;
      const x = x0 + Math.min(span - 1, (k * scale) | 0);
      if (v < mins[x]) mins[x] = v; if (v > maxs[x]) maxs[x] = v; if (v < gmin) gmin = v; if (v > gmax) gmax = v;
    }
    if (gmin === Infinity) return;
    if (gmax - gmin < 1e-12) { gmin -= 1; gmax += 1; }
    const pad = (gmax - gmin) * 0.08; gmin -= pad; gmax += pad;
    const Y = (v) => y0 + lh - ((v - gmin) / (gmax - gmin)) * lh;
    if (!ui.overlay.checked || li === 0) { c.fillStyle = 'rgba(11,23,38,.85)'; c.fillRect(left, y0, pw, lh); c.strokeStyle = '#1d3349'; c.strokeRect(left + 0.5, y0 + 0.5, pw - 1, lh - 1); }
    c.strokeStyle = COLORS[ci % COLORS.length]; c.fillStyle = c.strokeStyle; c.lineWidth = 1.2; c.beginPath();
    let started = false, py = 0;
    for (let x = 0; x < px; x++) {
      if (mins[x] === Infinity) continue;
      const X = left + (x / px) * pw, a = Y(maxs[x]), b = Y(mins[x]);
      if (!started) { c.moveTo(X, (a + b) / 2); started = true; } else c.lineTo(X, py);
      c.lineTo(X, a); c.lineTo(X, b); py = b;
    }
    c.stroke();
    const label = `${L.names[ci]}${L.units[ci] ? ' [' + L.units[ci] + ']' : ''}`;
    const ty = ui.overlay.checked ? 16 + li * 14 : y0 + 14;
    const tag = (txt, x, y, color, alignRight) => { const w = c.measureText(txt).width + 8, X = alignRight ? x - w : x; c.fillStyle = 'rgba(8,17,28,.82)'; c.fillRect(X, y - 11, w, 15); c.fillStyle = color; c.fillText(txt, X + 4, y); };
    tag(label, left + 4, ty, COLORS[ci % COLORS.length]);
    if (!ui.overlay.checked) { tag(fmt(gmax - pad), W - right - 2, y0 + 13, '#8fa7bc', true); tag(fmt(gmin + pad), W - right - 2, y0 + lh - 4, '#8fa7bc', true); }
  });
  c.fillStyle = '#8fa7bc'; c.fillText(`${fmt(tStart)} s`, left, H - 5); c.textAlign = 'right'; c.fillText(`${fmt(tEnd)} s`, W - right, H - 5); c.textAlign = 'center'; c.fillText(`${L.winSec} s window`, W / 2, H - 5); c.textAlign = 'left';
}
const kfmt = (v) => (v >= 1e6 ? (v / 1e6).toFixed(2) + ' M' : v >= 1e3 ? (v / 1e3).toFixed(1) + ' k' : Math.round(v) + ' ');
const fmt = (v) => (!Number.isFinite(v) ? '—' : Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(3) : Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(3));

function tick() { // stats + tiles at 4 Hz
  const now = performance.now(), dt = (now - L.stats.last) / 1000;
  if (dt >= 1) { L.stats.msgRate = L.stats.msgs / dt; L.stats.sRate = L.stats.samples / dt; L.stats.bps = L.stats.bytes / dt; L.stats.msgs = L.stats.samples = L.stats.bytes = 0; L.stats.last = now; }
  if (!ui.stats) return;
  const stale = L.connected && now - L.lastMsg > 3000;
  ui.stats.innerHTML = [
    ['CHANNELS', L.nch || '—'], ['SAMPLE RATE', L.rate || L.metaRate ? `${Math.round(L.rate || L.metaRate).toLocaleString()} S/s` : '—'],
    ['THROUGHPUT', `${kfmt(L.stats.sRate)} S/s`], ['MESSAGES', `${L.stats.msgRate.toFixed(0)}/s · ${kfmt((L.stats.bps || 0) * 8)}b/s`],
    ['BUFFER', `${(L.count && L.lastT - L.t[(L.head - L.count + L.cap) % L.cap] || 0).toFixed(1)} s`], ['DROPPED', L.stats.drops],
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');
  if (stale) setStatus('wait', 'Connected · no data for ' + ((now - L.lastMsg) / 1000).toFixed(0) + ' s');
  else if (L.connected && ui.dot.dataset.s === 'wait' && L.lastMsg) setStatus('ok', ui.statusText.textContent.replace(/ · no data.*/, ''));
  if (L.rec) ui.recInfo.textContent = `● REC ${((Date.now() - L.rec.started) / 1000).toFixed(1)} s · ${L.rec.n.toLocaleString()} samples · ${(L.rec.n * (8 + 4 * L.nch) / 1048576).toFixed(1)} MB`;
  // tiles
  if (!L.count) return;
  const j = (L.head - 1 + L.cap) % L.cap;
  ui.tiles.querySelectorAll('[data-ci]').forEach((el) => { const ci = +el.dataset.ci; el.querySelector('b').textContent = fmt(L.ch[ci][j]); });
}

// ---------------- UI ----------------
const CSS = `
#live .ia-live-grid{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:16px}
#live .ia-conn label{display:block;font-size:11px;letter-spacing:.08em;color:#8fa7bc;margin:10px 0 5px}
#live .ia-conn .field{width:100%;box-sizing:border-box}
#live .ia-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
#live .ia-status{display:flex;align-items:center;gap:8px;font-size:13px;color:#cfe0ee;margin-top:12px;min-height:20px}
#live .ia-dot{width:10px;height:10px;border-radius:50%;background:#5b6b7c;flex-shrink:0}
#live .ia-dot[data-s=ok]{background:#4ade80;box-shadow:0 0 10px #4ade80}
#live .ia-dot[data-s=wait]{background:#ffbe67;animation:iaPulse 1s infinite}
#live .ia-dot[data-s=err]{background:#f87171}
@keyframes iaPulse{50%{opacity:.35}}
#live .ia-stats{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:16px 0}
#live .ia-stats div{background:#0f1f31;border:1px solid #213a52;border-radius:12px;padding:10px 12px;min-width:0}
#live .ia-stats span{display:block;font-size:10px;letter-spacing:.12em;color:#8fa7bc}
#live .ia-stats b{display:block;font-size:15px;color:#e9f3fb;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#live .ia-plot{position:relative;height:min(62vh,560px);min-height:300px;border:1px solid #27435c;background:#0b1726;border-radius:12px;overflow:hidden}
#live .ia-plot canvas{width:100%;height:100%;display:block}
#live .ia-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:14px}
#live .ia-tile{background:#0f1f31;border:1px solid #213a52;border-radius:12px;padding:10px 12px;cursor:pointer;text-align:left;color:inherit;font:inherit;min-width:0}
#live .ia-tile.on{border-color:var(--c);box-shadow:inset 3px 0 0 var(--c)}
#live .ia-tile span{display:block;font-size:11px;color:#8fa7bc;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#live .ia-tile b{display:block;font-size:20px;color:#e9f3fb;font-variant-numeric:tabular-nums}
#live .ia-tile i{font-style:normal;font-size:11px;color:#8fa7bc}
#live .ia-recording{background:#b42335!important;color:#fff!important;border-color:#f87171!important}
#live .ia-help{font-size:12px;color:#8fa7bc;line-height:1.55}
#live .ia-help code{background:#0b1726;border:1px solid #213a52;border-radius:6px;padding:1px 5px;color:#cfe0ee;font-size:11px}
#live .ia-help pre{background:#0b1726;border:1px solid #213a52;border-radius:8px;padding:10px;overflow:auto;color:#cfe0ee;font-size:11px;white-space:pre}
.ia-mode{display:inline-flex;background:#0b1726;border:1px solid #27435c;border-radius:999px;padding:3px;gap:2px}
.ia-mode button{border:0;background:transparent;color:#aabbd0;padding:7px 14px;border-radius:999px;cursor:pointer;font:600 12px 'Segoe UI',system-ui,sans-serif;letter-spacing:.04em;min-height:0!important}
.ia-mode button.on{background:linear-gradient(135deg,#3fd0e0,#3f86f0);color:#04121a}
.ia-mode button[data-m=live].on{background:linear-gradient(135deg,#4ade80,#22c55e)}
.ia-mode button[data-m=live]::before{content:'';display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;vertical-align:1px;opacity:.7}
.nav[data-page=live]{display:none}
body.ia-mode-live .nav[data-page=live]{display:flex}
@media (max-width:1100px){#live .ia-live-grid{grid-template-columns:1fr}#live .ia-stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:1100px){#live .ia-live-grid>div:last-child{order:-1}}
@media (max-width:860px){.topright .ia-mode{display:none!important}#live .ia-stats{grid-template-columns:repeat(2,minmax(0,1fr))}#live .ia-plot{height:52vh;min-height:260px}#live .ia-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}#iaBar .ia-mode button{padding:6px 10px}}
@media (max-width:480px){#iaBar .ia-mode button{padding:6px 8px;font-size:11px}#iaBar .ia-mode button[data-m=live]::before{display:none}#iaBar .ia-open{padding:0;width:42px;font-size:0}#iaBar .ia-open::before{content:'＋';font-size:20px}#iaBar .ia-title span{display:none}}
`;
let mode = 'offline';
function setMode(m, keepData) {
  if (m === mode) { if (m === 'live') window.navigate('live'); return; }
  mode = m; document.body.classList.toggle('ia-mode-live', m === 'live');
  document.querySelectorAll('.ia-mode button').forEach((b) => b.classList.toggle('on', b.dataset.m === m));
  if (m === 'live') { L.offlineFull = state.full; window.navigate('live'); }
  else {
    disconnect(); if (L.rec) toggleRecord();
    if (!keepData && L.offlineFull) { state.full = L.offlineFull; state.a = 0; state.b = state.full.t.length; api.showView(false); }
    if (curPage() === 'live') window.navigate('overview');
  }
  const fb = document.getElementById('fileBadge'); if (fb && m === 'live') fb.textContent = '● LIVE MODE';
}
function buildTiles() {
  if (!ui.tiles) return;
  if (L.nch && !L.visible.size) for (let i = 0; i < Math.min(L.nch, 6); i++) L.visible.add(i);
  ui.tiles.innerHTML = L.names.slice(0, L.nch).map((n, i) => `<button class="ia-tile ${L.visible.has(i) ? 'on' : ''}" data-ci="${i}" style="--c:${COLORS[i % COLORS.length]}" title="Click to show / hide in the plot"><span>${esc(n)}</span><b>—</b><i>${esc(L.units[i] || '')}</i></button>`).join('');
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function setStatus(s, text) { if (!ui.dot) return; ui.dot.dataset.s = s; ui.statusText.textContent = text; ui.connect.textContent = s === 'idle' || (s === 'err' && !L.reconnect) ? 'Connect' : 'Disconnect'; ui.connect.classList.toggle('primary', ui.connect.textContent === 'Connect'); }

export function installLive(a) {
  api = a;
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  // nav entry
  const navs = document.getElementById('navs');
  if (navs) { const b = document.createElement('button'); b.className = 'nav'; b.dataset.page = 'live'; b.innerHTML = '<span>◉</span>Live Monitor'; b.onclick = () => window.navigate('live'); navs.prepend(b); }
  // screen
  const ref = document.querySelector('.screen'); if (!ref) return;
  const sec = document.createElement('section'); sec.className = 'screen'; sec.id = 'live';
  const saved = (() => { try { return JSON.parse(localStorage.getItem('ia.live') || '{}'); } catch { return {}; } })();
  sec.innerHTML = `
  <div class="ia-live-grid">
   <div class="card ia-conn" style="padding:18px">
    <div class="sectionhead"><div><div class="micro">LIVE ACQUISITION</div><h3 style="margin:4px 0 0">Real-time stream</h3></div>
     <div class="ia-row"><button class="btn" data-pause>❚❚ Pause</button><button class="btn" data-rec>● Record</button></div></div>
    <div class="ia-stats" data-stats></div>
    <div class="ia-plot"><canvas></canvas></div>
    <div class="ia-row" style="margin-top:12px;justify-content:space-between">
     <div class="ia-row"><span class="sub">Window</span>${[2, 5, 10, 30, 60].map((s) => `<button class="btn" data-win="${s}">${s} s</button>`).join('')}
      <label class="sub" style="display:flex;gap:6px;align-items:center;margin-left:6px"><input type="checkbox" data-overlay> Overlay</label></div>
     <div class="ia-row"><span class="sub" data-recinfo></span><span data-recactions hidden class="ia-row"><button class="btn primary" data-recan>Analyze recording</button><button class="btn" data-recsave>Save CSV</button></span></div>
    </div>
    <div class="ia-tiles" data-tiles></div>
   </div>
   <div style="display:flex;flex-direction:column;gap:16px;min-width:0">
    <div class="card ia-conn" style="padding:18px">
     <div class="micro">CONNECTION</div>
     <label>SOURCE</label>
     <select class="field" data-src><option value="ws">WebSocket (bridge for TCP / UDP / WS)</option><option value="sim">Built-in simulator</option></select>
     <div data-wsopts><label>ADDRESS</label><input class="field" data-url value="${esc(saved.url || 'ws://localhost:8765')}" spellcheck="false"></div>
     <div data-simopts hidden><label>SIMULATED RATE (S/s per channel)</label><select class="field" data-simrate><option>1000</option><option>5000</option><option selected>20000</option><option>50000</option></select></div>
     <label>BUFFER (seconds kept in memory)</label>
     <select class="field" data-buf>${[10, 30, 60, 120, 300].map((s) => `<option ${s === (saved.buf || 30) ? 'selected' : ''}>${s}</option>`).join('')}</select>
     <div class="ia-row" style="margin-top:14px"><button class="btn primary" data-connect>Connect</button></div>
     <div class="ia-status"><span class="ia-dot" data-dot></span><span data-st>Not connected</span></div>
    </div>
    <div class="card ia-conn" style="padding:18px">
     <div class="micro">ANALYSIS</div>
     <p class="ia-help" style="margin:8px 0 10px">Send live data into every analysis page (Trends, Statistics, FFT, Thresholds…).</p>
     <label class="sub" style="display:flex;gap:8px;align-items:center;margin:0 0 10px"><input type="checkbox" data-mirror> Auto-refresh analysis pages with the live window (every 2 s)</label>
     <button class="btn" data-snap style="width:100%">Analyze current buffer →</button>
    </div>
    <div class="card" style="padding:18px">
     <div class="micro">INTEGRATION</div>
     <div class="ia-help">
      <p>Run the bridge (Python 3, no packages needed):<br><code>python ia_bridge.py</code><br>
      It listens on <b>WebSocket :8765</b> (this page), <b>TCP :8766</b> and <b>UDP :8767</b> for your application.</p>
      <p><b>Python</b> (<code>ia_live.py</code>):</p>
      <pre>from ia_live import LiveSender
s = LiveSender("tcp://localhost:8766",
     names=["AI0","AI1"], units=["V","V"], rate=20000)
s.send_block([ai0_array, ai1_array])   # numpy or lists</pre>
      <p><b>LabVIEW</b>: TCP Open Connection (localhost, 8766) → TCP Write one JSON line per block, ending in <code>\\n</code>:</p>
      <pre>{"type":"meta","names":["AI0","AI1"],"rate":20000}
{"dt":5e-5,"ch":[[...AI0...],[...AI1...]]}</pre>
      <p>For high rates use the binary block: <code>"IAL1"</code>, u32 channels, u32 samples, f64 t0, f64 dt, then float32 data channel by channel (little-endian). UDP: one message per datagram.</p>
     </div>
    </div>
   </div>
  </div>`;
  ref.parentElement.appendChild(sec);
  const q = (k) => sec.querySelector(`[data-${k}]`);
  ui = { canvas: sec.querySelector('canvas'), stats: q('stats'), tiles: q('tiles'), dot: q('dot'), statusText: q('st'), connect: q('connect'), src: q('src'), url: q('url'), simRate: q('simrate'), rec: q('rec'), recInfo: q('recinfo'), recActions: q('recactions'), overlay: q('overlay') };
  const persist = () => { try { localStorage.setItem('ia.live', JSON.stringify({ url: ui.url.value, buf: L.bufSec })); } catch {} };
  ui.src.onchange = () => { q('wsopts').hidden = ui.src.value !== 'ws'; q('simopts').hidden = ui.src.value !== 'sim'; };
  ui.connect.onclick = () => { if (ui.connect.textContent === 'Connect') { persist(); connect(); } else disconnect(); };
  ui.url.onkeydown = (e) => { if (e.key === 'Enter') { persist(); connect(); } };
  q('buf').onchange = () => { L.bufSec = Number(q('buf').value); persist(); if (L.nch) allocate(true); };
  q('pause').onclick = () => { L.paused = !L.paused; q('pause').textContent = L.paused ? '▶ Resume' : '❚❚ Pause'; };
  ui.rec.onclick = toggleRecord;
  q('recan').onclick = () => L.lastRec && analyze(L.lastRec);
  q('recsave').onclick = () => L.lastRec && saveCsv(L.lastRec);
  q('snap').onclick = () => { const s = snapshotArrays(); analyze(toFull(s.t, s.ch, `Live buffer ${new Date().toLocaleTimeString()}`)); };
  q('mirror').onchange = (e) => { L.mirror = e.target.checked; };
  sec.querySelectorAll('[data-win]').forEach((b) => (b.onclick = () => { L.winSec = Number(b.dataset.win); sec.querySelectorAll('[data-win]').forEach((x) => x.classList.toggle('primary', x === b)); }));
  sec.querySelector('[data-win="10"]').classList.add('primary');
  ui.tiles.onclick = (e) => { const t = e.target.closest('[data-ci]'); if (!t) return; const i = +t.dataset.ci; L.visible.has(i) ? L.visible.delete(i) : L.visible.add(i); t.classList.toggle('on'); };
  // mode switch (desktop header + mobile app bar)
  const mk = () => { const m = document.createElement('div'); m.className = 'ia-mode'; m.innerHTML = '<button data-m="offline" class="on">OFFLINE</button><button data-m="live">LIVE</button>'; m.onclick = (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); }; return m; };
  document.querySelector('.topright')?.prepend(mk());
  const bar = document.getElementById('iaBar'); if (bar) bar.querySelector('.ia-open')?.before(mk());
  // navigate wrapper: title for the live screen
  const nav = window.navigate;
  window.navigate = function (to) {
    const r = nav.apply(this, arguments);
    if (to === 'live') { const t = document.getElementById('pageTitle'), e = document.getElementById('eyebrow'); if (t) t.textContent = 'Live Monitor'; if (e) e.textContent = 'REAL-TIME DATA ACQUISITION'; }
    return r;
  };
  setStatus('idle', 'Not connected');
  requestAnimationFrame(draw); setInterval(tick, 250); setInterval(mirrorTick, 2000);
  window.AnalyzerLive = { L, connect, disconnect, setMode, ingest, snapshotArrays };
}
function curPage() { try { return page; } catch { return ''; } } // reference keeps the current page in a global `let page`
