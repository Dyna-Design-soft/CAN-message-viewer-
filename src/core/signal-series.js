// Per-signal decoded time series with caching.
//
// A series is `{ t: Float64Array, v: Float64Array, signal }` — exactly the
// column layout the graphs consume. Series are computed lazily on first
// request and cached against the store's generation counter, so scrubbing and
// re-plotting never re-decode. Multiplexed signals yield sparse series (only
// frames whose selector matched).

import { EXT_BIT, FrameFlags } from './frame-store.js';
import { extractRaw } from './decoder.js';

export function extractSeries(store, signal, channelMap) {
  const message = signal.message;
  const cluster = message.cluster;
  const key = ((message.id >>> 0) | (message.extended ? EXT_BIT : 0)) >>> 0;

  // Collect matching frame indices from every channel whose assignment
  // resolves to this signal's cluster.
  const runs = [];
  let total = 0;
  for (const [chKey, indices] of store.index()) {
    const ch = Math.floor(chKey / 0x100000000);
    const idWithExt = chKey % 0x100000000;
    if (idWithExt !== key) continue;
    const clusters = channelMap.clustersFor(ch);
    if (!clusters.includes(cluster)) continue;
    if (channelMap.messageFor(ch, message.id, message.extended) !== message) continue;
    runs.push(indices);
    total += indices.length;
  }

  const t = new Float64Array(total);
  const v = new Float64Array(total);
  let n = 0;
  const mux = signal.muxRole === 'multiplexed' ? message.multiplexor : null;
  for (const indices of runs) {
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (store.flags[i] & FrameFlags.ERR) continue;
      const data = store.data(i);
      if (mux) {
        const sel = extractRaw(data, mux);
        if (sel === null || sel !== signal.muxValue) continue;
      }
      const raw = extractRaw(data, signal);
      if (raw === null) continue;
      t[n] = store.t[i];
      v[n] = raw * signal.factor + signal.offset;
      n++;
    }
  }

  let tt = t.subarray(0, n);
  let vv = v.subarray(0, n);
  // Multiple channels can interleave out of order; sort if needed.
  let sorted = true;
  for (let i = 1; i < n; i++) {
    if (tt[i] < tt[i - 1]) {
      sorted = false;
      break;
    }
  }
  if (!sorted) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => tt[a] - tt[b]);
    const t2 = new Float64Array(n);
    const v2 = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      t2[i] = tt[order[i]];
      v2[i] = vv[order[i]];
    }
    tt = t2;
    vv = v2;
  }
  return { t: tt, v: vv, signal };
}

export class SeriesCache {
  constructor(app) {
    this.app = app;
    this.#cache = new Map(); // `${storeTag}:${qname}` -> {generation, series}
    app.bus.on('dbc:changed', () => this.clear());
    app.bus.on('channelmap:changed', () => this.clear());
  }

  #cache;

  clear() {
    this.#cache.clear();
  }

  /**
   * Decoded series for a qualified signal name from the given store
   * ('log' | 'live'). Returns null if the signal is unknown.
   */
  get(qname, storeTag = 'log') {
    const store = storeTag === 'live' ? this.app.liveStore : this.app.logStore;
    const cacheKey = `${storeTag}:${qname}`;
    const hit = this.#cache.get(cacheKey);
    if (hit && hit.generation === store.generation) return hit.series;
    const signal = this.app.dbc.signalByQualifiedName(qname);
    if (!signal) return null;
    const series = extractSeries(store, signal, this.app.channelMap);
    this.#cache.set(cacheKey, { generation: store.generation, series });
    return series;
  }
}
