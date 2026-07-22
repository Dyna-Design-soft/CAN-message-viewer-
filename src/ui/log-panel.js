// Log File panel: open/drop a log file, show summary statistics.

import { loadLogFileInWorker } from '../io/format-registry.js';
// Register all input formats (side-effect imports).
import '../io/asc-reader.js';
import '../io/blf-reader.js';
import '../io/csv-writer.js';
import '../io/tdms-reader.js';
import '../io/mdf-reader.js';
import { formatId } from '../util/hex.js';
import { formatDuration, formatEpoch } from '../util/time.js';
import { extractRange, extractSnapshot, serializeFrames } from '../io/frame-export.js';
import { downloadBlob } from '../live/recorder.js';

export function initLogPanel(app) {
  const drop = document.getElementById('log-drop');
  const input = document.getElementById('log-file-input');
  const summary = document.getElementById('log-summary');

  document.getElementById('log-browse').addEventListener('click', () => input.click());
  document.getElementById('log-open-another').addEventListener('click', () => input.click());
  document.getElementById('log-clear').addEventListener('click', clear);

  input.addEventListener('change', () => {
    if (input.files.length) openFile(input.files[0]);
    input.value = '';
  });

  for (const evt of ['dragover', 'dragenter']) {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.add('dragover');
    });
  }
  for (const evt of ['dragleave', 'drop']) {
    drop.addEventListener(evt, (e) => {
      e.preventDefault();
      drop.classList.remove('dragover');
    });
  }
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) openFile(file);
  });

  async function openFile(file) {
    setBusy(`Loading ${file.name}…`);
    try {
      const { store, format } = await loadLogFileInWorker(file);
      adopt(store, file.name, format);
    } catch (err) {
      console.error(err);
      setBusy(null);
      alert(`Could not load "${file.name}":\n${err.message}`);
    }
  }

  // Adopt an already-built FrameStore (used by openFile and by demo auto-load).
  function adopt(store, fileName, format) {
    const stats = store.computeStats();
    app.logStore = store;
    app.logStats = stats;
    app.logFileName = fileName;
    app.logFormat = format;
    render(fileName, format, stats);
    app.bus.emit('log:loaded', { store, stats, fileName, format });
  }
  app.adoptLog = adopt;

  function clear() {
    app.logStore.clear();
    app.logStats = null;
    app.logFileName = null;
    summary.hidden = true;
    drop.hidden = false;
    app.bus.emit('log:cleared', {});
  }

  function setBusy(msg) {
    const inner = drop.querySelector('.drop-inner p strong');
    if (inner) inner.textContent = msg ?? 'Open a CAN log file';
  }

  function render(fileName, format, stats) {
    drop.hidden = true;
    summary.hidden = false;
    setBusy(null);
    document.getElementById('log-file-name').textContent = `${fileName} — ${format}`;

    const cards = [
      ['Duration', formatDuration(stats.duration)],
      ['Start time', formatEpoch(app.logStore.t0Epoch)],
      ['Frames', stats.frameCount.toLocaleString()],
      ['Frame rate', stats.frameRate ? stats.frameRate.toFixed(1) + ' fps' : '—'],
      ['Unique IDs', String(stats.uniqueIds)],
      ['Channels', stats.channels.join(', ') || '—'],
      ['CAN FD frames', stats.fdFrames.toLocaleString()],
      ['Error frames', stats.errorFrames.toLocaleString(), stats.errorFrames > 0 ? 'err' : ''],
    ];
    const cardBox = document.getElementById('log-stats-cards');
    cardBox.textContent = '';
    for (const [label, value, cls] of cards) {
      const div = document.createElement('div');
      div.className = 'stat-card' + (cls ? ' ' + cls : '');
      div.innerHTML = `<div class="stat-label"></div><div class="stat-value"></div>`;
      div.querySelector('.stat-label').textContent = label;
      div.querySelector('.stat-value').textContent = value;
      cardBox.appendChild(div);
    }

    const tbody = document.querySelector('#log-perid-table tbody');
    tbody.textContent = '';
    for (const row of stats.perId) {
      const tr = document.createElement('tr');
      const msg = row.err ? null : app.channelMap.messageFor(row.ch, row.id, row.ext);
      const cells = [
        String(row.ch),
        row.err ? '—' : formatId(row.id, row.ext),
        row.err ? 'Error' : row.ext ? 'Ext' : 'Std',
        msg?.name ?? '',
        row.count.toLocaleString(),
        row.cycleMs != null ? row.cycleMs.toFixed(1) + ' ms' : '—',
        row.rate != null ? row.rate.toFixed(1) + '/s' : '—',
      ];
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      if (row.err) tr.style.color = 'var(--err)';
      tbody.appendChild(tr);
    }
  }

  // Re-render the name column when DBCs change.
  app.bus.on('dbc:changed', () => {
    if (app.logStats && app.logFileName) {
      render(app.logFileName, app.logFormat, app.logStats);
    }
  });

  initExport(app);
}

