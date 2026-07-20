// Manages a stack of graphs (trend + XY) that share a synchronized time axis
// and a shared cursor model. Trend graphs auto-scale signals grouped by unit
// onto multiple Y axes; the whole stack zooms/pans together on the X axis.

/* global uPlot */
import { CursorModel, cursorPlugin } from './cursors.js';
import { lowerBound } from '../util/time.js';

const SERIES_COLORS = [
  '#4da3ff', '#ff8f6b', '#7be0a8', '#e0c93c', '#c58bff',
  '#6be0ff', '#ff7ba8', '#9bd85a', '#ffa94d', '#88aaff',
];

const stepped = uPlot.paths.stepped ? uPlot.paths.stepped({ align: 1 }) : undefined;

/** Sample-and-hold value of a series at time t (value holds until next frame). */
export function valueAt(series, t) {
  if (!series || series.t.length === 0) return null;
  const i = lowerBound(series.t, series.t.length, t);
  return i < 0 ? null : series.v[i];
}

export class GraphManager {
  constructor(app, container, storeTag) {
    this.app = app;
    this.container = container;
    this.storeTag = storeTag;
    this.graphs = []; // { type, el, uplot, signals:Set, xSel?, ySel? }
    this.cursors = new CursorModel();
    this.syncKey = uPlot.sync('graphstack-' + storeTag);
    this.#syncingScale = false;
    this.cursors.onChange(() => this.#renderReadout());
    this.readoutEl = document.getElementById(
      storeTag === 'live' ? null : 'cursor-readout',
    );
  }

  #syncingScale;

  get selection() {
    return [...this.app.selection];
  }

  #series(qname) {
    return this.app.seriesCache.get(qname, this.storeTag);
  }

  addTrend() {
    this.#placeholderOff();
    const signals = new Set(this.selection);
    const g = { type: 'trend', signals };
    g.el = this.#makeCard('Trend', g);
    this.container.appendChild(g.el);
    this.graphs.push(g);
    this.#buildTrend(g);
    return g;
  }

  addXY() {
    this.#placeholderOff();
    const sel = this.selection;
    const g = { type: 'xy', xSel: sel[0] ?? null, ySel: sel[1] ?? sel[0] ?? null };
    g.el = this.#makeCard('XY', g);
    this.container.appendChild(g.el);
    this.graphs.push(g);
    this.#buildXY(g);
    return g;
  }

  removeGraph(g) {
    g.uplot?.destroy();
    g.el.remove();
    this.graphs = this.graphs.filter((x) => x !== g);
    if (this.graphs.length === 0) this.#placeholderOn();
    this.#renderReadout();
  }

  /** Selection changed: rebuild trend graphs, refresh XY dropdowns. */
  onSelectionChanged() {
    for (const g of this.graphs) {
      if (g.type === 'trend') {
        // keep only still-selected signals, add newly selected ones
        const active = new Set(this.selection);
        g.signals = new Set([...g.signals].filter((s) => active.has(s)));
        for (const s of active) g.signals.add(s);
        this.#refreshCardControls(g);
        this.#buildTrend(g);
      } else {
        this.#refreshCardControls(g);
        this.#buildXY(g);
      }
    }
    this.#renderReadout();
  }

  /** Data changed (new log) — rebuild everything. */
  rebuild() {
    for (const g of this.graphs) {
      if (g.type === 'trend') this.#buildTrend(g);
      else this.#buildXY(g);
    }
    this.#renderReadout();
  }

  setPlaybackTime(t) {
    this.cursors.setPlayback(t);
  }

  /** Resize all plots to their container width (call when the panel becomes visible). */
  resizeAll() {
    for (const g of this.graphs) {
      if (!g.uplot) continue;
      const w = g.body.clientWidth;
      if (w > 0) g.uplot.setSize({ width: w, height: g.uplot.height });
    }
  }

  setXRange(min, max) {
    for (const g of this.graphs) g.uplot?.setScale('x', { min, max });
  }

  // ---- internal ----

