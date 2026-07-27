"""DBC object model + registry. Port of the JS dbc-model."""
from __future__ import annotations


class Signal:
    def __init__(self, **kw):
        self.name = kw.get("name", "")
        self.start_bit = kw.get("start_bit", 0)
        self.bit_length = kw.get("bit_length", 1)
        self.byte_order = kw.get("byte_order", 1)   # 1 Intel, 0 Motorola
        self.signed = kw.get("signed", False)
        self.is_float = kw.get("is_float", False)
        self.is_double = kw.get("is_double", False)
        self.factor = kw.get("factor", 1.0)
        self.offset = kw.get("offset", 0.0)
        self.min = kw.get("min", 0.0)
        self.max = kw.get("max", 0.0)
        self.unit = kw.get("unit", "")
        self.receivers = kw.get("receivers", [])
        self.comment = ""
        self.start_value = None            # GenSigStartValue (raw)
        self.value_table = None            # dict[int,str]
        self.mux_role = kw.get("mux_role", "none")  # none|multiplexor|multiplexed
        self.mux_value = kw.get("mux_value", None)
        self.message = None

    @property
    def qualified_name(self) -> str:
        m = self.message.qualified_name if self.message else "?/?"
        return f"{m}/{self.name}"

    @property
    def default_value(self):
        if self.start_value is None:
            return None
        return self.start_value * self.factor + self.offset


class Message:
    def __init__(self, id, extended, name, dlc, transmitter):
        self.id = id
        self.extended = extended
        self.name = name
        self.dlc = dlc
        self.transmitter = transmitter
        self.signals: list[Signal] = []
        self.comment = ""
        self.cluster = None

    @property
    def multiplexor(self):
        for s in self.signals:
            if s.mux_role == "multiplexor":
                return s
        return None

    @property
    def qualified_name(self) -> str:
        return f"{self.cluster.name if self.cluster else '?'}/{self.name}"


class Cluster:
    def __init__(self, name, file_name):
        self.name = name
        self.file_name = file_name
        self.messages: dict[int, Message] = {}  # idWithExtBit -> Message
        self.nodes: list[str] = []
        self.parse_errors: list[dict] = []
        self.comment = ""
        self.source = None  # raw DBC text (for persistence/round-trip)


class DbcRegistry:
    def __init__(self):
        self.clusters: list[Cluster] = []

    def cluster_by_name(self, name):
        for c in self.clusters:
            if c.name == name:
                return c
        return None

    def add(self, cluster: Cluster):
        base = cluster.name
        n = 2
        while self.cluster_by_name(cluster.name):
            cluster.name = f"{base} ({n})"
            n += 1
        for msg in cluster.messages.values():
            msg.cluster = cluster
            for sig in msg.signals:
                sig.message = msg
        self.clusters.append(cluster)

    def remove(self, name):
        self.clusters = [c for c in self.clusters if c.name != name]

    def clear_all(self):
        self.clusters = []

    def signal_by_qualified_name(self, qname):
        parts = qname.split("/")
        if len(parts) != 3:
            return None
        cname, mname, sname = parts
        cluster = self.cluster_by_name(cname)
        if not cluster:
            return None
        for msg in cluster.messages.values():
            if msg.name == mname:
                for s in msg.signals:
                    if s.name == sname:
                        return s
        return None

    def all_signals(self):
        for c in self.clusters:
            for m in c.messages.values():
                yield from m.signals
