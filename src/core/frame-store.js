// Columnar CAN frame storage.
//
// Struct-of-arrays with geometric growth; shared by every file parser and the
// live source. Per-frame JS objects would thrash the GC at multi-million frame
// counts, so each field lives in its own typed array and payload bytes go into
// a single shared pool.
//
// Flag bits (FrameFlags):
//   FD   frame is CAN FD
//   BRS  bit-rate switch (FD only)
//   ESI  error state indicator (FD only)
//   RTR  remote frame (classic only)
//   ERR  error frame (id/data usually meaningless)
//   TX   direction: set = transmitted, clear = received

export const FrameFlags = Object.freeze({
  FD: 1,
  BRS: 2,
  ESI: 4,
  RTR: 8,
  ERR: 16,
  TX: 32,
});

// Bit 31 of the id column marks an extended (29-bit) identifier, matching the
// BLF on-disk convention.
export const EXT_BIT = 0x80000000;

const INITIAL_CAPACITY = 4096;

// CAN FD DLC code -> payload byte length (codes 0..8 map to themselves).
const FD_DLC_TO_LEN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];

export function dlcToLength(dlc, fd) {
  if (dlc <= 8) return dlc;
  return fd ? FD_DLC_TO_LEN[Math.min(dlc, 15)] : 8;
}

export function lengthToDlc(len) {
  if (len <= 8) return len;
  for (let dlc = 9; dlc <= 15; dlc++) if (FD_DLC_TO_LEN[dlc] >= len) return dlc;
  return 15;
}

export class FrameStore {
  constructor() {
    this.clear();
  }

  clear() {
    this.count = 0;
    this.t = new Float64Array(INITIAL_CAPACITY);
    this.id = new Uint32Array(INITIAL_CAPACITY); // bit 31 = extended flag
    this.flags = new Uint8Array(INITIAL_CAPACITY);
    this.len = new Uint8Array(INITIAL_CAPACITY); // real byte length 0..64
    this.ch = new Uint8Array(INITIAL_CAPACITY);
    this.dataOfs = new Uint32Array(INITIAL_CAPACITY);
    this.dataPool = new Uint8Array(INITIAL_CAPACITY * 8);
    this.dataUsed = 0;
    // Metadata set by loaders / the live session.
    this.t0Epoch = null; // Unix seconds corresponding to t = 0, if known
    this.#index = null;
    this.generation = 0; // bumped on every mutation batch; caches key off this
  }

  #index; // Map<"ch:idWithExtBit", number[] | Uint32Array>

  get isEmpty() {
    return this.count === 0;
  }

