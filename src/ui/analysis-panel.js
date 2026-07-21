// Analysis panel: signal tree (checkboxes) -> value table + graph stack,
// with a scrubbing playback clock and synchronized cursors.

import { GraphManager, valueAt, buildAligned } from '../graph/graph-manager.js';
import { formatId } from '../util/hex.js';
import { decodeMessage, valueLabel } from '../core/decoder.js';

export function initAnalysisPanel(app) {
  const treeEl = document.getElementById('signal-tree');
  const filterEl = document.getElementById('signal-filter');
  const tableBody = document.querySelector('#signal-value-table tbody');
  const graphStack = document.getElementById('graph-stack');

  const graphs = new GraphManager(app, graphStack, 'log');
  app.analysisGraphs = graphs;

  const playback = new PlaybackClock();

  // ---- signal tree ----
  function renderTree() {
    treeEl.textContent = '';
    if (app.dbc.clusters.length === 0) {
      treeEl.innerHTML = '<p class="placeholder">Load a DBC file to list signals.</p>';
      return;
    }
    const filter = filterEl.value.trim().toLowerCase();
    for (const cluster of app.dbc.clusters) {
      const cNode = details('tree-node', cluster.name, true);
      const cChildren = div('tree-children');
      let clusterHasMatch = false;
      const messages = [...cluster.messages.values()].sort((a, b) => a.id - b.id);
      for (const msg of messages) {
        const mNode = details('tree-node', '', false);
        const sum = mNode.querySelector('summary');
        sum.textContent = '';
        sum.append(spanTxt('tree-tag', formatId(msg.id, msg.extended)), document.createTextNode(' ' + msg.name));
        const mChildren = div('tree-children');
        let msgHasMatch = false;
        for (const sig of msg.signals) {
          const q = sig.qualifiedName;
          if (filter && !sig.name.toLowerCase().includes(filter) && !msg.name.toLowerCase().includes(filter)) continue;
          msgHasMatch = true;
          const leaf = document.createElement('label');
          leaf.className = 'tree-leaf';
          leaf.draggable = true;
          leaf.title = 'Drag onto a graph track, or tick to plot';
          leaf.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', q);
            e.dataTransfer.effectAllowed = 'copyMove';
          });
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.dataset.q = q;
          cb.checked = app.selection.has(q);
          cb.addEventListener('change', () => {
            if (cb.checked) app.selection.add(q);
            else app.selection.delete(q);
            onSelectionChanged();
          });
          leaf.append(cb, document.createTextNode(sig.name));
          if (sig.unit) leaf.append(spanTxt('tree-tag', ` [${sig.unit}]`));
          mChildren.appendChild(leaf);
        }
        if (msgHasMatch) {
          mNode.appendChild(mChildren);
          if (filter) mNode.open = true;
          cChildren.appendChild(mNode);
          clusterHasMatch = true;
        }
      }
      if (clusterHasMatch) {
        cNode.appendChild(cChildren);
        treeEl.appendChild(cNode);
      }
    }
    if (!treeEl.children.length) {
      treeEl.innerHTML = '<p class="placeholder">No signals match the filter.</p>';
    }
  }

  filterEl.addEventListener('input', renderTree);

  function onSelectionChanged() {
    app.bus.emit('selection:changed', { signals: [...app.selection] });
    graphs.onSelectionChanged();
    renderTable();
  }

  // Programmatically set the checked signals (used by demo auto-load).
  app.applySelection = (qnames) => {
    app.selection.clear();
    for (const q of qnames) app.selection.add(q);
    renderTree();
    onSelectionChanged();
  };

  // A drag-drop onto a track (from graph-manager) changes the selection without
  // going through a checkbox — sync the tree checkboxes and the value table.
  app.bus.on('selection:changed', ({ signals }) => {
    const set = new Set(signals);
    for (const cb of treeEl.querySelectorAll('.tree-leaf input')) {
      cb.checked = set.has(cb.dataset.q);
    }
    renderTable();
  });

  // ---- value table (follows playback time) ----
  function renderTable() {
    const t = playback.time;
    tableBody.textContent = '';
    if (app.selection.size === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'placeholder';
      td.textContent = 'Tick signals on the left to watch their values.';
      tr.appendChild(td);
      tableBody.appendChild(tr);
      return;
    }
    for (const q of app.selection) {
      const sig = app.dbc.signalByQualifiedName(q);
      const series = app.seriesCache.get(q, 'log');
      const v = valueAt(series, t);
      const tr = document.createElement('tr');
      const raw = v == null ? null : Math.round((v - sig.offset) / sig.factor);
      const label = v == null ? null : valueLabel(sig, v);
      cells(tr, [
        sigLabel(sig),
        v == null ? '—' : label ? `${fmt(v)} (${label})` : fmt(v),
        sig?.unit || '',
        raw == null ? '—' : String(raw),
        sig?.message?.name ?? '',
      ]);
      tableBody.appendChild(tr);
    }
  }

  // ---- playback ----
  const slider = document.getElementById('pb-slider');
  const timeLabel = document.getElementById('pb-time');
  const playBtn = document.getElementById('pb-play');
  const speedSel = document.getElementById('pb-speed');

  playback.onTick = (t) => {
    timeLabel.textContent = t.toFixed(3) + ' s';
    if (playback.range > 0) {
      slider.value = String(Math.round(((t - playback.tMin) / playback.range) * 1000));
    }
    graphs.setPlaybackTime(t);
    for (const g of graphs.graphs) g.uplot?.redraw(false, false);
    renderTable();
    app.bus.emit('playback:time', { t });
  };
  playback.onPlayStateChanged = (playing) => {
    playBtn.textContent = playing ? '❚❚' : '▶';
  };

  slider.addEventListener('input', () => {
    if (playback.range <= 0) return;
    playback.pause();
    playback.setTime(playback.tMin + (Number(slider.value) / 1000) * playback.range);
  });
  playBtn.addEventListener('click', () => playback.toggle());
  document.getElementById('pb-stop').addEventListener('click', () => {
    playback.pause();
    playback.setTime(playback.tMin);
  });
  speedSel.addEventListener('change', () => (playback.speed = Number(speedSel.value)));

  // ---- table update interval ----
  const intervalSel = document.getElementById('table-interval');
  let tableTimer = null;
  function applyInterval() {
    clearInterval(tableTimer);
    tableTimer = setInterval(() => {
      if (playback.playing) renderTable();
    }, Number(intervalSel.value));
  }
  intervalSel.addEventListener('change', applyInterval);
  applyInterval();

  // ---- graph toolbar: layout mode (split / overlay) + XY + cursors ----
  const modeSplit = document.getElementById('graph-mode-split');
  const modeOverlay = document.getElementById('graph-mode-overlay');
  function setMode(mode) {
    modeSplit.classList.toggle('is-active', mode === 'split');
    modeOverlay.classList.toggle('is-active', mode === 'overlay');
    graphs.setMode(mode);
    requestAnimationFrame(() => graphs.resizeAll());
  }
  modeSplit.addEventListener('click', () => setMode('split'));
  modeOverlay.addEventListener('click', () => setMode('overlay'));
  app.bus.on('graph:mode', ({ mode }) => {
    modeSplit.classList.toggle('is-active', mode === 'split');
    modeOverlay.classList.toggle('is-active', mode === 'overlay');
  });
  document.getElementById('graph-add-xy').addEventListener('click', () => {
    graphs.addXY();
    requestAnimationFrame(() => graphs.resizeAll());
  });
  document.getElementById('cursor-add').addEventListener('click', () => graphs.addCursor());
  document.getElementById('cursor-clear').addEventListener('click', () => graphs.cursors.clear());
  document.getElementById('graph-reset').addEventListener('click', () => graphs.resetZoom());
  document.getElementById('zoom-in').addEventListener('click', () => graphs.zoomBy(1 / 1.6));
  document.getElementById('zoom-out').addEventListener('click', () => graphs.zoomBy(1.6));
  document.getElementById('graph-export-csv').addEventListener('click', exportCsv);

  // ---- CSV export of the selected signals over the current time window ----
  function exportCsv() {
    const qs = [...app.selection];
    if (qs.length === 0) { alert('Tick one or more signals to export.'); return; }
    const cols = qs.map((q) => ({ q, sig: app.dbc.signalByQualifiedName(q), series: app.seriesCache.get(q, 'log') }))
      .filter((c) => c.series && c.series.t.length);
    if (cols.length === 0) { alert('The selected signals have no samples to export.'); return; }

    const from = playback.tMin, to = playback.tMax;
    // Union time axis (sample-and-hold), then clip to the window.
    const { xs, cols: values } = buildAligned(cols.map((c) => c.series));
    const rows = [];
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < from || xs[i] > to) continue;
      const row = [xs[i].toFixed(6)];
      for (let c = 0; c < cols.length; c++) {
        const v = values[c][i];
        row.push(Number.isFinite(v) ? String(v) : '');
      }
      rows.push(row.join(','));
    }
    const header = ['time_s', ...cols.map((c) => csvField(c.sig?.unit ? `${short(c.q)} [${c.sig.unit}]` : short(c.q)))];
    const csv = header.join(',') + '\n' + rows.join('\n') + '\n';
    const base = (app.logFileName || 'analysis').replace(/\.[^.]+$/, '');
    downloadText(`${base}_signals.csv`, csv);
  }

  // Arrow keys nudge the active cursor (Shift = coarse). Ignored while typing.
  document.addEventListener('keydown', (e) => {
    const analysisActive = document.getElementById('panel-analysis').classList.contains('active');
    if (!analysisActive || !graphs.cursors.times.length) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
    if (e.key === 'ArrowLeft') { graphs.nudgeActiveCursor(-1, e.shiftKey); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { graphs.nudgeActiveCursor(1, e.shiftKey); e.preventDefault(); }
  });

  // ---- mobile: signal drawer + Table/Graphs segmented control ----
  const layout = document.querySelector('.analysis-layout');
  const split = document.querySelector('.analysis-split');
  const openDrawer = () => layout.classList.add('drawer-open');
  const closeDrawer = () => layout.classList.remove('drawer-open');
  document.getElementById('drawer-toggle').addEventListener('click', openDrawer);
  document.getElementById('signal-drawer-close').addEventListener('click', closeDrawer);
  document.getElementById('signal-drawer-backdrop').addEventListener('click', closeDrawer);
  for (const b of document.querySelectorAll('#analysis-segmented button')) {
    b.addEventListener('click', () => {
      for (const x of document.querySelectorAll('#analysis-segmented button')) x.classList.toggle('active', x === b);
      split.classList.toggle('show-table', b.dataset.seg === 'table');
      split.classList.toggle('show-graphs', b.dataset.seg === 'graphs');
      requestAnimationFrame(() => graphs.resizeAll());
    });
  }

  // ---- desktop: draggable splitter between value table and graph area ----
  const splitter = document.getElementById('analysis-splitter');
  const tableArea = document.querySelector('.analysis-table-area');
  if (splitter && tableArea) {
    splitter.addEventListener('pointerdown', (e) => {
      const startX = e.clientX;
      const startW = tableArea.getBoundingClientRect().width;
      splitter.setPointerCapture(e.pointerId);
      e.preventDefault();
      const move = (ev) => {
        const max = split.getBoundingClientRect().width - 260;
        const w = Math.max(220, Math.min(startW + (ev.clientX - startX), max));
        tableArea.style.width = w + 'px';
        graphs.resizeAll();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  // ---- time-window control (Full / From–To) ----
  const rFrom = document.getElementById('range-from');
  const rTo = document.getElementById('range-to');
  const rApply = document.getElementById('range-apply');
  const rFull = document.getElementById('range-full');
  let fullMin = 0, fullMax = 0;
  const fmtT = (v) => (Math.round(v * 1000) / 1000).toString();
  function setRangeEnabled(on) { [rFrom, rTo, rApply, rFull].forEach((e) => (e.disabled = !on)); }
  function applyRange() {
    let from = Number(rFrom.value), to = Number(rTo.value);
    if (Number.isNaN(from) || Number.isNaN(to)) return;
    if (to < from) { const t = from; from = to; to = t; }
    from = Math.max(fullMin, from);
    to = Math.min(fullMax, to);
    if (to - from < 1e-6) return;
    graphs.setXRange(from, to);
    playback.setRange(from, to);
    if (playback.time < from || playback.time > to) playback.setTime(from);
    rFrom.value = fmtT(from); rTo.value = fmtT(to);
  }
  function fullRange() {
    graphs.resetZoom();
    playback.setRange(fullMin, fullMax);
    rFrom.value = fmtT(fullMin); rTo.value = fmtT(fullMax);
  }
  rApply.addEventListener('click', applyRange);
  rFull.addEventListener('click', fullRange);
  for (const el of [rFrom, rTo]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyRange(); });
  // reflect drag-zoom in the inputs
  app.bus.on('graph:xrange', ({ min, max }) => {
    if (document.activeElement !== rFrom && document.activeElement !== rTo) {
      rFrom.value = fmtT(min); rTo.value = fmtT(max);
    }
  });

  // ---- events ----
  app.bus.on('dbc:changed', () => {
    renderTree();
    renderTable();
  });
  app.bus.on('log:loaded', ({ stats }) => {
    playback.setRange(stats.tFirst, stats.tLast);
    playback.setTime(stats.tFirst);
    fullMin = stats.tFirst; fullMax = stats.tLast;
    rFrom.value = fmtT(fullMin); rTo.value = fmtT(fullMax);
    setRangeEnabled(true);
    graphs.rebuild();
    renderTable();
  });
  app.bus.on('log:cleared', () => {
    playback.setRange(0, 0);
    fullMin = fullMax = 0;
    rFrom.value = ''; rTo.value = '';
    setRangeEnabled(false);
    graphs.rebuild();
    renderTable();
  });

  // Resize graphs when the Analysis tab becomes visible or the window resizes.
  app.bus.on('tab:changed', ({ panel }) => {
    if (panel === 'panel-analysis') requestAnimationFrame(() => graphs.resizeAll());
  });
  window.addEventListener('resize', () => graphs.resizeAll());

  renderTree();
  renderTable();
}

// Playback clock: rAF-anchored, drives slider/cursor/graphs/table.
class PlaybackClock {
  constructor() {
    this.tMin = 0;
    this.tMax = 0;
    this.time = 0;
    this.speed = 1;
    this.playing = false;
    this.onTick = null;
    this.onPlayStateChanged = null;
    this.#raf = null;
  }
  #raf;
  #last = 0;

  get range() {
    return this.tMax - this.tMin;
  }

  setRange(tMin, tMax) {
    this.tMin = tMin;
    this.tMax = tMax;
    this.time = Math.min(Math.max(this.time, tMin), tMax);
  }

  setTime(t) {
    this.time = Math.min(Math.max(t, this.tMin), this.tMax);
    this.onTick?.(this.time);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  play() {
    if (this.playing || this.range <= 0) return;
    if (this.time >= this.tMax) this.time = this.tMin;
    this.playing = true;
    this.onPlayStateChanged?.(true);
    this.#last = performance.now();
    const loop = (now) => {
      if (!this.playing) return;
      const dt = ((now - this.#last) / 1000) * this.speed;
      this.#last = now;
      let t = this.time + dt;
      if (t >= this.tMax) {
        t = this.tMax;
        this.setTime(t);
        this.pause();
        return;
      }
      this.setTime(t);
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.onPlayStateChanged?.(false);
    cancelAnimationFrame(this.#raf);
  }
}

// ---- small DOM helpers ----
function details(cls, summaryText, open) {
  const d = document.createElement('details');
  d.className = cls;
  d.open = open;
  const s = document.createElement('summary');
  s.textContent = summaryText;
  d.appendChild(s);
  return d;
}
function div(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
function spanTxt(cls, txt) {
  const s = document.createElement('span');
  s.className = cls;
  s.textContent = txt;
  return s;
}
function cells(tr, values) {
  for (const v of values) {
    const td = document.createElement('td');
    td.textContent = v;
    tr.appendChild(td);
  }
}
function sigLabel(sig) {
  return sig ? sig.name : '?';
}
function short(qname) {
  return qname.split('/').slice(1).join('.');
}
function csvField(s) {
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function fmt(v) {
  if (v == null || !isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : (+v.toPrecision(6)).toString();
}
