// Session persistence: keep the user's working context across reloads / PWA
// relaunches in localStorage. We persist the loaded DBC source text (so the
// databases re-parse on boot), the checked signal selection, the split-track
// layout, the graph mode, the active tab, and a couple of UI preferences.
//
// Log files themselves are NOT persisted — they can be hundreds of MB, far past
// the localStorage quota. On return the DBC and selection come back; the user
// re-opens the log (its frames stream in and the restored signals plot again).

import { parseDbc } from './dbc-parser.js';

const KEY = 'canviewer:state:v1';
const MAX_BYTES = 4_500_000; // stay under the ~5 MB localStorage quota

export function loadPersisted() {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function savePersisted(state) {
  try {
    const json = JSON.stringify(state);
    if (json.length > MAX_BYTES) {
      // Too large (usually an oversized DBC): drop the DBC source and keep the
      // lightweight UI state so at least tab/selection/layout survive.
      const trimmed = { ...state, dbcs: [] };
      localStorage.setItem(KEY, JSON.stringify(trimmed));
      return;
    }
    localStorage.setItem(KEY, json);
  } catch {
    // Quota exceeded or storage disabled — persistence is best-effort.
  }
}

export function clearPersisted() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Build a snapshot of the current working state from the app. */
export function snapshot(app) {
  const graphs = app.analysisGraphs;
  const activeTab = document.querySelector('.panel.active')?.id || 'panel-dbc';
  return {
    v: 1,
    tab: activeTab,
    dbcs: app.dbc.clusters
      .filter((c) => c.source) // demo/programmatic clusters without source are skipped
      .map((c) => ({ fileName: c.fileName, source: c.source })),
    selection: [...app.selection],
    tracks: graphs ? graphs.splitTracks.map((t) => [...t]) : [],
    mode: graphs ? graphs.primaryMode : 'split',
    prefs: {
      tableInterval: document.getElementById('table-interval')?.value,
      playbackSpeed: document.getElementById('pb-speed')?.value,
    },
  };
}

/**
 * Restore persisted state into a freshly-initialised app. Returns true if any
 * DBC was restored (so the caller can skip the first-run demo).
 */
export function restore(app, state) {
  if (!state) return false;
  let restoredDbc = false;
  for (const d of state.dbcs || []) {
    try {
      const cluster = parseDbc(d.source, d.fileName);
      cluster.source = d.source;
      app.dbc.add(cluster);
      restoredDbc = true;
    } catch {
      /* skip a DBC that no longer parses */
    }
  }
  if (restoredDbc) app.bus.emit('dbc:changed', { clusters: app.dbc.clusters });

  // Restore UI preferences before selection so the value table uses them.
  const prefs = state.prefs || {};
  const intervalEl = document.getElementById('table-interval');
  if (intervalEl && prefs.tableInterval != null) {
    intervalEl.value = prefs.tableInterval;
    intervalEl.dispatchEvent(new Event('change'));
  }
  const speedEl = document.getElementById('pb-speed');
  if (speedEl && prefs.playbackSpeed != null) {
    speedEl.value = prefs.playbackSpeed;
    speedEl.dispatchEvent(new Event('change'));
  }

  const graphs = app.analysisGraphs;
  if (graphs) {
    if (state.mode) {
      graphs.primaryMode = state.mode;
      app.bus.emit('graph:mode', { mode: state.mode });
    }
    // Restore the track layout, keeping only signals that still exist.
    if (Array.isArray(state.tracks)) {
      graphs.splitTracks = state.tracks
        .map((t) => t.filter((q) => app.dbc.signalByQualifiedName(q)))
        .filter((t) => t.length);
    }
  }

  if (Array.isArray(state.selection) && state.selection.length) {
    const valid = state.selection.filter((q) => app.dbc.signalByQualifiedName(q));
    if (valid.length && app.applySelection) app.applySelection(valid);
  }

  if (state.tab && document.getElementById(state.tab) && app.selectPanel) {
    app.selectPanel(state.tab);
  }
  return restoredDbc;
}

/**
 * Wire auto-save: snapshot on any state-changing event, debounced so rapid
 * changes (dragging tracks, ticking signals) collapse into one write.
 */
export function initPersistence(app) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => savePersisted(snapshot(app)), 400);
  };
  for (const evt of [
    'dbc:changed',
    'selection:changed',
    'graph:mode',
    'graph:layout',
    'tab:changed',
  ]) {
    app.bus.on(evt, save);
  }
  document.getElementById('table-interval')?.addEventListener('change', save);
  document.getElementById('pb-speed')?.addEventListener('change', save);
  // Save on the way out too (covers changes that didn't emit an event).
  window.addEventListener('pagehide', () => savePersisted(snapshot(app)));
}
