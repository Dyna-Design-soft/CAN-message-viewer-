// Vector ASC (ASCII trace) reader.
//
// Handles the common CANoe/CANalyzer layout:
//   date Sat Jul 19 10:00:00.000 2025
//   base hex  timestamps absolute|relative
//   0.001230 1  123             Rx   d 8 DE AD BE EF 00 11 22 33
//   0.002000 1  1CFF00EEx       Rx   d 4 01 02 03 04
//   0.003000 CANFD 1 Rx 200 BRS ESI d 64 ...        (simplified FD variant)
//   0.004000 1  ErrorFrame
// Classic and the widespread "CANFD" line variants are supported; unknown
// lines are counted and skipped.

import { FrameStore, FrameFlags } from '../core/frame-store.js';
import { registerFormat } from './format-registry.js';

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

export function parseAscText(text) {
  const store = new FrameStore();
  let base = 16;
  let skipped = 0;
  const lines = text.split(/\r\n|\r|\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    if (line.startsWith('date ')) {
      const m = /date\s+\w+\s+(\w+)\s+(\d+)\s+(\d+):(\d+):(\d+)(?:\.(\d+))?\s+(?:[ap]m\s+)?(\d{4})/i.exec(line);
      if (m && MONTHS[m[1]] !== undefined) {
        const d = new Date(
          Number(m[7]), MONTHS[m[1]], Number(m[2]),
          Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0),
        );
        store.t0Epoch = d.getTime() / 1000;
      }
      continue;
    }
    if (line.startsWith('base ')) {
      base = /base\s+dec/i.test(line) ? 10 : 16;
      continue;
    }
    if (/^(begin|end|internal|Begin|End)\b/i.test(line) || line.startsWith('version')) continue;

    const tok = line.split(/\s+/);
    const t = Number(tok[0]);
    if (Number.isNaN(t)) continue;

    // CAN FD line: "<time> CANFD <ch> <dir> <id>[x] [name] [BRS] [ESI] d <dlc> <len> <bytes...>"
    // (CANoe >= 8.5 writes: time CANFD ch dir id  symname brs esi dlc len data...)
    if (tok[1] === 'CANFD') {
      const ch = Number(tok[2]) || 1;
      const dir = tok[3];
      const idTok = tok[4];
      if (!idTok) { skipped++; continue; }
      const ext = idTok.endsWith('x');
      const id = parseInt(ext ? idTok.slice(0, -1) : idTok, 16);
      if (Number.isNaN(id)) { skipped++; continue; }
      let flags = FrameFlags.FD | (dir === 'Tx' ? FrameFlags.TX : 0);
      if (tok.includes('BRS')) flags |= FrameFlags.BRS;
      if (tok.includes('ESI')) flags |= FrameFlags.ESI;
      // Vector FD layout after the "d" data marker: <dlc> <dataLength> <bytes...>
      // then optional trailing metadata. Anchor on "d", take dataLength (the
      // second numeric token) bytes that follow it.
      const d = tok.indexOf('d', 5);
      let data = new Uint8Array(0);
      if (d >= 0 && /^\d+$/.test(tok[d + 1] || '')) {
        const dataLen = /^\d+$/.test(tok[d + 2] || '') ? Number(tok[d + 2]) : Number(tok[d + 1]);
        const first = /^\d+$/.test(tok[d + 2] || '') ? d + 3 : d + 2;
        const n = Math.min(dataLen, 64, tok.length - first);
        data = new Uint8Array(n);
        for (let i = 0; i < n; i++) data[i] = parseInt(tok[first + i], 16) || 0;
      }
      store.add(t, id, ext, ch, flags, data);
      continue;
    }

    const ch = Number(tok[1]);
    if (Number.isNaN(ch)) { skipped++; continue; }

    if (/^ErrorFrame/i.test(tok[2] ?? '')) {
      store.add(t, 0, false, ch, FrameFlags.ERR, null);
      continue;
    }
    if (/^(Statistic|J1939TP|TriggerEvent|BusStatistics)/i.test(tok[2] ?? '')) { skipped++; continue; }

    // Classic frame: "<time> <ch> <id>[x] <dir> [d|r] <dlc> <bytes...>"
    const idTok = tok[2];
    const ext = idTok.endsWith('x') || idTok.endsWith('X');
    const idStr = ext ? idTok.slice(0, -1) : idTok;
    const id = parseInt(idStr, base);
    if (Number.isNaN(id)) { skipped++; continue; }
    const dir = tok[3];
    let flags = dir === 'Tx' ? FrameFlags.TX : 0;
    let k = 4;
    let rtr = false;
    if (tok[k] === 'r') { rtr = true; k++; }
    else if (tok[k] === 'd') k++;
    if (rtr) {
      const dlc = Number(tok[k]) || 0;
      store.add(t, id, ext, ch, flags | FrameFlags.RTR, new Uint8Array(0));
      continue;
    }
    const dlc = Number(tok[k]);
    if (Number.isNaN(dlc)) { skipped++; continue; }
    k++;
    const n = Math.min(dlc, 64);
    const data = new Uint8Array(n);
    let ok = true;
    for (let i = 0; i < n; i++) {
      const b = parseInt(tok[k + i], 16);
      if (Number.isNaN(b)) { ok = false; break; }
      data[i] = b;
    }
    if (!ok) { skipped++; continue; }
    store.add(t, id, ext, ch, flags, data);
  }
  return { store, skipped };
}

registerFormat({
  name: 'Vector ASC',
  extensions: ['asc'],
  sniff(head, name) {
    if (!name.toLowerCase().endsWith('.asc')) return false;
    const s = new TextDecoder().decode(head);
    return /^(date|base|\/\/|\d)/.test(s.trimStart());
  },
  async read(file) {
    const text = await file.text();
    return parseAscText(text).store;
  },
});
