// DBC object model + registry of loaded databases.
//
// Each loaded .dbc file becomes one Cluster. Signals are addressed everywhere
// by their *qualified name* `cluster/message/signal`, so identical CAN IDs or
// signal names in different files never clash.

export class Cluster {
  constructor(name, fileName) {
    this.name = name; // display name (file name without extension)
    this.fileName = fileName;
    this.messages = new Map(); // key: idWithExtBit >>> 0 -> Message
    this.nodes = []; // BU_ node names
    this.parseErrors = []; // { line, text }
    this.comment = '';
  }

  messageById(idWithExt) {
    return this.messages.get(idWithExt >>> 0) ?? null;
  }
}

export class Message {
  constructor({ id, extended, name, dlc, transmitter }) {
    this.id = id; // raw identifier without ext bit
    this.extended = extended;
    this.name = name;
    this.dlc = dlc; // payload length from DBC (bytes)
    this.transmitter = transmitter;
    this.signals = []; // Signal[]
    this.comment = '';
    this.cluster = null; // back-ref, set on registration
  }

  get multiplexor() {
    return this.signals.find((s) => s.muxRole === 'multiplexor') ?? null;
  }

  get qualifiedName() {
    return `${this.cluster?.name ?? '?'}/${this.name}`;
  }
}

export class Signal {
  constructor(props) {
    Object.assign(
      this,
      {
        name: '',
        startBit: 0, // DBC start bit (LSB for Intel, MSB position for Motorola)
        bitLength: 1,
        byteOrder: 1, // 1 = Intel (little-endian), 0 = Motorola (big-endian)
        signed: false,
        isFloat: false, // SIG_VALTYPE_ 1 = float, 2 = double
        isDouble: false,
        factor: 1,
        offset: 0,
        min: 0,
        max: 0,
        unit: '',
        receivers: [],
        comment: '',
        startValue: null, // GenSigStartValue attribute (raw), null if absent
        valueTable: null, // Map<number, string> from VAL_
        muxRole: 'none', // 'none' | 'multiplexor' | 'multiplexed'
        muxValue: null, // selector value when muxRole === 'multiplexed'
      },
      props,
    );
    this.message = null; // back-ref
  }

  get qualifiedName() {
    return `${this.message?.qualifiedName ?? '?/?'}/${this.name}`;
  }

  /** Physical default value derived from raw GenSigStartValue, or null. */
  get defaultValue() {
    if (this.startValue == null) return null;
    return this.startValue * this.factor + this.offset;
  }
}

export class DbcRegistry {
  constructor() {
    this.clusters = []; // Cluster[], in load order
  }

  clusterByName(name) {
    return this.clusters.find((c) => c.name === name) ?? null;
  }

  add(cluster) {
    // De-duplicate display names: file.dbc loaded twice -> "file (2)"
    const base = cluster.name;
    let n = 2;
    while (this.clusterByName(cluster.name)) cluster.name = `${base} (${n++})`;
    for (const msg of cluster.messages.values()) {
      msg.cluster = cluster;
      for (const sig of msg.signals) sig.message = msg;
    }
    this.clusters.push(cluster);
  }

  remove(name) {
    const i = this.clusters.findIndex((c) => c.name === name);
    if (i >= 0) this.clusters.splice(i, 1);
  }

  /** Resolve "cluster/message/signal" -> Signal or null. */
  signalByQualifiedName(qname) {
    const [cName, mName, sName] = qname.split('/');
    const cluster = this.clusterByName(cName);
    if (!cluster) return null;
    for (const msg of cluster.messages.values()) {
      if (msg.name === mName) {
        return msg.signals.find((s) => s.name === sName) ?? null;
      }
    }
    return null;
  }

  /** All signals across all clusters. */
  *allSignals() {
    for (const cluster of this.clusters) {
      for (const msg of cluster.messages.values()) {
        for (const sig of msg.signals) yield sig;
      }
    }
  }
}
