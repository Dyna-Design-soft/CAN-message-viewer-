#!/usr/bin/env python3
"""Industrial Analyzer live bridge — zero dependencies (Python 3.8+ standard library only).

Producers (your Python / LabVIEW / C# / PLC application) send data to the bridge over
    TCP  :8766   newline-delimited JSON lines and/or binary "IAL1" blocks (self-delimiting)
    UDP  :8767   one JSON message or one "IAL1" block per datagram
    WS   :8765   a producer may also send over WebSocket
The browser app (Industrial_Analyzer.html → LIVE) connects to  ws://<host>:8765  and
receives every message unchanged. The last "meta" message is replayed to clients that
connect later, so channel names/units appear immediately.

    python ia_bridge.py                     # defaults
    python ia_bridge.py --host 0.0.0.0      # accept connections from other machines
    python ia_bridge.py --ws 9000 --tcp 9001 --udp 9002

Binary block "IAL1" (little-endian):  b"IAL1" | u32 n_channels | u32 n_samples |
    f64 t0 (NaN = continue) | f64 dt | float32[n_channels * n_samples] channel by channel
"""
import argparse, asyncio, base64, hashlib, json, struct, sys, time

MAGIC = b"IAL1"
HDR = struct.Struct("<4sIIdd")  # magic, nch, ns, t0, dt  (magic compared as bytes)
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Hub:
    def __init__(self, maxq):
        self.clients = set()
        self.meta = None
        self.maxq = maxq
        self.stats = dict(msgs=0, bytes=0, dropped=0)

    def publish(self, payload, binary):
        if not binary:
            try:
                j = json.loads(payload)
                if isinstance(j, dict) and (j.get("type") == "meta" or "names" in j):
                    self.meta = payload
                if isinstance(j, dict) and j.get("type") == "hello":
                    return
            except Exception:
                return  # ignore malformed text
        self.stats["msgs"] += 1
        self.stats["bytes"] += len(payload)
        frame = ws_frame(payload, binary)
        for c in list(self.clients):
            if c.q.qsize() >= self.maxq:  # slow browser: drop oldest instead of blocking producers
                try:
                    c.q.get_nowait()
                    self.stats["dropped"] += 1
                except asyncio.QueueEmpty:
                    pass
            c.q.put_nowait(frame)


def ws_frame(payload, binary):
    if isinstance(payload, str):
        payload = payload.encode()
    op = 0x82 if binary else 0x81
    n = len(payload)
    if n < 126:
        h = struct.pack("!BB", op, n)
    elif n < 65536:
        h = struct.pack("!BBH", op, 126, n)
    else:
        h = struct.pack("!BBQ", op, 127, n)
    return h + payload


class WsClient:
    def __init__(self, writer):
        self.w = writer
        self.q = asyncio.Queue()


