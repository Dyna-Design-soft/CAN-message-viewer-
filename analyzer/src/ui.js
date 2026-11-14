// Floating "Data window" bar for large records: full-record summary, time window
// (zoom / pan to full resolution), view density & mode, sample-rate override,
// full-resolution statistics and full-resolution CSV export of the window.
let bar, api;
const css = `
#bdBar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:9000;width:min(1180px,calc(100vw - 24px));background:rgba(9,18,28,.96);border:1px solid #23415a;border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.55);color:#d9e7f2;font:12px/1.4 'Segoe UI',system-ui,sans-serif;backdrop-filter:blur(8px)}
#bdBar[hidden]{display:none}
#bdBar .row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:9px 12px}
#bdBar .ttl{font-size:10px;letter-spacing:.14em;color:#58e0e0;font-weight:700}
#bdBar .sum{color:#8fa7bc;flex:1;min-width:200px}
#bdBar input,#bdBar select{background:#08111a;color:#d9e7f2;border:1px solid #23415a;border-radius:7px;padding:5px 7px;font:inherit;width:96px}
#bdBar select{width:auto}
#bdBar button{background:#11263a;color:#d9e7f2;border:1px solid #23415a;border-radius:7px;padding:5px 10px;font:inherit;cursor:pointer}
#bdBar button:hover{border-color:#58e0e0}
#bdBar button.pri{background:#58e0e0;color:#04121a;border:0;font-weight:700}
#bdBar .track{position:relative;height:16px;margin:0 12px 10px;background:#0b1824;border-radius:8px;cursor:pointer}
#bdBar .win{position:absolute;top:0;bottom:0;background:rgba(88,224,224,.35);border:1px solid #58e0e0;border-radius:8px;cursor:grab}
#bdBar .lbl{color:#8fa7bc}
#bdBar .body[hidden]{display:none}
#bdProg{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99998;background:#58e0e0;color:#04121a;padding:8px 16px;border-radius:999px;font:700 12px 'Segoe UI',sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)}
#bdProg:empty{display:none}
#bdStats{position:fixed;inset:0;z-index:99999;background:rgba(3,8,14,.75);display:flex;align-items:center;justify-content:center}
#bdStats>div{background:#0d1722;border:1px solid #23415a;border-radius:14px;padding:18px;max-width:94vw;max-height:86vh;overflow:auto;color:#d9e7f2;font:12px 'Segoe UI',sans-serif}
#bdStats table{border-collapse:collapse;width:100%}#bdStats td,#bdStats th{padding:5px 10px;border-bottom:1px solid #1b3247;text-align:right;white-space:nowrap}#bdStats td:first-child,#bdStats th:first-child{text-align:left}
#bdStats th{color:#58e0e0;font-size:10px;letter-spacing:.1em}`;
export function setProgress(msg) {
  let p = document.getElementById('bdProg');
  if (!p) { p = document.createElement('div'); p.id = 'bdProg'; document.body.appendChild(p); }
  p.textContent = msg;
}
export function installBar(a) {
  api = a;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  bar = document.createElement('div'); bar.id = 'bdBar'; bar.hidden = true;
  bar.innerHTML = `<div class="row"><span class="ttl">FULL RECORD</span><span class="sum" data-sum></span>
   <button data-tog title="Show / hide window controls">▾</button></div>
   <div class="body" data-body>
   <div class="track" data-track><div class="win" data-win></div></div>
   <div class="row" style="padding-top:0">
    <span class="lbl">Window</span><input data-t1 type="number" step="any" title="Start (s)"><span class="lbl">→</span><input data-t2 type="number" step="any" title="End (s)"><span class="lbl">s</span>
    <button class="pri" data-apply>Apply</button><button data-full>Full</button><button data-prev title="Previous window">◀</button><button data-next title="Next window">▶</button><button data-in title="Zoom in ×2">＋</button><button data-out title="Zoom out ×2">－</button>
    <span class="lbl">Points</span><select data-cap><option>5000</option><option selected>10000</option><option>20000</option></select>
    <select data-mode><option value="envelope">Min/Max envelope</option><option value="average">Block average</option></select>
    <span class="lbl">Rate</span><input data-fs type="number" step="any" placeholder="Hz" title="Override sample rate (Hz) — rebuilds the time axis"><button data-setfs>Set</button>
    <button data-stats>Full-res stats</button><button data-exp>Export window CSV</button>
   </div></div>`;
  document.body.appendChild(bar);
  const q = (k) => bar.querySelector(`[data-${k}]`);
  const S = api.state, T = () => S.full.t;
  const cur = () => [T()[S.a], T()[S.b - 1]];
  q('tog').onclick = () => { q('body').hidden = !q('body').hidden; q('tog').textContent = q('body').hidden ? '▴' : '▾'; };
  q('apply').onclick = () => api.setWindow(Number(q('t1').value), Number(q('t2').value));
  q('full').onclick = () => { S.a = 0; S.b = T().length; api.showView(false); };
  const shift = (dir) => { const [x, y] = cur(), w = y - x, t = T(), lo = t[0], hi = t[t.length - 1]; let s = Math.min(Math.max(lo, x + dir * w), hi - w); api.setWindow(s, s + w); };
  q('prev').onclick = () => shift(-1); q('next').onclick = () => shift(1);
  const zoom = (f) => { const [x, y] = cur(), c = (x + y) / 2, w = ((y - x) * f) / 2; api.setWindow(c - w, c + w); };
  q('in').onclick = () => zoom(0.5); q('out').onclick = () => zoom(2);
  q('cap').onchange = () => { S.cap = Number(q('cap').value); api.showView(false); };
  q('mode').onchange = () => { S.mode = q('mode').value; api.showView(false); };
  q('setfs').onclick = () => { const f = Number(q('fs').value); if (f > 0) api.setRate(f); };
  q('exp').onclick = () => {
    const blob = api.exportWindowCsv(S.full, S.a, S.b), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = S.full.name.replace(/[^\w.-]+/g, '_').replace(/\.\w+$/, '') + `_window_${S.a}-${S.b}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  q('stats').onclick = () => {
    const st = api.fullStats(S.full, S.a, S.b), f = S.full, fx = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v) ? v.toExponential(4) : v.toFixed(4)) : '—');
    const m = document.createElement('div'); m.id = 'bdStats';
    m.innerHTML = `<div><div style="display:flex;justify-content:space-between;gap:20px;align-items:center"><div><div class="ttl" style="color:#58e0e0;font-size:10px;letter-spacing:.14em">FULL-RESOLUTION STATISTICS</div><b>${(S.b - S.a).toLocaleString()} samples · ${api.fmtTime(cur()[1] - cur()[0])}</b></div><button style="background:#11263a;color:#d9e7f2;border:1px solid #23415a;border-radius:7px;padding:5px 10px;cursor:pointer">Close</button></div>
     <table><tr><th>CHANNEL</th><th>UNIT</th><th>MIN</th><th>MAX</th><th>MEAN</th><th>RMS</th><th>STD DEV</th><th>P-P</th><th>VALID</th></tr>
     ${st.map((s, i) => `<tr><td>${esc(f.names[i])}</td><td>${esc(f.units[i] || '')}</td><td>${fx(s.min)}</td><td>${fx(s.max)}</td><td>${fx(s.mean)}</td><td>${fx(s.rms)}</td><td>${fx(s.sd)}</td><td>${fx(s.max - s.min)}</td><td>${s.n.toLocaleString()}</td></tr>`).join('')}</table></div>`;
    m.querySelector('button').onclick = () => m.remove(); m.onclick = (e) => { if (e.target === m) m.remove(); };
    document.body.appendChild(m);
  };
  // drag / click on the overview track
  const track = q('track'), win = q('win');
  let drag = null;
  const tAt = (x) => { const r = track.getBoundingClientRect(), t = T(); return t[0] + Math.min(1, Math.max(0, (x - r.left) / r.width)) * (t[t.length - 1] - t[0]); };
  win.onpointerdown = (e) => { e.stopPropagation(); win.setPointerCapture(e.pointerId); drag = { x: e.clientX, w: cur() }; };
  win.onpointermove = (e) => { if (!drag) return; const r = track.getBoundingClientRect(), t = T(), span = t[t.length - 1] - t[0], d = ((e.clientX - drag.x) / r.width) * span; place(drag.w[0] + d, drag.w[1] + d); };
  win.onpointerup = () => { if (!drag) return; drag = null; api.setWindow(Number(q('t1').value), Number(q('t2').value)); };
  track.onpointerdown = (e) => { if (e.target !== track) return; const [x, y] = cur(), w = y - x, c = tAt(e.clientX); api.setWindow(c - w / 2, c + w / 2); };
  function place(x, y) {
    const t = T(), lo = t[0], span = t[t.length - 1] - lo || 1;
    win.style.left = ((x - lo) / span) * 100 + '%'; win.style.width = Math.max(0.6, ((y - x) / span) * 100) + '%';
    q('t1').value = +x.toFixed(6); q('t2').value = +y.toFixed(6);
  }
  bar._place = place;
}
export function refreshBar(a) {
  if (!bar) return;
  const S = a.state, f = S.full;
  if (!f) { bar.hidden = true; document.body.style.paddingBottom = ''; return; }
  bar.hidden = false; document.body.style.paddingBottom = '150px';
  const n = f.t.length, inWin = S.b - S.a;
  const mb = (f.bytes / 1048576).toFixed(1);
  bar.querySelector('[data-sum]').innerHTML = `<b style="color:#d9e7f2">${esc(f.name)}</b> · ${f.names.length} ch × ${n.toLocaleString()} samples · ${a.rateInfo(f.t)} · ${mb} MB loaded in ${(f.loadMs / 1000).toFixed(2)} s · view ${inWin <= S.cap ? 'full resolution' : `${S.mode === 'envelope' ? 'min/max envelope' : 'block average'} ×${(inWin / S.cap).toFixed(1)}`}`;
  const t = f.t; bar._place(t[S.a], t[S.b - 1]);
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
