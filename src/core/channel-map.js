// Channel -> cluster (DBC file) assignment used when decoding frames.
//
// A frame decodes against the cluster assigned to its channel. Channels with
// no explicit assignment fall back to searching every loaded cluster in load
// order (first match wins) — fine for single-DBC setups, and the conflicts
// are namespaced away because results are keyed by qualified signal name.

import { EXT_BIT } from './frame-store.js';

export class ChannelMap {
  constructor(dbcRegistry) {
    this.dbc = dbcRegistry;
    this.assignments = new Map(); // ch -> cluster name
  }

  assign(ch, clusterName) {
    if (clusterName == null) this.assignments.delete(ch);
    else this.assignments.set(ch, clusterName);
  }

  clustersFor(ch) {
    const name = this.assignments.get(ch);
    if (name) {
      const c = this.dbc.clusterByName(name);
      return c ? [c] : [];
    }
    return this.dbc.clusters;
  }

  /** Find the Message definition for a frame, honoring the assignment. */
  messageFor(ch, id, ext) {
    const key = ((id >>> 0) | (ext ? EXT_BIT : 0)) >>> 0;
    for (const cluster of this.clustersFor(ch)) {
      const m = cluster.messages.get(key);
      if (m) return m;
    }
    return null;
  }
}