async def read_ws_frame(reader):
    b1, b2 = await reader.readexactly(2)
    op, masked, n = b1 & 0x0F, b2 & 0x80, b2 & 0x7F
    if n == 126:
        n = struct.unpack("!H", await reader.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", await reader.readexactly(8))[0]
    mask = await reader.readexactly(4) if masked else b"\0\0\0\0"
    data = bytearray(await reader.readexactly(n))
    if masked:
        for i in range(n):
            data[i] ^= mask[i & 3]
    return op, bytes(data), bool(b1 & 0x80)


async def handle_ws(reader, writer, hub):
    try:
        req = await reader.readuntil(b"\r\n\r\n")
    except Exception:
        writer.close(); return
    headers = {}
    for line in req.decode(errors="replace").split("\r\n")[1:]:
        if ":" in line:
            k, v = line.split(":", 1); headers[k.strip().lower()] = v.strip()
    key = headers.get("sec-websocket-key")
    if not key:  # plain HTTP request → small status page
        body = json.dumps({"bridge": "industrial-analyzer", "clients": len(hub.clients), **hub.stats}).encode()
        writer.write(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
        await writer.drain(); writer.close(); return
    acc = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
    writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                  f"Sec-WebSocket-Accept: {acc}\r\n\r\n").encode())
    await writer.drain()
    c = WsClient(writer)
    hub.clients.add(c)
    peer = writer.get_extra_info("peername")
    log(f"WebSocket client connected {peer}  ({len(hub.clients)} total)")
    if hub.meta:
        c.q.put_nowait(ws_frame(hub.meta, False))

    async def sender():
        while True:
            f = await c.q.get()
            writer.write(f)
            await writer.drain()

    st = asyncio.ensure_future(sender())
    buf, buf_op = b"", 0
    try:
        while True:
            op, data, fin = await read_ws_frame(reader)
            if op == 8:
                break
            if op == 9:  # ping → pong
                writer.write(struct.pack("!BB", 0x8A, len(data)) + data); continue
            if op in (1, 2):
                buf, buf_op = data, op
            elif op == 0:
                buf += data
            else:
                continue
            if fin:  # WebSocket producers are relayed too
                if buf_op == 1:
                    hub.publish(buf.decode(errors="replace"), False)
                else:
                    hub.publish(buf, True)
    except (asyncio.IncompleteReadError, ConnectionError, OSError):
        pass
    finally:
        st.cancel(); hub.clients.discard(c)
        try: writer.close()
        except Exception: pass
        log(f"WebSocket client left {peer}  ({len(hub.clients)} total)")


async def handle_tcp(reader, writer, hub):
    peer = writer.get_extra_info("peername")
    log(f"TCP producer connected {peer}")
    try:
        while True:
            first = await reader.readexactly(1)
            if first == b"I":  # binary block
                rest = await reader.readexactly(HDR.size - 1)
                magic, nch, ns, t0, dt = HDR.unpack(first + rest)
                if magic != MAGIC:
                    await reader.readline(); continue
                data = await reader.readexactly(4 * nch * ns)
                hub.publish(first + rest + data, True)
            elif first in (b"\n", b"\r", b" "):
                continue
            else:
                line = first + await reader.readuntil(b"\n")
                hub.publish(line.decode(errors="replace").strip(), False)
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, OSError):
        pass
    finally:
        log(f"TCP producer disconnected {peer}")
        writer.close()


class UdpProto(asyncio.DatagramProtocol):
    def __init__(self, hub):
        self.hub = hub

    def datagram_received(self, data, addr):
        if data[:4] == MAGIC:
            self.hub.publish(data, True)
        else:
            for line in data.decode(errors="replace").splitlines():
                if line.strip():
                    self.hub.publish(line.strip(), False)


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


async def main(a):
    hub = Hub(a.queue)
    ws = await asyncio.start_server(lambda r, w: handle_ws(r, w, hub), a.host, a.ws, limit=2**26)
    tcp = await asyncio.start_server(lambda r, w: handle_tcp(r, w, hub), a.host, a.tcp, limit=2**26)
    loop = asyncio.get_running_loop()
    await loop.create_datagram_endpoint(lambda: UdpProto(hub), local_addr=(a.host, a.udp))
    log(f"Industrial Analyzer bridge  WS ws://{a.host}:{a.ws}  TCP {a.host}:{a.tcp}  UDP {a.host}:{a.udp}")
    log("Open Industrial_Analyzer.html → LIVE → Connect")
    last = dict(hub.stats)
    while True:
        await asyncio.sleep(5)
        s = hub.stats
        if s["msgs"] != last["msgs"]:
            log(f"{(s['msgs'] - last['msgs']) / 5:.0f} msg/s  {(s['bytes'] - last['bytes']) / 5 / 1024:.0f} KB/s  "
                f"clients={len(hub.clients)}  dropped={s['dropped']}")
        last = dict(s)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1", help="interface to bind (0.0.0.0 = all)")
    p.add_argument("--ws", type=int, default=8765)
    p.add_argument("--tcp", type=int, default=8766)
    p.add_argument("--udp", type=int, default=8767)
    p.add_argument("--queue", type=int, default=2000, help="max queued messages per browser before dropping oldest")
    try:
        asyncio.run(main(p.parse_args()))
    except KeyboardInterrupt:
        pass
