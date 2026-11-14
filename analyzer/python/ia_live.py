#!/usr/bin/env python3
"""Send live data to the Industrial Analyzer (via ia_bridge.py). Standard library only;
numpy is used automatically when available (much faster for big blocks).

    from ia_live import LiveSender
    s = LiveSender("tcp://localhost:8766", names=["AI0", "AI1"], units=["V", "V"], rate=20000)
    s.send_block([ai0, ai1])          # one array per channel (numpy array or list)
    s.send_sample([1.2, 3.4], t=0.5)  # single sample (slow rates)
    s.close()

URLs:  tcp://host:8766  (reliable, recommended)   udp://host:8767  (lowest latency, may drop)
Binary blocks are used by default (float32) — ~10x less bandwidth than JSON.

Demo (8 channels @ 20 kS/s):  python ia_live.py --demo --rate 20000 --channels 8
"""
import json, math, random, socket, struct, time
from urllib.parse import urlparse

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None

MAX_UDP = 60000


class LiveSender:
    def __init__(self, url="tcp://localhost:8766", names=None, units=None, rate=None, binary=True):
        u = urlparse(url if "://" in url else "tcp://" + url)
        self.kind, self.addr = u.scheme, (u.hostname or "localhost", u.port or (8767 if u.scheme == "udp" else 8766))
        self.binary, self.rate, self.t = binary, rate, 0.0
        self.names, self.units = names, units
        if self.kind == "udp":
            self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        elif self.kind == "tcp":
            self.sock = socket.create_connection(self.addr)
            self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        else:
            raise ValueError("url must start with tcp:// or udp://")
        if names:
            self.send_meta(names, units, rate)

    def _send(self, data: bytes):
        if self.kind == "udp":
            self.sock.sendto(data, self.addr)
        else:
            self.sock.sendall(data)

    def send_meta(self, names, units=None, rate=None):
        self.names, self.units, self.rate = list(names), list(units or [""] * len(names)), rate or self.rate
        self._send((json.dumps({"type": "meta", "names": self.names, "units": self.units, "rate": self.rate}) + "\n").encode())

    def send_block(self, channels, t0=None, dt=None):
        """channels: sequence of equal-length arrays (one per channel)."""
        dt = dt or (1.0 / self.rate if self.rate else 1e-3)
        t0 = self.t if t0 is None else t0
        nch = len(channels)
        ns = len(channels[0])
        if self.binary:
            if np is not None:
                payload = np.ascontiguousarray(np.asarray(channels, dtype="<f4")).tobytes()
            else:
                payload = b"".join(struct.pack("<%df" % ns, *c) for c in channels)
            if self.kind == "udp" and 28 + len(payload) > MAX_UDP:  # split into datagram-sized blocks
                step = max(1, (MAX_UDP - 28) // (4 * nch))
                for s in range(0, ns, step):
                    self.send_block([c[s:s + step] for c in channels], t0 + s * dt, dt)
                self.t = t0 + ns * dt
                return
            self._send(b"IAL1" + struct.pack("<IIdd", nch, ns, t0, dt) + payload)
        else:
            chs = [c.tolist() if hasattr(c, "tolist") else list(c) for c in channels]
            self._send((json.dumps({"t0": t0, "dt": dt, "ch": chs}) + "\n").encode())
        self.t = t0 + ns * dt

    def send_sample(self, values, t=None):
        self._send((json.dumps({"t": time.time() if t is None else t, "v": list(values)}) + "\n").encode())

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def demo(url, rate, nch, seconds):
    names = [f"AI{i}" for i in range(nch)]
    s = LiveSender(url, names=names, units=["V"] * nch, rate=rate)
    block = max(1, rate // 50)  # 20 ms blocks
    k, t_start = 0, time.perf_counter()
    print(f"Streaming {nch} ch @ {rate} S/s to {url} (Ctrl+C to stop)")
    try:
        while seconds <= 0 or k < seconds * rate:
            if np is not None:
                t = (k + np.arange(block)) / rate
                chans = [np.sin(2 * np.pi * (5 + 7 * c) * t) * (1 + c * 0.2) + 0.05 * np.random.randn(block) for c in range(nch)]
            else:
                chans = [[math.sin(2 * math.pi * (5 + 7 * c) * (k + i) / rate) + random.gauss(0, 0.05) for i in range(block)] for c in range(nch)]
            s.send_block(chans, t0=k / rate)
            k += block
            ahead = k / rate - (time.perf_counter() - t_start)
            if ahead > 0:
                time.sleep(ahead)
    except KeyboardInterrupt:
        pass
    finally:
        s.close()


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--demo", action="store_true")
    p.add_argument("--url", default="tcp://localhost:8766")
    p.add_argument("--rate", type=int, default=20000)
    p.add_argument("--channels", type=int, default=8)
    p.add_argument("--seconds", type=float, default=0)
    a = p.parse_args()
    demo(a.url, a.rate, a.channels, a.seconds)