  #grow(minCount) {
    let cap = this.t.length;
    while (cap < minCount) cap *= 2;
    if (cap === this.t.length) return;
    const grow = (old, Ctor) => {
      const a = new Ctor(cap);
      a.set(old);
      return a;
    };
    this.t = grow(this.t, Float64Array);
    this.id = grow(this.id, Uint32Array);
    this.flags = grow(this.flags, Uint8Array);
    this.len = grow(this.len, Uint8Array);
    this.ch = grow(this.ch, Uint8Array);
    this.dataOfs = grow(this.dataOfs, Uint32Array);
  }

  #growPool(minBytes) {
    let cap = this.dataPool.length;
    while (cap < minBytes) cap *= 2;
    if (cap === this.dataPool.length) return;
    const p = new Uint8Array(cap);
    p.set(this.dataPool);
    this.dataPool = p;
  }

  /**
   * Append one frame.
   * @param {number} t seconds (relative to log/session start)
   * @param {number} id raw identifier (11 or 29 bit), WITHOUT ext bit
   * @param {boolean} ext extended identifier
   * @param {number} ch channel number
   * @param {number} flags FrameFlags bitmask
   * @param {Uint8Array|null} data payload (copied), length 0..64
   * @returns {number} index of the appended frame
   */
  add(t, id, ext, ch, flags, data) {
    const i = this.count;
    this.#grow(i + 1);
    const n = data ? data.length : 0;
    this.#growPool(this.dataUsed + n);
    this.t[i] = t;
    this.id[i] = (id >>> 0) | (ext ? EXT_BIT : 0);
    this.flags[i] = flags;
    this.len[i] = n;
    this.ch[i] = ch;
    this.dataOfs[i] = this.dataUsed;
    if (n) {
      this.dataPool.set(data.subarray(0, n), this.dataUsed);
      this.dataUsed += n;
    }
    this.count = i + 1;
    this.#index = null;
    this.generation++;
    return i;
  }

  /** Payload bytes of frame i as a subarray view (do not mutate). */
  data(i) {
    const o = this.dataOfs[i];
    return this.dataPool.subarray(o, o + this.len[i]);
  }

  rawId(i) {
    return this.id[i] & ~EXT_BIT;
  }

  isExt(i) {
    return (this.id[i] & EXT_BIT) !== 0;
  }

  /** Frame i as a plain object (for display code, not hot paths). */
  frame(i) {
    const f = this.flags[i];
    return {
      index: i,
      t: this.t[i],
      id: this.rawId(i),
      ext: this.isExt(i),
      ch: this.ch[i],
      len: this.len[i],
      fd: !!(f & FrameFlags.FD),
      brs: !!(f & FrameFlags.BRS),
      esi: !!(f & FrameFlags.ESI),
      rtr: !!(f & FrameFlags.RTR),
      err: !!(f & FrameFlags.ERR),
      tx: !!(f & FrameFlags.TX),
      data: this.data(i),
    };
  }

  /** Map "ch:id" (id incl. ext bit) -> Uint32Array of frame indices, built lazily. */
  index() {
    if (this.#index) return this.#index;
    const counts = new Map();
    for (let i = 0; i < this.count; i++) {
      const key = this.ch[i] * 0x100000000 + this.id[i];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const idx = new Map();
    const fill = new Map();
    for (const [key, n] of counts) {
      idx.set(key, new Uint32Array(n));
      fill.set(key, 0);
    }
    for (let i = 0; i < this.count; i++) {
      const key = this.ch[i] * 0x100000000 + this.id[i];
      const arr = idx.get(key);
      const at = fill.get(key);
      arr[at] = i;
      fill.set(key, at + 1);
    }
    this.#index = idx;
    return idx;
  }

  static indexKey(ch, idWithExt) {
    return ch * 0x100000000 + (idWithExt >>> 0);
  }

  /**
   * Drop the oldest `n` frames (live-mode retention). Compacts all columns and
   * the data pool in place. O(count), so callers should trim in large chunks.
   */
  dropOldest(n) {
    if (n <= 0) return;
    if (n >= this.count) {
      const t0 = this.t0Epoch;
      this.clear();
      this.t0Epoch = t0;
      return;
    }
    const remain = this.count - n;
    this.t.copyWithin(0, n, this.count);
    this.id.copyWithin(0, n, this.count);
    this.flags.copyWithin(0, n, this.count);
    this.len.copyWithin(0, n, this.count);
    this.ch.copyWithin(0, n, this.count);
    // Rebuild data pool compactly.
    const firstOfs = this.dataOfs[n];
    const bytes = this.dataUsed - firstOfs;
    this.dataPool.copyWithin(0, firstOfs, this.dataUsed);
    for (let i = 0; i < remain; i++) this.dataOfs[i] = this.dataOfs[i + n] - firstOfs;
    this.dataUsed = bytes;
    this.count = remain;
    this.#index = null;
    this.generation++;
  }

  /**
   * Serialize to transferable columnar buffers (trimmed to `count`), for
   * moving a parsed store out of a Web Worker with zero re-parsing.
   */
  serialize() {
    return {
      count: this.count,
      t0Epoch: this.t0Epoch,
      t: this.t.slice(0, this.count),
      id: this.id.slice(0, this.count),
      flags: this.flags.slice(0, this.count),
      len: this.len.slice(0, this.count),
      ch: this.ch.slice(0, this.count),
      dataOfs: this.dataOfs.slice(0, this.count),
      dataPool: this.dataPool.slice(0, this.dataUsed),
      dataUsed: this.dataUsed,
    };
  }

  /** ArrayBuffers to pass in a worker postMessage transfer list. */
  static transferList(s) {
    return [s.t.buffer, s.id.buffer, s.flags.buffer, s.len.buffer, s.ch.buffer, s.dataOfs.buffer, s.dataPool.buffer];
  }

  static fromSerialized(s) {
    const store = new FrameStore();
    store.count = s.count;
    store.t0Epoch = s.t0Epoch;
    store.t = s.t;
    store.id = s.id;
    store.flags = s.flags;
    store.len = s.len;
    store.ch = s.ch;
    store.dataOfs = s.dataOfs;
    store.dataPool = s.dataPool;
    store.dataUsed = s.dataUsed;
    store.generation = 1;
    return store;
  }

  /** Summary statistics over the whole store (single pass + index reuse). */
  computeStats() {
    const n = this.count;
    if (n === 0) {
      return {
        frameCount: 0, duration: 0, tFirst: 0, tLast: 0, frameRate: 0,
        uniqueIds: 0, errorFrames: 0, fdFrames: 0, channels: [], perId: [],
      };
    }
    let tFirst = Infinity, tLast = -Infinity, errorFrames = 0, fdFrames = 0;
    const channels = new Set();
    for (let i = 0; i < n; i++) {
      const t = this.t[i];
      if (t < tFirst) tFirst = t;
      if (t > tLast) tLast = t;
      const f = this.flags[i];
      if (f & FrameFlags.ERR) errorFrames++;
      if (f & FrameFlags.FD) fdFrames++;
      channels.add(this.ch[i]);
    }
    const duration = Math.max(0, tLast - tFirst);
    const perId = [];
    for (const [key, indices] of this.index()) {
      const ch = Math.floor(key / 0x100000000);
      const idWithExt = key % 0x100000000;
      const count = indices.length;
      // Mean cycle time from first/last occurrence; enough for a summary view.
      let cycleMs = null;
      if (count > 1) {
        const span = this.t[indices[count - 1]] - this.t[indices[0]];
        if (span > 0) cycleMs = (span / (count - 1)) * 1000;
      }
      const first = indices[0];
      perId.push({
        ch,
        id: idWithExt & ~EXT_BIT,
        ext: (idWithExt & EXT_BIT) !== 0,
        err: (this.flags[first] & FrameFlags.ERR) !== 0,
        count,
        cycleMs,
        rate: duration > 0 ? count / duration : null,
      });
    }
    perId.sort((a, b) => a.ch - b.ch || a.id - b.id);
    return {
      frameCount: n,
      duration,
      tFirst,
      tLast,
      frameRate: duration > 0 ? n / duration : 0,
      uniqueIds: perId.filter((p) => !p.err).length,
      errorFrames,
      fdFrames,
      channels: [...channels].sort((a, b) => a - b),
      perId,
    };
  }
}
