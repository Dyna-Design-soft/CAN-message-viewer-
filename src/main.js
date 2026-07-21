// Application bootstrap: shared state, tab switching, panel wiring.

import { bus } from './core/events.js';
import { FrameStore } from './core/frame-store.js';
import { DbcRegistry } from './core/dbc-model.js';
import { ChannelMap } from './core/channel-map.js';
import { SeriesCache } from './core/signal-series.js';
import { initDbcModal } from './ui/dbc-modal.js';
import { initLogPanel } from './ui/log-panel.js';
import { initAnalysisPanel } from './ui/analysis-panel.js';
import { initLivePanel } from './ui/live-panel.js';
import { loadDemo } from './demo.js';
import { initPersistence, loadPersisted, restore } from './core/persistence.js';

const app = {
  bus,
  dbc: new DbcRegistry(),
  channelMap: null, // set below (needs dbc)
  logStore: new FrameStore(), // offline: currently loaded file
  liveStore: new FrameStore(), // online: ring-buffered live capture
  logStats: null,
  logFileName: null,
  seriesCache: null, // set below
  selection: new Set(), // checked signal qualified names
};
app.channelMap = new ChannelMap(app.dbc);
app.seriesCache = new SeriesCache(app);

// ---- tab switching (top tab bar + mobile bottom nav stay in sync) ----
const tabs = document.querySelectorAll('.tab-bar .tab, .bottom-nav .tab');
function selectPanel(panelId) {
  for (const t of tabs) t.classList.toggle('active', t.dataset.panel === panelId);
  for (const p of document.querySelectorAll('.panel')) {
    p.classList.toggle('active', p.id === panelId);
  }
  bus.emit('tab:changed', { panel: panelId });
}
for (const tab of tabs) {
  tab.addEventListener('click', () => selectPanel(tab.dataset.panel));
}
app.selectPanel = selectPanel;

// ---- status bar ----
bus.on('dbc:changed', () => {
  const n = app.dbc.clusters.length;
  document.getElementById('sb-dbc').textContent =
    n === 0 ? 'DBC: none' : `DBC: ${app.dbc.clusters.map((c) => c.name).join(', ')}`;
  const badge = document.getElementById('dbc-count');
  badge.hidden = n === 0;
  badge.textContent = n;
});
bus.on('log:loaded', ({ fileName, stats }) => {
  document.getElementById('sb-log').textContent =
    `Log: ${fileName} (${stats.frameCount.toLocaleString()} frames)`;
});
bus.on('log:cleared', () => {
  document.getElementById('sb-log').textContent = 'Log: none';
});
bus.on('live:state', ({ state }) => {
  document.getElementById('sb-live').textContent = `Live: ${state}`;
});

initDbcModal(app);
initLogPanel(app);
initAnalysisPanel(app);
initLivePanel(app);

window.__canApp = app; // debugging hook

// Register the service worker so the viewer is installable (Chrome "Install app")
// and works offline. Skipped for file:// (single-file build) where it can't run.
if (location.protocol !== 'file:' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// Restore the previous session (DBCs, selection, track layout, tab) if any.
// Log files aren't persisted, so the user re-opens the log; everything else
// comes back. Only when there's nothing saved do we seed the first-run demo.
const restored = restore(app, loadPersisted());
if (!restored && app.dbc.clusters.length === 0 && app.logStore.isEmpty) {
  loadDemo(app);
}
initPersistence(app);
