// Write a FrameStore to CSV: timestamp, channel, id, type, dir, dlc, flags, data.

import { FrameFlags } from '../core/frame-store.js';
import { registerFormat } from './format-registry.js';
import { FrameStore } from '../core/frame-store.js';

export function writeCsv(store) {
  const rows = ['Timestamp,Channel,ID,IDHex,Extended,Dir,DLC,FD,BRS,ESI,Error,Data'];
  for (let i = 0; i < store.count; i++) {
    const f = store.flags[i];
    const id = store.rawId(i);
    const data = store.data(i);
    let hex = '';
    for (const b of data) hex += b.toString(16).toUpperCase().padStart(2, '0');
    rows.push(
      [
        store.t[i].toFixed(6),
        store.ch[i],
        id,
        '0x' + id.toString(16).toUpperCase(),
        store.isExt(i) ? 1 : 0,
        f & FrameFlags.TX ? 'Tx' : 'Rx',
        data.length,
        f & FrameFlags.FD ? 1 : 0,
        f & FrameFlags.BRS ? 1 : 0,
        f & FrameFlags.ESI ? 1 : 0,
        f & FrameFlags.ERR ? 1 : 0,
        hex,
      ].join(','),
    );
  }
  return rows.join('\n') + '\n';
}

// CSV is also readable back (round-trip) — register as an input format.
export function parseCsv(text) {
  const store = new FrameStore();
  const lines = text.split(/\r\n|\r|\n/);
  const header = (lines[0] || '').toLowerCase();
  const col = (name) => header.split(',').indexOf(name);
  const ci = {
    t: col('timestamp'), ch: col('channel'), id: col('id'), ext: col('extended'),
    dir: col('dir'), fd: col('fd'), brs: col('brs'), esi: col('esi'),
    err: col('error'), data: col('data'),
  };
  if (ci.t < 0 || ci.id < 0) return store; // not our CSV
  for (let li = 1; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) continue;
    const c = line.split(',');
    const t = Number(c[ci.t]);
    if (Number.isNaN(t)) continue;
    let flags = 0;
    if (c[ci.dir] === 'Tx') flags |= FrameFlags.TX;
    if (ci.fd >= 0 && c[ci.fd] === '1') flags |= FrameFlags.FD;
    if (ci.brs >= 0 && c[ci.brs] === '1') flags |= FrameFlags.BRS;
    if (ci.esi >= 0 && c[ci.esi] === '1') flags |= FrameFlags.ESI;
    if (ci.err >= 0 && c[ci.err] === '1') flags |= FrameFlags.ERR;
    const hex = ci.data >= 0 ? (c[ci.data] || '') : '';
    const n = hex.length >> 1;
    const data = new Uint8Array(n);
    for (let i = 0; i < n; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
    store.add(t, Number(c[ci.id]) || 0, ci.ext >= 0 && c[ci.ext] === '1', Number(c[ci.ch]) || 0, flags, data);
  }
  return store;
}

registerFormat({
  name: 'CSV',
  extensions: ['csv'],
  sniff(head, name) {
    if (!name.toLowerCase().endsWith('.csv')) return false;
    const s = new TextDecoder().decode(head).toLowerCase();
    return s.startsWith('timestamp,') && s.includes('id');
  },
  async read(file) {
    return parseCsv(await file.text());
  },
});
