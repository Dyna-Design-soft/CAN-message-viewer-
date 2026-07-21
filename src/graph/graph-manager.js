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
    this.hoverTime = null;
    this.splitTracks = []; // Array<qname[]> — user-arrangeable tracks (drag & drop)
    this._colors = new Map(); // stable color per qualified signal name
    this.cursors.onChange(() => {
      for (const u of this.#allUplots()) u.redraw(false, false);
      this.#renderReadout();
      this.#updateLegends();
    });
    this.readoutEl = storeTag === 'live' ? null : document.getElementById('cursor-readout');
    this.timeEl = storeTag === 'live' ? null : document.getElementById('graph-time');
  }

  #syncingScale;

  get selection() {
    return [...this.app.selection];
  }

  #series(qname) {
    return this.app.seriesCache.get(qname, this.storeTag);
  }

  /** Stable color for a signal (kept consistent across tracks, overlay, legend). */
  colorFor(qname) {
    if (!this._colors.has(qname)) {
      this._colors.set(qname, SERIES_COLORS[this._colors.size % SERIES_COLORS.length]);
    }
    return this._colors.get(qname);
  }

  /** Reconcile the track layout with the current selection. */
  #syncTracksToSelection() {
    const sel = new Set(this.selection);
    for (const track of this.splitTracks) {
      for (let i = track.length - 1; i >= 0; i--) if (!sel.has(track[i])) track.splice(i, 1);
    }
    this.splitTracks = this.splitTracks.filter((t) => t.length);
    const present = new Set(this.splitTracks.flat());
    for (const q of this.selection) if (!present.has(q)) this.splitTracks.push([q]);
  }

  /**
   * Drop a signal onto a track (drag & drop from the signal list).
   * targetIndex null → new track; otherwise add to that existing track (moved
   * out of any other track it was in).
   */
  dropSignal(qname, targetIndex) {
    if (!this.app.dbc.signalByQualifiedName(qname)) return;
    this.app.selection.add(qname);
    for (const t of this.splitTracks) {
      const i = t.indexOf(qname);
      if (i >= 0) t.splice(i, 1);
    }
    this.splitTracks = this.splitTracks.filter((t) => t.length);
    if (targetIndex == null || targetIndex < 0 || targetIndex >= this.splitTracks.length) {
      this.splitTracks.push([qname]);
    } else if (!this.splitTracks[targetIndex].includes(qname)) {
      this.splitTracks[targetIndex].push(qname);
    }
    this.primaryMode = 'split';
    this.app.bus.emit('graph:mode', { mode: 'split' });
    this.#syncPrimary();
    requestAnimationFrame(() => this.resizeAll());
    // let the tree checkboxes / value table reflect the new selection
    this.app.bus.emit('selection:changed', { signals: [...this.app.selection] });
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
    this.#updateLegends();
  }

  #firstTimeUplot() {
    for (const g of this.graphs) {
      if (g.role === 'xy') continue;
      if (g.panes && g.panes.length) return g.panes[0].uplot;
      if (g.uplot) return g.uplot;
    }
    return null;
  }

  /** Add a cursor, spread across the current view so cursors never stack. */
  addCursor() {
    const u = this.#firstTimeUplot();
    let t = 0;
    if (u) {
      const { min, max } = u.scales.x;
      const fracs = [1 / 3, 2 / 3, 1 / 2, 1 / 2];
      t = min + (max - min) * (fracs[this.cursors.times.length] ?? 0.5);
    }
    this.cursors.add(t);
  }

  /** Nudge the active cursor left/right (dir -1/+1); big = coarse step. */
  nudgeActiveCursor(dir, big) {
    const u = this.#firstTimeUplot();
    if (!u) return;
    const i = this.cursors.active;
    if (i >= this.cursors.times.length) return;
    const { min, max } = u.scales.x;
    const step = ((max - min) / (big ? 40 : 400)) * dir;
    const t = Math.max(min, Math.min(max, this.cursors.times[i] + step));
    this.cursors.move(i, t);
  }

  resizeAll() {
    for (const g of this.graphs) {
      if (g.panes) {
        for (const p of g.panes) {
          const w = p.plotEl.clientWidth, h = p.plotEl.clientHeight;
          if (w && h) p.uplot.setSize({ width: w, height: h });
        }
      } else if (g.uplot && g.plotEl) {
        const w = g.plotEl.clientWidth, h = g.plotEl.clientHeight;
        if (w && h) g.uplot.setSize({ width: w, height: h });
      }
    }
  }

  /** Reference time for readouts: live hover, else last cursor, else playback. */
  #refTime() {
    if (this.hoverTime != null) return this.hoverTime;
    const c = this.cursors.times;
    if (c.length) return c[c.length - 1];
    if (this.cursors.playback != null) return this.cursors.playback;
    return null;
  }

  #onHover(u) {
    const left = u.cursor.left;
    const t = left != null && left >= 0 ? u.posToVal(left, 'x') : null;
    if (t === this.hoverTime) return;
    this.hoverTime = t;
    this.#updateLegends();
  }

  #updateLegends() {
    const rt = this.#refTime();
    const hovering = this.hoverTime != null;
    for (const g of this.graphs) {
      if (!g.panes) continue;
      for (const p of g.panes) {
        for (const ent of p.entries) {
          let v;
          if (rt != null) v = valueAt(ent.series, rt);
          else v = ent.series.v.length ? ent.series.v[ent.series.v.length - 1] : null;
          ent.valueEl.textContent = v == null ? '—' : fmtVal(v);
        }
      }
    }
    if (this.timeEl) {
      this.timeEl.textContent = rt == null ? '' : `${hovering ? '⌖' : 't'} = ${rt.toFixed(4)} s`;
      this.timeEl.classList.toggle('hovering', hovering);
    }
  }

  /** Full data-time range across the selected signals, or null. */
  fullXRange() {
    let lo = Infinity, hi = -Infinity;
    for (const q of this.selection) {
      const s = this.#series(q);
      if (s && s.t.length) { lo = Math.min(lo, s.t[0]); hi = Math.max(hi, s.t[s.t.length - 1]); }
    }
    return isFinite(lo) && hi > lo ? { min: lo, max: hi } : null;
  }

  /** Set the time axis on all time-based graphs (split/overlay). */
  setXRange(min, max) {
    this.#syncingScale = true;
    for (const g of this.graphs) {
      if (g.role === 'xy') continue;
      const us = g.panes ? g.panes.map((p) => p.uplot) : g.uplot ? [g.uplot] : [];
      for (const u of us) u.setScale('x', { min, max });
    }
    this.#syncingScale = false;
    this.app.bus.emit('graph:xrange', { min, max });
  }

  /** Reset the time axis to the full data range. */
  resetZoom() {
    const r = this.fullXRange();
    if (r) this.setXRange(r.min, r.max);
  }

  /** Current time axis [min,max] from the first time-based plot, or null. */
  #currentXRange() {
    const u = this.#firstTimeUplot();
    if (!u || u.scales.x.min == null) return null;
    return { min: u.scales.x.min, max: u.scales.x.max };
  }

  /** Set the X range, clamped to the data extent with a sensible minimum span. */
  #zoomTo(min, max) {
    const full = this.fullXRange();
    if (!full) return;
    if (min < full.min) min = full.min;
    if (max > full.max) max = full.max;
    const minSpan = Math.max((full.max - full.min) * 1e-4, 1e-4);
    if (max - min < minSpan) return;
    this.setXRange(min, max);
  }

  /** Zoom about a center point by a factor (>1 zooms out, <1 zooms in). */
  zoomBy(factor, centerVal) {
    const cur = this.#currentXRange();
    if (!cur) return;
    const c = centerVal == null ? (cur.min + cur.max) / 2 : centerVal;
    this.#zoomTo(c - (c - cur.min) * factor, c + (cur.max - c) * factor);
  }

  /** Pan the time axis by a fraction of the visible span (dir -1 left / +1 right). */
  panBy(dirFraction) {
    const cur = this.#currentXRange();
    if (!cur) return;
    const shift = (cur.max - cur.min) * dirFraction;
    this.#zoomTo(cur.min + shift, cur.max + shift);
  }

  /** Mouse-wheel zoom (about pointer) / shift-wheel pan on the time axis. */
  #wheelPlugin() {
    const mgr = this;
    return {
      hooks: {
        ready(u) {
          u.over.addEventListener('wheel', (e) => {
            if (u.scales.x.min == null) return;
            e.preventDefault();
            if (e.shiftKey) {
              mgr.panBy((e.deltaY > 0 ? 0.15 : -0.15));
            } else {
              const rect = u.over.getBoundingClientRect();
              const val = u.posToVal(e.clientX - rect.left, 'x');
              mgr.zoomBy(e.deltaY > 0 ? 1.25 : 1 / 1.25, val);
            }
          }, { passive: false });
        },
      },
    };
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
        this.app.bus.emit('graph:xrange', { min, max });
      },
    ];
  }

  #baseOpts(height, showXLabels) {
    return {
      height,
      cursor: {
        sync: { key: this.syncKey.key, setSeries: false },
        points: { show: false },
        drag: { x: true, y: false, dist: 6 }, // rubber-band zoom on the time axis
      },
      legend: { show: false },
      plugins: [cursorPlugin(this.cursors, () => this.#onCursorMoved()), this.#wheelPlugin()],
      hooks: {
        setScale: this.#xSyncHook(),
        setCursor: [(u) => this.#onHover(u)],
      },
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
    g.panes = [];
    g.paneHeights = g.paneHeights || {};
    this.#syncTracksToSelection();
    // keep only tracks that have at least one signal with samples
    const tracks = this.splitTracks
      .map((track) => track.map((q) => ({ q, series: this.#series(q) })).filter((s) => s.series && s.series.t.length))
      .filter((t) => t.length);
    g.titleEl.textContent = `Split view · ${tracks.length} track${tracks.length === 1 ? '' : 's'}`;
    if (tracks.length === 0) {
      empty(g.body, 'Tick or drag signals here to plot them.');
      this.#appendDropZone(g);
      return;
    }

    tracks.forEach((sigs, ti) => {
      const isLast = ti === tracks.length - 1;
      const pane = document.createElement('div');
      pane.className = 'split-pane';
      pane.style.height = (g.paneHeights[ti] ?? 160) + 'px';

      const legend = document.createElement('div');
      legend.className = 'track-legend';
      // drag grip to reorder this track
      const grip = document.createElement('span');
      grip.className = 'track-grip';
      grip.textContent = '⠿';
      grip.title = 'Drag to reorder track';
      grip.draggable = true;
      grip.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('application/x-track', String(ti));
        e.dataTransfer.effectAllowed = 'move';
      });
      legend.appendChild(grip);
      const plotEl = document.createElement('div');
      plotEl.className = 'track-plot';

      // aligned multi-series data + Y axes grouped by unit
      const { xs, cols } = buildAligned(sigs.map((s) => s.series));
      const unitScales = new Map();
      const series = [{}];
      const axes = [this.#baseOpts(0, isLast).axes[0]];
      let axisSide = 0;
      const entries = [];
      sigs.forEach((s) => {
        const color = this.colorFor(s.q);
        const unit = s.series.signal.unit || '';
        const ent = document.createElement('span');
        ent.className = 'track-entry';
        const dot = spanEl('dot'); dot.style.background = color;
        const name = spanEl('track-name'); name.textContent = shortName(s.q);
        const unitEl = spanEl('track-unit'); unitEl.textContent = unit ? ` ${unit}` : '';
        const valueEl = spanEl('track-value'); valueEl.textContent = '—';
        const rm = document.createElement('button');
        rm.className = 'entry-remove';
        rm.textContent = '✕';
        rm.title = 'Remove ' + shortName(s.q) + ' from this track';
        rm.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.removeSignalFromTrack(s.q); });
        ent.append(dot, name, unitEl, valueEl, rm);
        legend.appendChild(ent);
        entries.push({ series: s.series, valueEl });

        let scaleKey = unitScales.get(unit);
        if (!scaleKey) {
          scaleKey = 'y' + unitScales.size;
          unitScales.set(unit, scaleKey);
          axes.push({
            scale: scaleKey, stroke: AXIS_STROKE,
            grid: { show: unitScales.size === 1, stroke: GRID_STROKE, width: 1 },
            ticks: { stroke: TICK_STROKE }, side: axisSide % 2 === 0 ? 3 : 1,
            size: Y_AXIS_SIZE, font: '11px ' + MONO,
          });
          axisSide++;
        }
        series.push({
          label: shortName(s.q), stroke: color, width: 1.6, scale: scaleKey,
          spanGaps: false, paths: stepped, points: { show: false },
          value: (u, v) => (v == null ? '—' : fmtVal(v)),
        });
      });

      pane.append(legend, plotEl);
      g.body.appendChild(pane);

      const opts = {
        ...this.#baseOpts(0, isLast),
        width: plotEl.clientWidth || 600,
        height: plotEl.clientHeight || 120,
        axes,
        series,
      };
      const u = new uPlot(opts, [xs, ...cols], plotEl);
      this.syncKey.sub(u);
      g.uplots.push(u);
      g.panes.push({ entries, plotEl, uplot: u });

      this.#makeTrackDropTarget(pane, ti);
      const rez = makeVResizer(() => pane, () => {
        g.paneHeights[ti] = pane.getBoundingClientRect().height;
        u.setSize({ width: plotEl.clientWidth, height: plotEl.clientHeight });
      });
      g.body.appendChild(rez);
    });

    this.#appendDropZone(g);
    this.#updateLegends();
  }

  #makeTrackDropTarget(pane, index) {
    pane.addEventListener('dragover', (e) => { e.preventDefault(); pane.classList.add('drop-hover'); });
    pane.addEventListener('dragleave', () => pane.classList.remove('drop-hover'));
    pane.addEventListener('drop', (e) => {
      e.preventDefault();
      pane.classList.remove('drop-hover');
      const trackIdx = e.dataTransfer.getData('application/x-track');
      if (trackIdx !== '') { this.reorderTrack(Number(trackIdx), index); return; }
      const q = e.dataTransfer.getData('text/plain');
      if (q) this.dropSignal(q, index);
    });
  }

  #appendDropZone(g) {
    const dz = document.createElement('div');
    dz.className = 'track-dropzone';
    dz.textContent = 'Drag a signal here to add a new track';
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drop-hover'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('drop-hover'));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('drop-hover');
      const trackIdx = e.dataTransfer.getData('application/x-track');
      if (trackIdx !== '') { this.reorderTrack(Number(trackIdx), null); return; }
      const q = e.dataTransfer.getData('text/plain');
      if (q) this.dropSignal(q, null);
    });
    g.body.appendChild(dz);
  }

  /** Move a track to a new position (to = null → end). */
  reorderTrack(from, to) {
    const arr = this.splitTracks;
    if (from == null || from < 0 || from >= arr.length) return;
    const dest = to == null ? arr.length - 1 : (from < to ? to - 1 : to);
    if (dest === from) return;
    const [moved] = arr.splice(from, 1);
    arr.splice(Math.max(0, Math.min(dest, arr.length)), 0, moved);
    this.#syncPrimary();
    requestAnimationFrame(() => this.resizeAll());
  }

  /** Remove one signal from its track (and deselect it). */
  removeSignalFromTrack(qname) {
    for (const t of this.splitTracks) {
      const i = t.indexOf(qname);
      if (i >= 0) t.splice(i, 1);
    }
    this.splitTracks = this.splitTracks.filter((t) => t.length);
    this.app.selection.delete(qname);
    this.#syncPrimary();
    requestAnimationFrame(() => this.resizeAll());
    this.app.bus.emit('selection:changed', { signals: [...this.app.selection] });
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
        stroke: this.colorFor(s.q),
        dash: DASHES[i % DASHES.length] || undefined,
        width: 1.5,
        scale: scaleKey,
        spanGaps: false,
        paths: stepped,
        points: { show: false },
        value: (u, v) => (v == null ? '—' : fmtVal(v)),
      });
    });
    const plotEl = this.#mountResizable(g, 300);
    const opts = { ...base, width: plotEl.clientWidth || 600, height: plotEl.clientHeight || 280, series, axes, legend: { show: true } };
    g.uplot = new uPlot(opts, [xs, ...cols], plotEl);
    this.syncKey.sub(g.uplot);
  }

  /** Give a card an explicit-height body (flex) with a bottom drag handle. */
  #mountResizable(g, defaultH) {
    g.body.textContent = '';
    g.body.style.display = 'flex';
    g.body.style.flexDirection = 'column';
    g.body.style.height = (g.bodyHeight ?? defaultH) + 'px';
    const plotEl = document.createElement('div');
    plotEl.className = 'track-plot';
    g.body.appendChild(plotEl);
    if (!g.resizer) {
      g.el.classList.add('resizable');
      g.resizer = makeVResizer(() => g.body, (h) => {
        g.bodyHeight = h;
        if (g.uplot) g.uplot.setSize({ width: plotEl.clientWidth, height: plotEl.clientHeight });
      });
      g.el.appendChild(g.resizer);
    }
    g.plotEl = plotEl;
    return plotEl;
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
    const plotEl = this.#mountResizable(g, 280);
    const opts = {
      width: plotEl.clientWidth || 600,
      height: plotEl.clientHeight || 260,
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
    g.uplot = new uPlot(opts, [null, [xv.subarray(0, m), yv.subarray(0, m)]], plotEl);
  }

  // ---- shared ----

  #onCursorMoved() {
    for (const u of this.#allUplots()) u.redraw(false, false);
    this.#updateLegends();
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
      p.textContent = 'Tick a signal, or drag one from the list onto a track.';
      this.container.appendChild(p);
    }
  }

  #renderReadout() {
    if (!this.readoutEl) return;
    const times = this.cursors.times;
    const sel = this.selection;
    if (times.length === 0 || sel.length === 0) { this.readoutEl.hidden = true; return; }
    this.readoutEl.hidden = false;
    this.readoutEl.textContent = '';

    const region = times.length >= 2;
    if (region) {
      const a = times[0], b = times[1];
      const info = document.createElement('div');
      info.className = 'region-info';
      info.textContent = `A→B region · Δt = ${Math.abs(b - a).toFixed(4)} s  ` +
        `(A ${Math.min(a, b).toFixed(4)}s → B ${Math.max(a, b).toFixed(4)}s)`;
      this.readoutEl.appendChild(info);
    }

    const header = ['Signal', ...times.map((_, i) => `C${i + 1}`)];
    if (region) header.push('Δ', 'Min', 'Max', 'Mean', 'P-P');

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
      if (region) {
        const d = vals[1] != null && vals[0] != null ? vals[1] - vals[0] : null;
        cells.push(d == null ? '—' : fmtVal(d));
        const st = regionStats(series, times[0], times[1]);
        if (st) cells.push(fmtVal(st.min), fmtVal(st.max), fmtVal(st.mean), fmtVal(st.pp));
        else cells.push('—', '—', '—', '—');
      }
      const tr = document.createElement('tr');
      cells.forEach((c) => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    this.readoutEl.appendChild(t);
  }
}

