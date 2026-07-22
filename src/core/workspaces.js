// Workspaces: named, switchable bundles of the working context (DBCs + signal
// selection + track layout + graph mode + tab + prefs) — everything a session
// persists, EXCEPT the CAN log data. Stored as a collection in localStorage,
// and each workspace can be exported to / imported from a JSON file.
//
// The per-workspace `state` payload is exactly the snapshot produced by
// persistence.js, so switching a workspace is "clear the app, then restore".

const KEY = 'canviewer:workspaces:v1';
const LEGACY_KEY = 'canviewer:state:v1'; // pre-workspaces single-session state
const EXPORT_KIND = 'can-message-viewer/workspace';
const EXPORT_VERSION = 1;

export function genId() {
  return 'ws_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function loadCollection() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const col = JSON.parse(raw);
      if (col && Array.isArray(col.list)) return col;
    }
  } catch {
    /* corrupt — fall through to a fresh collection */
  }
  return null;
}

export function saveCollection(col) {
  try {
    localStorage.setItem(KEY, JSON.stringify(col));
    return true;
  } catch {
    return false; // quota exceeded or storage disabled
  }
}

/** One-time migration: fold a pre-workspaces saved session into a workspace. */
export function migrateLegacy() {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    localStorage.removeItem(LEGACY_KEY);
    return { id: genId(), name: 'Workspace 1', state, updatedAt: Date.now() };
  } catch {
    return null;
  }
}

/** Serializable object for exporting a workspace to a file. */
export function toExport(ws) {
  return { kind: EXPORT_KIND, v: EXPORT_VERSION, name: ws.name, state: ws.state, exportedAt: Date.now() };
}

/**
 * Validate an imported object and turn it into a workspace record.
 * Accepts our own export shape, and tolerates a bare state object.
 * @returns {{id,name,state,updatedAt}} @throws if it isn't a usable workspace
 */
export function fromImport(obj, fallbackName = 'Imported workspace') {
  if (!obj || typeof obj !== 'object') throw new Error('Not a workspace file.');
  let state = null;
  let name = fallbackName;
  if (obj.kind === EXPORT_KIND || (obj.state && typeof obj.state === 'object')) {
    state = obj.state;
    if (obj.name) name = obj.name;
  } else if (Array.isArray(obj.dbcs) || Array.isArray(obj.selection)) {
    state = obj; // a bare snapshot
  } else {
    throw new Error('This file is not a CAN Message Viewer workspace.');
  }
  return { id: genId(), name, state, updatedAt: Date.now() };
}
