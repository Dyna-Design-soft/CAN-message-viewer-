// Write a FrameStore to Vector ASC text (classic + FD), re-openable by this
// viewer's ASC reader and by CANoe/CANalyzer.

import { FrameFlags } from '../core/frame-store.js';
import { lengthToDlc } from '../core/frame-store.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function writeAsc(store) {
  const out = [];
  const start = store.t0Epoch != null ? new Date(store.t0Epoch * 1000) : new Date();
  out.push(
    `date ${DAYS[start.getDay()]} ${MONTHS[start.getMonth()]} ${start.getDate()} ` +
      `${pad(start.getHours())}:${pad(start.getMinutes())}:${pad(start.getSeconds())}.` +
      `${String(start.getMilliseconds()).padStart(3, '0')} ${start.getFullYear()}`,
  );
  out.push('base hex  timestamps absolute');
  out.push('no internal events logged');

  for (let i = 0; i < store.count; i++) {
    const t = store.t[i].toFixed(6);
    const ch = store.ch[i];
    const f = store.flags[i];
    const dir = f & FrameFlags.TX ? 'Tx' : 'Rx';
    if (f & FrameFlags.ERR) {
      out.push(`${t} ${ch} ErrorFrame`);
      continue;
    }
    const id = store.rawId(i);
    const idStr = id.toString(16).toUpperCase() + (store.isExt(i) ? 'x' : '');
    const data = store.data(i);
    const hex = bytesHex(data);
    if (f & FrameFlags.FD) {
      const brs = f & FrameFlags.BRS ? 1 : 0;
      const esi = f & FrameFlags.ESI ? 1 : 0;
      const dlc = lengthToDlc(data.length);
      // CANoe FD: <t> CANFD <ch> <dir> <id> <name> <brs> <esi> <dlcCode> <len> <data...>
      out.push(
        `${t} CANFD ${ch} ${dir} ${idStr}                  ${brs} ${esi} ${dlc.toString(16)} ${data.length}  ${hex}`,
      );
    } else if (f & FrameFlags.RTR) {
      out.push(`${t} ${ch}  ${idStr}             ${dir}   r ${data.length}`);
    } else {
      out.push(`${t} ${ch}  ${idStr}             ${dir}   d ${data.length} ${hex}`);
    }
  }
  return out.join('\n') + '\n';
}

function bytesHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i) s += ' ';
    s += bytes[i].toString(16).toUpperCase().padStart(2, '0');
  }
  return s;
}

function pad(n) {
  return String(n).padStart(2, '0');
}
