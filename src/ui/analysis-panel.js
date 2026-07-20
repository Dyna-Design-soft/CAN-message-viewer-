// Analysis panel: signal tree (checkboxes) -> value table + graph stack,
// with a scrubbing playback clock and synchronized cursors.

import { GraphManager, valueAt } from '../graph/graph-manager.js';
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
          const cb = document.createElement('input');
          cb.type = 'checkbox';
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
  document.getElementById('graph-add-xy').addEventListener('click', () => {
    graphs.addXY();
    requestAnimationFrame(() => graphs.resizeAll());
  });
  document.getElementById('cursor-add').addEventListener('click', () => {
    graphs.cursors.add(playback.time || (playback.tMin + playback.range / 2));
  });
  document.getElementById('cursor-clear').addEventListener('click', () => graphs.cursors.clear());
  document.getElementById('graph-reset').addEventListener('click', () => graphs.resetZoom());

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

  // ---- events ----
  app.bus.on('dbc:changed', () => {
    renderTree();
    renderTable();
  });
  app.bus.on('log:loaded', ({ stats }) => {
    playback.setRange(stats.tFirst, stats.tLast);
    playback.setTime(stats.tFirst);
    graphs.rebuild();
    renderTable();
  });
  app.bus.on('log:cleared', () => {
    playback.setRange(0, 0);
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
function fmt(v) {
  if (v == null || !isFinite(v)) return '—';
  return Number.isInteger(v) ? String(v) : (+v.toPrecision(6)).toString();
}