// ---- extract & export a subset of the loaded log ----
function initExport(app) {
  const modeGroup = document.getElementById('extract-mode');
  const rangeFields = document.getElementById('extract-range-fields');
  const snapFields = document.getElementById('extract-snapshot-fields');
  const fromEl = document.getElementById('extract-from');
  const toEl = document.getElementById('extract-to');
  const atEl = document.getElementById('extract-at');
  const formatEl = document.getElementById('extract-format');
  const exportBtn = document.getElementById('extract-export');
  const statusEl = document.getElementById('extract-status');
  if (!modeGroup || !exportBtn) return;

  let mode = 'range';
  for (const b of modeGroup.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      mode = b.dataset.mode;
      for (const x of modeGroup.querySelectorAll('button')) x.classList.toggle('is-active', x === b);
      rangeFields.hidden = mode !== 'range';
      snapFields.hidden = mode !== 'snapshot';
    });
  }

  // Default the time fields to the loaded log's extent.
  app.bus.on('log:loaded', ({ stats }) => {
    const a = round3(stats.tFirst), b = round3(stats.tLast);
    fromEl.value = a; toEl.value = b; atEl.value = b;
    statusEl.textContent = '';
  });

  exportBtn.addEventListener('click', async () => {
    if (!app.logStore || app.logStore.isEmpty) { statusEl.textContent = 'No log loaded.'; return; }
    const format = formatEl.value;
    let subset, label;
    if (mode === 'snapshot') {
      const t = Number(atEl.value);
      if (Number.isNaN(t)) { statusEl.textContent = 'Enter a valid time.'; return; }
      subset = extractSnapshot(app.logStore, t);
      label = `snapshot @ ${round3(t)}s`;
    } else {
      const from = Number(fromEl.value), to = Number(toEl.value);
      if (Number.isNaN(from) || Number.isNaN(to)) { statusEl.textContent = 'Enter valid From/To times.'; return; }
      subset = extractRange(app.logStore, from, to);
      label = `${round3(Math.min(from, to))}–${round3(Math.max(from, to))}s`;
    }
    if (subset.isEmpty) { statusEl.textContent = 'No frames in that selection.'; return; }
    statusEl.textContent = `Exporting ${subset.count.toLocaleString()} frame(s)…`;
    try {
      const { data, mime, ext } = await serializeFrames(subset, format);
      const base = (app.logFileName || 'export').replace(/\.[^.]+$/, '');
      const tag = mode === 'snapshot' ? 'snapshot' : 'range';
      downloadBlob(new Blob([data], { type: mime }), `${base}_${tag}.${ext}`);
      statusEl.textContent = `Exported ${subset.count.toLocaleString()} frame(s) (${label}) as ${ext.toUpperCase()}.`;
    } catch (err) {
      console.error(err);
      statusEl.textContent = 'Export failed: ' + err.message;
    }
  });
}

function round3(v) {
  return Math.round(v * 1000) / 1000;
}