  #placeholderOff() {
    const ph = this.container.querySelector('.placeholder');
    if (ph) ph.remove();
  }

  #placeholderOn() {
    if (!this.container.querySelector('.placeholder')) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = 'Add a graph, then tick signals on the left.';
      this.container.appendChild(p);
    }
  }

  #makeCard(title, g) {
    const card = document.createElement('div');
    card.className = 'graph-card';
    const head = document.createElement('div');
    head.className = 'graph-card-head';
    const label = document.createElement('span');
    label.textContent = title + ' graph';
    head.appendChild(label);
    g.controls = document.createElement('span');
    g.controls.style.flex = '1';
    g.controls.style.display = 'flex';
    g.controls.style.gap = '6px';
    g.controls.style.alignItems = 'center';
    head.appendChild(g.controls);
    const rm = document.createElement('button');
    rm.className = 'btn icon-btn';
    rm.textContent = '✕';
    rm.title = 'Remove graph';
    rm.addEventListener('click', () => this.removeGraph(g));
    head.appendChild(rm);
    card.appendChild(head);
    g.body = document.createElement('div');
    g.body.className = 'graph-card-body';
    card.appendChild(g.body);
    this.#refreshCardControls(g);
    return card;
  }

  #refreshCardControls(g) {
    g.controls.textContent = '';
    if (g.type === 'trend') {
      // per-graph signal subset dropdown
      const det = document.createElement('details');
      det.className = 'graph-sig-pick';
      det.style.position = 'relative';
      const sum = document.createElement('summary');
      sum.className = 'btn';
      sum.style.cursor = 'pointer';
      sum.textContent = `Signals (${g.signals.size})`;
      det.appendChild(sum);
      const list = document.createElement('div');
      list.style.cssText =
        'position:absolute;z-index:5;top:100%;left:0;background:var(--bg-raised);' +
        'border:1px solid var(--border);border-radius:4px;padding:6px;max-height:220px;' +
        'overflow:auto;min-width:200px;';
      for (const q of this.selection) {
        const row = document.createElement('label');
        row.style.cssText = 'display:flex;gap:6px;padding:2px 4px;white-space:nowrap;';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = g.signals.has(q);
        cb.addEventListener('change', () => {
          if (cb.checked) g.signals.add(q);
          else g.signals.delete(q);
          sum.textContent = `Signals (${g.signals.size})`;
          this.#buildTrend(g);
        });
        row.append(cb, document.createTextNode(shortName(q)));
        list.appendChild(row);
      }
      if (this.selection.length === 0) {
        const em = document.createElement('div');
        em.className = 'muted';
        em.textContent = 'No signals selected';
        list.appendChild(em);
      }
      det.appendChild(list);
      g.controls.appendChild(det);
    } else {
      const mkSel = (which, current) => {
        const s = document.createElement('select');
        for (const q of this.selection) {
          const o = document.createElement('option');
          o.value = q;
          o.textContent = shortName(q);
          if (q === current) o.selected = true;
          s.appendChild(o);
        }
        s.addEventListener('change', () => {
          g[which] = s.value;
          this.#buildXY(g);
        });
        return s;
      };
      const x = document.createElement('span');
      x.className = 'muted';
      x.textContent = 'X:';
      const y = document.createElement('span');
      y.className = 'muted';
      y.textContent = 'Y:';
      g.controls.append(x, mkSel('xSel', g.xSel), y, mkSel('ySel', g.ySel));
    }
  }

  #commonOpts(g) {
    return {
      width: g.body.clientWidth || 600,
      height: 220,
      cursor: { sync: { key: this.syncKey.key, setSeries: false } },
      plugins: [cursorPlugin(this.cursors, () => this.#onCursorMoved())],
      hooks: {
        setScale: [
          (u, key) => {
            if (key !== 'x' || this.#syncingScale) return;
            this.#syncingScale = true;
            const { min, max } = u.scales.x;
            for (const other of this.graphs) {
              if (other.uplot && other.uplot !== u) other.uplot.setScale('x', { min, max });
            }
            this.#syncingScale = false;
          },
        ],
      },
    };
  }

  #buildTrend(g) {
    g.uplot?.destroy();
    g.body.textContent = '';
    const sigs = [...g.signals].map((q) => ({ q, series: this.#series(q) })).filter((s) => s.series);
    if (sigs.length === 0) {
      empty(g.body, 'Tick signals for this graph.');
      g.uplot = null;
      return;
    }
    const { xs, cols } = buildAligned(sigs.map((s) => s.series));

    // group by unit -> scale
    const unitScales = new Map();
    const series = [{}]; // x
    const axes = [{ stroke: '#8b949e', grid: { stroke: '#2b3138' }, ticks: { stroke: '#2b3138' } }];
    let axisSide = 0;
    sigs.forEach((s, i) => {
      const unit = s.series.signal.unit || '—';
      let scaleKey = unitScales.get(unit);
      if (!scaleKey) {
        scaleKey = 'y' + unitScales.size;
        unitScales.set(unit, scaleKey);
        axes.push({
          scale: scaleKey,
          stroke: '#8b949e',
          grid: { show: unitScales.size === 1, stroke: '#2b3138' },
          side: axisSide % 2 === 0 ? 3 : 1, // left / right
          label: unit,
          labelSize: 12,
          size: 44,
        });
        axisSide++;
      }
      series.push({
        label: shortName(s.q),
        stroke: SERIES_COLORS[i % SERIES_COLORS.length],
        width: 1.3,
        scale: scaleKey,
        spanGaps: false,
        paths: stepped,
        points: { show: false },
        value: (u, v) => (v == null ? '—' : fmtVal(v)),
      });
    });

    const opts = { ...this.#commonOpts(g), series, axes, scales: { x: { time: false } } };
    g.uplot = new uPlot(opts, [xs, ...cols], g.body);
    this.syncKey.sub(g.uplot);
  }

  #buildXY(g) {
    g.uplot?.destroy();
    g.body.textContent = '';
    const xs = this.#series(g.xSel);
    const ys = this.#series(g.ySel);
    if (!xs || !ys) {
      empty(g.body, 'Select X and Y signals.');
      g.uplot = null;
      return;
    }
    // Resample Y onto X's timestamps (sample-and-hold), plot Y vs X value.
    const n = xs.t.length;
    const xv = new Float64Array(n);
    const yv = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const yatt = valueAt(ys, xs.t[i]);
      if (yatt == null) continue;
      xv[m] = xs.v[i];
      yv[m] = yatt;
      m++;
    }
    const opts = {
      width: g.body.clientWidth || 600,
      height: 220,
      mode: 2,
      scales: { x: { time: false }, y: {} },
      axes: [
        { stroke: '#8b949e', grid: { stroke: '#2b3138' }, label: shortName(g.xSel) },
        { stroke: '#8b949e', grid: { stroke: '#2b3138' }, label: shortName(g.ySel) },
      ],
      series: [
        {},
        {
          stroke: SERIES_COLORS[0],
          fill: 'rgba(77,163,255,0.12)',
          paths: uPlot.paths.linear ? uPlot.paths.linear() : undefined,
          points: { show: n < 2000, size: 3, stroke: SERIES_COLORS[0] },
        },
      ],
    };
    // mode 2 data: [null, [ [xvals], [yvals] ] ]
    g.uplot = new uPlot(opts, [null, [xv.subarray(0, m), yv.subarray(0, m)]], g.body);
  }

  #onCursorMoved() {
    for (const g of this.graphs) g.uplot?.redraw(false, false);
    this.#renderReadout();
  }

  #renderReadout() {
    if (!this.readoutEl) return;
    const times = this.cursors.times;
    const sel = this.selection;
    if (times.length === 0 || sel.length === 0) {
      this.readoutEl.hidden = true;
      return;
    }
    this.readoutEl.hidden = false;
    const rows = [];
    const header = ['Signal', ...times.map((t, i) => `C${i + 1} @ ${t.toFixed(4)}s`)];
    if (times.length >= 2) header.push('Δ (C2−C1)');
    for (const q of sel) {
      const series = this.#series(q);
      const cells = [shortName(q)];
      const vals = times.map((t) => valueAt(series, t));
      cells.push(...vals.map((v) => (v == null ? '—' : fmtVal(v))));
      if (times.length >= 2) {
        const d = vals[1] != null && vals[0] != null ? vals[1] - vals[0] : null;
        cells.push(d == null ? '—' : fmtVal(d));
      }
      rows.push(cells);
    }
    // build table
    const t = document.createElement('table');
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    header.forEach((h, i) => {
      const th = document.createElement('th');
      th.textContent = h;
      if (i >= 1 && i <= times.length) th.className = 'cursor-c' + i;
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    t.appendChild(thead);
    const tb = document.createElement('tbody');
    for (const r of rows) {
      const tr = document.createElement('tr');
      r.forEach((c) => {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    this.readoutEl.textContent = '';
    this.readoutEl.appendChild(t);
  }
}

/**
 * Merge several series onto a shared, sorted, de-duplicated time axis with
 * sample-and-hold. Returns { xs: Float64Array, cols: Float64Array[] } where
 * each col aligns to xs (NaN before a signal's first sample).
 */
export function buildAligned(seriesList) {
  // union of timestamps
  let total = 0;
  for (const s of seriesList) total += s.t.length;
  const all = new Float64Array(total);
  let k = 0;
  for (const s of seriesList) {
    all.set(s.t, k);
    k += s.t.length;
  }
  all.sort();
  // dedupe
  const xs = new Float64Array(total);
  let n = 0;
  for (let i = 0; i < total; i++) {
    if (n === 0 || all[i] !== xs[n - 1]) xs[n++] = all[i];
  }
  const X = xs.subarray(0, n);
  const cols = seriesList.map((s) => {
    const col = new Float64Array(n).fill(NaN);
    let p = -1;
    for (let i = 0; i < n; i++) {
      while (p + 1 < s.t.length && s.t[p + 1] <= X[i]) p++;
      if (p >= 0) col[i] = s.v[p];
    }
    return col;
  });
  return { xs: X, cols };
}

function shortName(qname) {
  const parts = qname.split('/');
  return parts.slice(1).join('.');
}

function fmtVal(v) {
  if (!isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  return (+v.toPrecision(6)).toString();
}

function empty(el, msg) {
  const p = document.createElement('p');
  p.className = 'placeholder';
  p.textContent = msg;
  el.appendChild(p);
}
