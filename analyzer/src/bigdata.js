// Large-dataset engine: keeps the full-resolution record in typed arrays and hands the
// analyzer UI a min/max-envelope view of a chosen time window (≤ POINT_CAP points per
// channel). The envelope view has uniform timestamps, so spectral tools keep working,
// and peaks/spikes are never lost by decimation.
export const state = { full: null, a: 0, b: 0, cap: 10000, mode: 'envelope' };

export function compactFull(full) {
  // store channel data as Float32 when the record is big (halves memory)
  const total = full.data.reduce((s, a) => s + a.length, 0);
  if (total > 2e7) full.data = full.data.map((a) => (a instanceof Float32Array ? a : Float32Array.from(a)));
  if (!(full.t instanceof Float64Array)) full.t = Float64Array.from(full.t);
  return full;
}

function lowerBound(t, x) { let lo = 0, hi = t.length; while (lo < hi) { const m = (lo + hi) >> 1; if (t[m] < x) lo = m + 1; else hi = m; } return lo; }

export function makeView(full, a = 0, b = full.t.length, cap = state.cap, mode = state.mode) {
  const n = b - a;
  const base = { name: full.name, kind: full.kind, names: full.names.slice(), units: full.units.slice() };
  if (n <= cap) {
    return { ...base, t: Array.from(full.t.subarray(a, b)), data: full.data.map((d) => Array.from(d.subarray(a, b))),
      sampleInfo: full.sampleInfo + (n < full.t.length ? ` · window ${n.toLocaleString()} of ${full.t.length.toLocaleString()} samples (full resolution)` : '') };
  }
  const t = full.t;
  if (mode === 'envelope') {
    const buckets = Math.floor(cap / 2), bw = n / buckets;
    const t0 = t[a], span = t[b - 1] - t0, dtb = span / buckets;
    const tv = new Array(buckets * 2);
    for (let k = 0; k < buckets; k++) { tv[2 * k] = t0 + k * dtb; tv[2 * k + 1] = t0 + (k + 0.5) * dtb; }
    const data = full.data.map((d) => {
      const out = new Array(buckets * 2);
      for (let k = 0; k < buckets; k++) {
        const s = a + Math.floor(k * bw), e = Math.min(b, a + Math.floor((k + 1) * bw));
        let mn = Infinity, mx = -Infinity, imn = s, imx = s;
        for (let i = s; i < e; i++) { const v = d[i]; if (v < mn) { mn = v; imn = i; } if (v > mx) { mx = v; imx = i; } }
        if (mn === Infinity) { out[2 * k] = out[2 * k + 1] = NaN; continue; }
        if (imn <= imx) { out[2 * k] = mn; out[2 * k + 1] = mx; } else { out[2 * k] = mx; out[2 * k + 1] = mn; }
      }
      return out;
    });
    return { ...base, t: tv, data, sampleInfo: `${full.sampleInfo} · min/max envelope ${tv.length.toLocaleString()} pts of ${n.toLocaleString()} samples (×${(n / tv.length).toFixed(1)} reduction)` };
  }
  // block average (anti-aliased resample)
  const m = cap, bw = n / m, tv = new Array(m);
  for (let k = 0; k < m; k++) tv[k] = t[a + Math.floor(k * bw)];
  const data = full.data.map((d) => {
    const out = new Array(m);
    for (let k = 0; k < m; k++) {
      const s = a + Math.floor(k * bw), e = Math.min(b, a + Math.floor((k + 1) * bw)); let sum = 0, c = 0;
      for (let i = s; i < e; i++) { const v = d[i]; if (v === v) { sum += v; c++; } }
      out[k] = c ? sum / c : NaN;
    }
    return out;
  });
  return { ...base, t: tv, data, sampleInfo: `${full.sampleInfo} · block-average ${m.toLocaleString()} pts of ${n.toLocaleString()} samples` };
}

export function fullStats(full, a, b) {
  return full.data.map((d) => {
    let mn = Infinity, mx = -Infinity, s = 0, s2 = 0, c = 0;
    for (let i = a; i < b; i++) { const v = d[i]; if (v === v) { if (v < mn) mn = v; if (v > mx) mx = v; s += v; s2 += v * v; c++; } }
    const mean = s / c; return { min: mn, max: mx, mean, rms: Math.sqrt(s2 / c), sd: Math.sqrt(Math.max(0, s2 / c - mean * mean)), n: c };
  });
}

export function rateInfo(t) {
  const n = t.length; if (n < 2) return '';
  const dt = (t[n - 1] - t[0]) / (n - 1);
  return dt > 0 ? `${fmtRate(1 / dt)} · ${fmtTime(t[n - 1] - t[0])}` : '';
}
export const fmtRate = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 1e4 ? 1 : 2) + ' kS/s' : f.toFixed(f < 10 ? 2 : 0) + ' S/s');
export const fmtTime = (s) => (s >= 3600 ? (s / 3600).toFixed(2) + ' h' : s >= 60 ? (s / 60).toFixed(2) + ' min' : s.toFixed(3) + ' s');

export function windowByTime(full, t1, t2) {
  const a = Math.max(0, lowerBound(full.t, t1)), b = Math.min(full.t.length, Math.max(a + 2, lowerBound(full.t, t2) + 1));
  return [a, b];
}

export function exportWindowCsv(full, a, b) {
  const parts = ['Time,' + full.names.map((n, i) => `"${(full.units[i] ? `${n} [${full.units[i]}]` : n).replace(/"/g, '""')}"`).join(',') + '\n'];
  let chunk = '';
  for (let i = a; i < b; i++) {
    chunk += full.t[i] + ','; for (let j = 0; j < full.data.length; j++) { const v = full.data[j][i]; chunk += (v === v ? v : '') + (j < full.data.length - 1 ? ',' : '\n'); }
    if (chunk.length > 1e6) { parts.push(chunk); chunk = ''; }
  }
  parts.push(chunk);
  return new Blob(parts, { type: 'text/csv' });
}
