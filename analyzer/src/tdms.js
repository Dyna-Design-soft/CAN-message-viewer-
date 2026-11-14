// Fast NI TDMS reader for analysis data (DAQ logs).
// Supports: incremental metadata, contiguous and interleaved raw data, big-endian,
// all numeric types, timestamps, DAQmx raw data (format-changing scalers) with
// NI_Scale linear / polynomial scaling, waveform timing properties.
const T = { 1: [1, 'Int8'], 2: [2, 'Int16'], 3: [4, 'Int32'], 4: [8, 'BigInt64'], 5: [1, 'Uint8'], 6: [2, 'Uint16'], 7: [4, 'Uint32'], 8: [8, 'BigUint64'], 9: [4, 'Float32'], 10: [8, 'Float64'], 0x19: [4, 'Float32'], 0x1a: [8, 'Float64'], 0x21: [1, 'Uint8'], 0x44: [16, 'ts'] };
const NI_EPOCH = 2082844800;
const DAQMX_A = 0x69120000, DAQMX_B = 0x69130000;

export async function readTdms(buf, progress) {
  const bytes = new Uint8Array(buf), dv = new DataView(buf);
  const objs = new Map(); // path -> {path, group, name, props, type, idx, chunks:[], n}
  let order = []; let pos = 0, seg = 0, lastYield = 0;
  while (pos + 28 <= bytes.length) {
    if (dv.getUint32(pos, true) !== 0x6d534454) break; // 'TDSm'
    const toc = dv.getUint32(pos + 4, true), le = !(toc & 64);
    const nextOff = Number(dv.getBigUint64(pos + 12, le)), rawOff = Number(dv.getBigUint64(pos + 20, le));
    const lead = pos + 28, dataStart = lead + rawOff;
    let segEnd = nextOff === -1 || nextOff >= 2 ** 63 || lead + nextOff > bytes.length ? bytes.length : lead + nextOff;
    if (toc & 2) {
      let p = lead;
      const u32 = () => { const v = dv.getUint32(p, le); p += 4; return v; };
      const u64 = () => { const v = Number(dv.getBigUint64(p, le)); p += 8; return v; };
      const str = () => { const n = u32(); const s = new TextDecoder().decode(bytes.subarray(p, p + n)); p += n; return s; };
      if (toc & 4) order = [];
      const nObj = u32();
      for (let o = 0; o < nObj; o++) {
        const path = str(); let ob = objs.get(path);
        if (!ob) { const parts = [...path.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'")); ob = { path, group: parts[0] || '', name: parts[1] || '', props: {}, idx: null, chunks: [], n: 0 }; objs.set(path, ob); }
        const ri = u32();
        if (ri === 0xffffffff) { const k = order.indexOf(ob); if (k >= 0) order.splice(k, 1); }
        else {
          if (ri === DAQMX_A || ri === DAQMX_B) {
            u32(); u32(); const n = u64(); const ns = u32(); const scalers = [];
            for (let s = 0; s < ns; s++) scalers.push({ type: u32(), buf: u32(), off: u32(), fmt: u32(), scale: u32() });
            const nw = u32(); const widths = []; for (let w = 0; w < nw; w++) widths.push(u32());
            ob.idx = { daqmx: true, n, scalers, widths };
          } else if (ri !== 0) {
            const type = u32(); u32(); const n = u64(); let total = 0; if (type === 0x20) total = u64();
            ob.idx = { type, n, total };
          }
          if (ob.idx && !order.includes(ob)) order.push(ob);
        }
        const np = u32();
        for (let k = 0; k < np; k++) { const pn = str(); const pt = u32(); ob.props[pn] = readProp(pt); }
      }
      function readProp(t) {
        if (t === 0x20) return str();
        const [sz, k] = T[t] || [0];
        if (!sz) throw Error('TDMS: unsupported property type ' + t);
        let v;
        if (k === 'ts') { const frac = dv.getBigUint64(p, le), sec = dv.getBigInt64(p + 8, le); v = Number(sec) - NI_EPOCH + Number(frac) / 2 ** 64; }
        else if (k.startsWith('Big')) v = Number(dv['get' + k](p, le)); else v = dv['get' + k](p, le);
        p += sz; return v;
      }
    }
    if ((toc & 8) && segEnd > dataStart && order.length) readRaw(dataStart, segEnd, order, !!(toc & 32), le);
    seg++;
    if (progress && pos - lastYield > 8e6) { lastYield = pos; await progress(pos / bytes.length); }
    if (segEnd <= pos) break; pos = segEnd;
  }

  function readRaw(start, end, list, interleaved, le) {
    const active = list.filter((o) => o.idx && o.idx.n > 0);
    if (!active.length) return;
    if (active[0].idx.daqmx) {
      // DAQmx: all channels share one raw buffer of width = widths[0]; each scaler reads at offset
      const width = active[0].idx.widths[0];
      const n = active[0].idx.n;
      const chunkSize = width * n, chunks = Math.max(1, Math.floor((end - start) / chunkSize));
      for (let c = 0; c < chunks; c++) {
        const base = start + c * chunkSize;
        for (const o of active) {
          const sc = o.idx.scalers[0], [sz, k] = T[sc.type] || T[ sc.type === 0 ? 2 : sc.type ] || [2, 'Int16'];
          const out = new Float64Array(n), get = dv['get' + (k.startsWith('Big') ? 'Float64' : k)].bind(dv);
          for (let i = 0, q = base + sc.off; i < n; i++, q += width) out[i] = get(q, le);
          o.chunks.push(out); o.n += n; o.daqmx = true;
        }
      }
      return;
    }
    const sizes = active.map((o) => (o.idx.type === 0x20 ? o.idx.total : (T[o.idx.type] || [0])[0] * o.idx.n));
    if (active.some((o) => o.idx.type === 0x20 || !T[o.idx.type])) {
      // strings or unsupported types: skip contiguous blocks but keep alignment
      if (interleaved) return;
    }
    const chunkSize = sizes.reduce((a, b) => a + b, 0);
    if (!chunkSize) return;
    const chunks = Math.max(1, Math.floor((end - start) / chunkSize));
    for (let c = 0; c < chunks; c++) {
      let base = start + c * chunkSize;
      if (interleaved) {
        const stride = active.reduce((a, o) => a + T[o.idx.type][0], 0); let off = 0;
        for (const o of active) { o.chunks.push(readVals(o.idx.type, base + off, o.idx.n, stride, le)); o.n += o.idx.n; off += T[o.idx.type][0]; }
      } else {
        active.forEach((o, j) => {
          if (o.idx.type !== 0x20 && T[o.idx.type]) { o.chunks.push(readVals(o.idx.type, base, o.idx.n, T[o.idx.type][0], le)); o.n += o.idx.n; }
          base += sizes[j];
        });
      }
    }
  }
  function readVals(type, at, n, stride, le) {
    const [sz, k] = T[type]; const out = new Float64Array(n);
    if (k === 'Float64' && stride === 8 && le && at % 8 === 0) { out.set(new Float64Array(buf, at, n)); return out; }
    if (k === 'Float32' && stride === 4 && le && at % 4 === 0) { out.set(new Float32Array(buf, at, n)); return out; }
    if (k === 'Int16' && stride === 2 && le && at % 2 === 0) { out.set(new Int16Array(buf, at, n)); return out; }
    if (k === 'ts') { for (let i = 0, q = at; i < n; i++, q += stride) out[i] = Number(dv.getBigInt64(q + 8, le)) - NI_EPOCH + Number(dv.getBigUint64(q, le)) / 2 ** 64; return out; }
    if (k.startsWith('Big')) { for (let i = 0, q = at; i < n; i++, q += stride) out[i] = Number(dv['get' + k](q, le)); return out; }
    const get = dv['get' + k].bind(dv);
    for (let i = 0, q = at; i < n; i++, q += stride) out[i] = get(q, le);
    return out;
  }

  const channels = [];
  for (const o of objs.values()) {
    if (!o.name || !o.n) continue;
    let data;
    if (o.chunks.length === 1) data = o.chunks[0];
    else { data = new Float64Array(o.n); let q = 0; for (const c of o.chunks) { data.set(c, q); q += c.length; } }
    o.chunks = null;
    if (o.daqmx) applyScale(data, o.props);
    channels.push({ group: o.group, name: o.name, props: o.props, isTime: o.idx && o.idx.type === 0x44, data });
  }
  const groupProps = {}; for (const o of objs.values()) if (o.group && !o.name) groupProps[o.group] = o.props;
  return { channels, groupProps };
}

function applyScale(data, props) {
  const n = Number(props.NI_Number_Of_Scales || 0);
  if (!n) return;
  const fns = [];
  const resolve = (i, depth = 0) => {
    if (i < 0 || depth > 10) return;
    const pre = `NI_Scale[${i}]_`, type = String(props[pre + 'Scale_Type'] || '');
    let src;
    if (/linear/i.test(type)) {
      const m = Number(props[pre + 'Linear_Slope'] ?? 1), b = Number(props[pre + 'Linear_Y_Intercept'] ?? 0);
      src = props[pre + 'Linear_Input_Source']; fns.unshift((x) => x * m + b);
    } else if (/polynomial/i.test(type)) {
      const k = Number(props[pre + 'Polynomial_Coefficients_Size'] || 0), c = [];
      for (let j = 0; j < k; j++) c.push(Number(props[`${pre}Polynomial_Coefficients[${j}]`] || 0));
      src = props[pre + 'Polynomial_Input_Source'];
      fns.unshift((x) => { let y = 0; for (let j = c.length - 1; j >= 0; j--) y = y * x + c[j]; return y; });
    } else return;
    if (src != null && Number(src) !== i && Number(src) < 0xffffffff) resolve(Number(src), depth + 1);
  };
  resolve(n - 1);
  if (!fns.length) return;
  for (let i = 0; i < data.length; i++) { let v = data[i]; for (const f of fns) v = f(v); data[i] = v; }
}