/**
 * Statistics of a signal over the time region [a,b]: min, max, peak-to-peak,
 * and a time-weighted (sample-and-hold) mean.
 */
export function regionStats(series, a, b) {
  if (!series || !series.t.length) return null;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  let min = Infinity, max = -Infinity, area = 0;
  let prevT = lo;
  let prevV = valueAt(series, lo); // sample-and-hold value at the left edge
  if (prevV != null) { min = prevV; max = prevV; }
  for (let i = 0; i < series.t.length; i++) {
    const t = series.t[i];
    if (t < lo) continue;
    if (t > hi) break;
    const v = series.v[i];
    if (prevV != null) area += prevV * (t - prevT);
    prevT = t;
    prevV = v;
    if (v != null) { if (v < min) min = v; if (v > max) max = v; }
  }
  if (prevV != null) area += prevV * (hi - prevT);
  if (!isFinite(min)) return null;
  const dur = hi - lo;
  const mean = dur > 0 ? area / dur : prevV;
  return { min, max, mean, pp: max - min, dur };
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

function spanEl(cls) {
  const s = document.createElement('span');
  s.className = cls;
  return s;
}

/**
 * Vertical drag handle. `getEl` returns the element whose height to change;
 * `onResize(newHeight)` fires during the drag. Returns the handle element.
 */
function makeVResizer(getEl, onResize) {
  const h = document.createElement('div');
  h.className = 'pane-resizer';
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'horizontal');
  let startY = 0, startH = 0;
  h.addEventListener('pointerdown', (e) => {
    const el = getEl();
    startY = e.clientY;
    startH = el.getBoundingClientRect().height;
    h.setPointerCapture(e.pointerId);
    e.preventDefault();
    const move = (ev) => {
      const nh = Math.max(70, startH + (ev.clientY - startY));
      el.style.height = nh + 'px';
      onResize(nh);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  return h;
}
