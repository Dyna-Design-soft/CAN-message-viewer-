// Manages the analysis graph area. A single "primary" graph auto-follows the
// signal selection in one of two layouts:
//   - split   : one aligned sub-plot per signal, stacked, sharing the time axis
//               (the reference layout — each selected signal in its own graph)
//   - overlay : all signals on one plot, grouped onto Y axes by unit
// Plus any number of XY graphs. Every plot shares one synchronized X axis and
// one cursor model (drag a cursor / zoom on any plot → all follow).

/* global uPlot */
import { CursorModel, cursorPlugin } from './cursors.js';
import { lowerBound } from '../util/time.js';

// Accessible categorical palette (distinct hues); series are ALSO distinguished
// by dash pattern so they're separable without color (colorblind-safe).
const SERIES_COLORS = [
  '#4da3ff', '#ffa94d', '#22c55e', '#e879f9', '#38e0d0',
  '#f472b6', '#a3e635', '#fbbf24', '#818cf8', '#fb7185',
];
const DASHES = [null, [6, 3], [2, 3], [8, 3, 2, 3], [12, 4]];

const AXIS_STROKE = '#8a94a6';
const GRID_STROKE = 'rgba(255,255,255,0.06)';
const TICK_STROKE = 'rgba(255,255,255,0.10)';
const Y_AXIS_SIZE = 56;

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
    this.graphs = []; // cards: { role:'primary'|'xy', mode?, el, body, uplot?, uplots?, ... }
    this.primaryMode = 'split';
    this.cursors = new CursorModel();
    this.syncKey = uPlot.sync('graphstack-' + storeTag);
    this.#syncingScale = false;
    this.cursors.onChange(() => this.#renderReadout());
    this.readoutEl = storeTag === 'live' ? null : document.getElementById('cursor-readout');
  }

  #syncingScale;

  get selection() {
    return [...this.app.selection];
  }

  #series(qname) {
    return this.app.seriesCache.get(qname, this.storeTag);
  }

  * #allUplots() {
    for (const g of this.graphs) {
      if (g.uplot) yield g.uplot;
      if (g.uplots) for (const u of g.uplots) yield u;
    }
  }

  /** Switch the primary graph layout (split | overlay). */
  setMode(mode) {
    this.primaryMode = mode;
    this.#syncPrimary();
  }

  addXY() {
    this.#placeholderOff();
    const sel = this.selection;
    const g = { role: 'xy', xSel: sel[0] ?? null, ySel: sel[1] ?? sel[0] ?? null };
    g.el = this.#makeCard('XY graph', g, true);
    this.container.appendChild(g.el);
    this.graphs.push(g);
    this.#buildXY(g);
    return g;
  }

  removeGraph(g) {
    this.#destroyPlots(g);
    g.el.remove();
    this.graphs = this.graphs.filter((x) => x !== g);
    if (this.graphs.length === 0) this.#placeholderOn();
    this.#renderReadout();
  }

  onSelectionChanged() {
    this.#syncPrimary();
    for (const g of this.graphs) {
      if (g.role === 'xy') {
        this.#refreshXYControls(g);
        this.#buildXY(g);
      }
    }
    this.#renderReadout();
  }

  rebuild() {
    this.#syncPrimary();
    for (const g of this.graphs) {
      if (g.role === 'xy') this.#buildXY(g);
    }
    this.#renderReadout();
  }

  setPlaybackTime(t) {
    this.cursors.setPlayback(t);
    for (const u of this.#allUplots()) u.redraw(false, false);
  }

  resizeAll() {
    for (const g of this.graphs) {
      const w = g.body.clientWidth;
      if (!w) continue;
      if (g.uplots) for (const u of g.uplots) u.setSize({ width: w, height: u.height });
      else if (g.uplot) g.uplot.setSize({ width: w, height: g.uplot.height });
    }
  }

  // ---- primary graph (auto-follows selection) ----

  #syncPrimary() {
    let g = this.graphs.find((x) => x.role === 'primary');
    const sel = this.selection;
    if (sel.length === 0) {
      if (g) this.removeGraph(g);
      if (this.graphs.length === 0) this.#placeholderOn();
      return;
    }
    this.#placeholderOff();
    if (g && g.mode !== this.primaryMode) {
      this.#destroyPlots(g);
      g.el.remove();
      this.graphs = this.graphs.filter((x) => x !== g);
      g = null;
    }
    if (!g) {
      g = { role: 'primary', mode: this.primaryMode };
      g.el = this.#makeCard('', g, false);
      this.container.insertBefore(g.el, this.container.firstChild);
      this.graphs.unshift(g);
    }
    if (this.primaryMode === 'split') this.#buildSplit(g);
    else this.#buildOverlay(g);
  }

  // ---- card scaffolding ----

  #makeCard(title, g, withRemove) {
    const card = document.createElement('div');
    card.className = 'graph-card';
    const head = document.createElement('div');
    head.className = 'graph-card-head';
    g.titleEl = document.createElement('span');
    g.titleEl.textContent = title;
    head.appendChild(g.titleEl);
    g.controls = document.createElement('span');
    g.controls.style.cssText = 'flex:1;display:flex;gap:8px;align-items:center;';
    head.appendChild(g.controls);
    if (withRemove) {
      const rm = document.createElement('button');
      rm.className = 'btn icon-btn';
      rm.textContent = '✕';
      rm.title = 'Remove graph';
      rm.setAttribute('aria-label', 'Remove graph');
      rm.addEventListener('click', () => this.removeGraph(g));
      head.appendChild(rm);
    }
    card.appendChild(head);
    g.body = document.createElement('div');
    g.body.className = 'graph-card-body';
    card.appendChild(g.body);
    return card;
  }

  #destroyPlots(g) {
    if (g.uplots) { for (const u of g.uplots) u.destroy(); g.uplots = null; }
    if (g.uplot) { g.uplot.destroy(); g.uplot = null; }
  }

  #xSyncHook() {
    return [
      (u, key) => {
        if (key !== 'x' || this.#syncingScale) return;
        this.#syncingScale = true;
        const { min, max } = u.scales.x;
        for (const other of this.#allUplots()) {
          if (other !== u) other.setScale('x', { min, max });
        }
        this.#syncingScale = false;
      },
    ];
  }

  #baseOpts(height, showXLabels) {
    return {
      height,
      cursor: { sync: { key: this.syncKey.key, setSeries: false }, points: { show: false } },
      legend: { show: false },
      plugins: [cursorPlugin(this.cursors, () => this.#onCursorMoved())],
      hooks: { setScale: this.#xSyncHook() },
      axes: [
        {
          stroke: AXIS_STROKE,
          grid: { stroke: GRID_STROKE, width: 1 },
          ticks: { stroke: TICK_STROKE, width: 1 },
          font: '11px ' + MONO,
          values: showXLabels ? undefined : () => [],
          size: showXLabels ? 34 : 22,
        },
      ],
      scales: { x: { time: false } },
    };
  }

  // ---- SPLIT: one aligned sub-plot per signal ----

  #buildSplit(g) {
    this.#destroyPlots(g);
    g.body.textContent = '';
    g.uplots = [];
    const sigs = this.selection.map((q) => ({ q, series: this.#series(q) })).filter((s) => s.series && s.series.t.length);
    g.titleEl.textContent = `Split view · ${sigs.length} signal${sigs.length === 1 ? '' : 's'}`;
    if (sigs.length === 0) {
      empty(g.body, 'Selected signals have no samples in this log.');
      return;
    }
    const width = g.body.clientWidth || 600;
    sigs.forEach((s, i) => {
      const isLast = i === sigs.length - 1;
      const color = SERIES_COLORS[i % SERIES_COLORS.length];
      const pane = document.createElement('div');
      pane.className = 'split-pane';
      const label = document.createElement('div');
      label.className = 'split-pane-label';
      const unit = s.series.signal.unit ? ` [${s.series.signal.unit}]` : '';
      label.innerHTML = `<span class="dot" style="background:${color}"></span>${shortName(s.q)}${unit}`;
      pane.appendChild(label);
      g.body.appendChild(pane);

      const opts = {
        ...this.#baseOpts(isLast ? 150 : 128, isLast),
        width,
        axes: [
          this.#baseOpts(0, isLast).axes[0],
          { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE, width: 1 }, ticks: { stroke: TICK_STROKE }, size: Y_AXIS_SIZE, font: '11px ' + MONO },
        ],
        series: [
          {},
          {
            stroke: color,
            width: 1.6,
            spanGaps: false,
            paths: stepped,
            points: { show: false },
            value: (u, v) => (v == null ? '—' : fmtVal(v)),
          },
        ],
      };
      const u = new uPlot(opts, [s.series.t, s.series.v], pane);
      this.syncKey.sub(u);
      g.uplots.push(u);
    });
  }

  // ---- OVERLAY: all signals on one plot, Y axes grouped by unit ----

  #buildOverlay(g) {
    this.#destroyPlots(g);
    g.body.textContent = '';
    const sigs = this.selection.map((q) => ({ q, series: this.#series(q) })).filter((s) => s.series && s.series.t.length);
    g.titleEl.textContent = `Overlay · ${sigs.length} signal${sigs.length === 1 ? '' : 's'}`;
    if (sigs.length === 0) {
      empty(g.body, 'Selected signals have no samples in this log.');
      return;
    }
    const { xs, cols } = buildAligned(sigs.map((s) => s.series));
    const unitScales = new Map();
    const series = [{}];
    const base = this.#baseOpts(280, true);
    const axes = [base.axes[0]];
    let axisSide = 0;
    sigs.forEach((s, i) => {
      const unit = s.series.signal.unit || '—';
      let scaleKey = unitScales.get(unit);
      if (!scaleKey) {
        scaleKey = 'y' + unitScales.size;
        unitScales.set(unit, scaleKey);
        axes.push({
          scale: scaleKey,
          stroke: AXIS_STROKE,
          grid: { show: unitScales.size === 1, stroke: GRID_STROKE, width: 1 },
          ticks: { stroke: TICK_STROKE },
          side: axisSide % 2 === 0 ? 3 : 1,
          label: unit,
          labelSize: 14,
          size: Y_AXIS_SIZE,
          font: '11px ' + MONO,
        });
        axisSide++;
      }
      series.push({
        label: shortName(s.q),
        stroke: SERIES_COLORS[i % SERIES_COLORS.length],
        dash: DASHES[i % DASHES.length] || undefined,
        width: 1.5,
        scale: scaleKey,
        spanGaps: false,
        paths: stepped,
        points: { show: false },
        value: (u, v) => (v == null ? '—' : fmtVal(v)),
      });
    });
    const opts = { ...base, width: g.body.clientWidth || 600, series, axes, legend: { show: true } };
    g.uplot = new uPlot(opts, [xs, ...cols], g.body);
    this.syncKey.sub(g.uplot);
  }

  // ---- XY ----

  #refreshXYControls(g) {
    g.controls.textContent = '';
    const mkSel = (which, current) => {
      const s = document.createElement('select');
      s.setAttribute('aria-label', which === 'xSel' ? 'X signal' : 'Y signal');
      for (const q of this.selection) {
        const o = document.createElement('option');
        o.value = q;
        o.textContent = shortName(q);
        if (q === current) o.selected = true;
        s.appendChild(o);
      }
      s.addEventListener('change', () => { g[which] = s.value; this.#buildXY(g); });
      return s;
    };
    const x = document.createElement('span'); x.className = 'muted'; x.textContent = 'X';
    const y = document.createElement('span'); y.className = 'muted'; y.textContent = 'Y';
    g.controls.append(x, mkSel('xSel', g.xSel), y, mkSel('ySel', g.ySel));
  }

  #buildXY(g) {
    if (!g.controls.hasChildNodes()) this.#refreshXYControls(g);
    this.#destroyPlots(g);
    g.body.textContent = '';
    const xs = this.#series(g.xSel);
    const ys = this.#series(g.ySel);
    if (!xs || !ys) { empty(g.body, 'Select X and Y signals.'); return; }
    const n = xs.t.length;
    const xv = new Float64Array(n);
    const yv = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const yatt = valueAt(ys, xs.t[i]);
      if (yatt == null) continue;
      xv[m] = xs.v[i]; yv[m] = yatt; m++;
    }
    const opts = {
      width: g.body.clientWidth || 600,
      height: 260,
      mode: 2,
      legend: { show: false },
      scales: { x: { time: false }, y: {} },
      axes: [
        { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE, width: 1 }, ticks: { stroke: TICK_STROKE }, label: shortName(g.xSel), font: '11px ' + MONO },
        { stroke: AXIS_STROKE, grid: { stroke: GRID_STROKE, width: 1 }, ticks: { stroke: TICK_STROKE }, label: shortName(g.ySel), size: Y_AXIS_SIZE, font: '11px ' + MONO },
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
    g.uplot = new uPlot(opts, [null, [xv.subarray(0, m), yv.subarray(0, m)]], g.body);
  }

  // ---- shared ----

  #onCursorMoved() {
    for (const u of this.#allUplots()) u.redraw(false, false);
    this.#renderReadout();
  }

  #placeholderOff() {
    const ph = this.container.querySelector('.placeholder');
    if (ph) ph.remove();
  }

  #placeholderOn() {
    if (!this.container.querySelector('.placeholder')) {
      const p = document.createElement('p');
      p.className = 'placeholder';
      p.textContent = 'Tick signals on the left — each appears as its own aligned graph.';
      this.container.appendChild(p);
    }
  }

  #renderReadout() {
    if (!this.readoutEl) return;
    const times = this.cursors.times;
    const sel = this.selection;
    if (times.length === 0 || sel.length === 0) { this.readoutEl.hidden = true; return; }
    this.readoutEl.hidden = false;
    const header = ['Signal', ...times.map((t, i) => `C${i + 1} @ ${t.toFixed(4)}s`)];
    if (times.length >= 2) header.push('Δ (C2−C1)');
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
    for (const q of sel) {
      const series = this.#series(q);
      const cells = [shortName(q)];
      const vals = times.map((tt) => valueAt(series, tt));
      cells.push(...vals.map((v) => (v == null ? '—' : fmtVal(v))));
      if (times.length >= 2) {
        const d = vals[1] != null && vals[0] != null ? vals[1] - vals[0] : null;
        cells.push(d == null ? '—' : fmtVal(d));
      }
      const tr = document.createElement('tr');
      cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    this.readoutEl.textContent = '';
    this.readoutEl.appendChild(t);
  }
}

/**
 * Merge several series onto a shared, sorted, de-duplicated time axis with
 * sample-and-hold. Returns { xs, cols } aligned to xs (NaN before first sample).
 */
export function buildAligned(seriesList) {
  let total = 0;
  for (const s of seriesList) total += s.t.length;
  const all = new Float64Array(total);
  let k = 0;
  for (const s of seriesList) { all.set(s.t, k); k += s.t.length; }
  all.sort();
  const xs = new Float64Array(total);
  let n = 0;
  for (let i = 0; i < total; i++) if (n === 0 || all[i] !== xs[n - 1]) xs[n++] = all[i];
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

const MONO = '"Cascadia Code", Consolas, "DejaVu Sans Mono", monospace';

function shortName(qname) {
  return qname.split('/').slice(1).join('.');
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
