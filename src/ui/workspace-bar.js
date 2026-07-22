// Workspace bar: create / switch / rename / delete / import / export named
// workspaces. A workspace bundles the DBCs + analysis setup (everything the
// session persists) but never the CAN log data. It also owns auto-save: any
// state change is written back into the current workspace.

import { snapshot, restore } from '../core/persistence.js';
import {
  loadCollection, saveCollection, genId, migrateLegacy, toExport, fromImport,
} from '../core/workspaces.js';

/**
 * Initialise the workspace bar and restore the current workspace.
 * @returns {{restoredDbc:boolean}} whether a DBC was restored (so the caller
 *   can decide whether to seed the first-run demo instead).
 */
export function initWorkspaceBar(app) {
  const selectEl = document.getElementById('ws-select');
  const importInput = document.getElementById('ws-import-input');
  if (!selectEl) return { restoredDbc: false }; // markup not present (e.g. old cache)

  // ---- load or seed the collection ----
  let col = loadCollection();
  if (!col) {
    const legacy = migrateLegacy();
    col = { current: null, list: legacy ? [legacy] : [] };
    if (legacy) col.current = legacy.id;
  }
  if (col.list.length === 0) {
    const ws = { id: genId(), name: 'Workspace 1', state: null, updatedAt: Date.now() };
    col.list.push(ws);
    col.current = ws.id;
  }
  if (!col.list.some((w) => w.id === col.current)) col.current = col.list[0].id;

  const current = () => col.list.find((w) => w.id === col.current) || col.list[0];

  // ---- restore the current workspace on boot ----
  let restoredDbc = false;
  const boot = current();
  if (boot.state) {
    try {
      restoredDbc = restore(app, boot.state);
    } catch (err) {
      console.warn('Workspace restore failed; starting this workspace empty.', err);
      boot.state = null;
    }
  }

  // ---- auto-save the current workspace (debounced) ----
  let timer = null;
  const persist = () => {
    const c = current();
    if (!c) return;
    c.state = snapshot(app);
    c.updatedAt = Date.now();
    if (!saveCollection(col)) {
      // Over quota — most likely a large DBC. Warn once via the title attr.
      selectEl.title = 'Storage full: this workspace may not be fully saved.';
    }
  };
  const scheduleSave = () => {
    clearTimeout(timer);
    timer = setTimeout(persist, 400);
  };
  for (const evt of ['dbc:changed', 'selection:changed', 'graph:mode', 'graph:layout', 'tab:changed']) {
    app.bus.on(evt, scheduleSave);
  }
  document.getElementById('table-interval')?.addEventListener('change', scheduleSave);
  document.getElementById('pb-speed')?.addEventListener('change', scheduleSave);
  window.addEventListener('pagehide', persist);

  // ---- clear the app before loading another workspace ----
  function clearApp() {
    app.dbc.clearAll();
    app.bus.emit('dbc:changed', { clusters: app.dbc.clusters });
    app.selection.clear();
    if (app.analysisGraphs) app.analysisGraphs.splitTracks = [];
    app.applySelection?.([]); // re-render tree/table/graphs empty
  }

  // ---- switch to a workspace by id ----
  function switchTo(id, { saveCurrent = true } = {}) {
    if (id === col.current) return;
    if (saveCurrent) persistNow();
    col.current = id;
    clearApp();
    const ws = current();
    if (ws.state) {
      try { restore(app, ws.state); } catch (err) { console.warn('Restore failed.', err); }
    }
    saveCollection(col);
    render();
  }

  function persistNow() {
    clearTimeout(timer);
    persist();
  }

  function uniqueName(base) {
    const names = new Set(col.list.map((w) => w.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base} (${n})`)) n++;
    return `${base} (${n})`;
  }

  function nextDefaultName() {
    return uniqueName(`Workspace ${col.list.length + 1}`);
  }

  // ---- actions ----
  function createWorkspace() {
    const name = (prompt('New workspace name:', nextDefaultName()) || '').trim();
    if (name === '') return;
    persistNow(); // save the one we're leaving
    const ws = { id: genId(), name: uniqueName(name), state: null, updatedAt: Date.now() };
    col.list.push(ws);
    col.current = ws.id;
    clearApp(); // fresh, empty workspace ready for a new DBC import
    saveCollection(col);
    render();
    app.selectPanel?.('panel-dbc'); // land on DBC so the user can import
  }

  function renameWorkspace() {
    const c = current();
    const name = (prompt('Rename workspace:', c.name) || '').trim();
    if (name === '' || name === c.name) return;
    c.name = uniqueName(name);
    saveCollection(col);
    render();
  }

  function deleteWorkspace() {
    if (col.list.length <= 1) { alert('At least one workspace is required.'); return; }
    const c = current();
    if (!confirm(`Delete workspace "${c.name}"? Its DBC and analysis setup will be removed (log data is unaffected).`)) return;
    col.list = col.list.filter((w) => w.id !== c.id);
    col.current = col.list[0].id;
    clearApp();
    const ws = current();
    if (ws.state) { try { restore(app, ws.state); } catch { /* ignore */ } }
    saveCollection(col);
    render();
  }

  function exportWorkspace() {
    persistNow();
    const c = current();
    const json = JSON.stringify(toExport(c), null, 2);
    const safe = c.name.replace(/[^\w.-]+/g, '_') || 'workspace';
    download(`${safe}.canws.json`, json);
  }

  async function importWorkspace(file) {
    try {
      const obj = JSON.parse(await file.text());
      const ws = fromImport(obj, file.name.replace(/\.(canws\.)?json$/i, ''));
      ws.name = uniqueName(ws.name);
      persistNow();
      col.list.push(ws);
      col.current = ws.id;
      clearApp();
      if (ws.state) { try { restore(app, ws.state); } catch { /* ignore */ } }
      saveCollection(col);
      render();
      app.selectPanel?.('panel-dbc');
    } catch (err) {
      alert('Could not import workspace: ' + err.message);
    }
  }

  // ---- render the selector ----
  function render() {
    selectEl.textContent = '';
    for (const w of col.list) {
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = w.name;
      if (w.id === col.current) o.selected = true;
      selectEl.appendChild(o);
    }
  }

  // ---- wire controls ----
  selectEl.addEventListener('change', () => switchTo(selectEl.value));
  document.getElementById('ws-new')?.addEventListener('click', createWorkspace);
  document.getElementById('ws-rename')?.addEventListener('click', renameWorkspace);
  document.getElementById('ws-delete')?.addEventListener('click', deleteWorkspace);
  document.getElementById('ws-export')?.addEventListener('click', exportWorkspace);
  document.getElementById('ws-import')?.addEventListener('click', () => importInput?.click());
  importInput?.addEventListener('change', () => {
    if (importInput.files.length) importWorkspace(importInput.files[0]);
    importInput.value = '';
  });

  render();
  return { restoredDbc };
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
