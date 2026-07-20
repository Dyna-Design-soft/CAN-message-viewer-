// Vector DBC text parser.
//
// Supported statements: VERSION, BU_, BO_, SG_ (incl. simple multiplexing
// m<N>/M), VAL_, VAL_TABLE_, CM_ (multi-line, for BU_/BO_/SG_/global),
// BA_DEF_DEF_ / BA_ (GenSigStartValue -> Signal.startValue), SIG_VALTYPE_
// (float/double signals). Extended multiplexing (SG_MUL_VAL_) is recorded as a
// warning, not decoded. Anything unrecognized is skipped silently; malformed
// versions of *recognized* statements are collected in cluster.parseErrors
// with their line number, and parsing continues.

import { Cluster, Message, Signal } from './dbc-model.js';

const DBC_EXT_FLAG = 0x80000000; // DBC stores extended IDs with bit 31 set

const RE = {
  bo: /^BO_\s+(\d+)\s+([A-Za-z_][\w-]*)\s*:\s*(\d+)\s+(\S+)\s*$/,
  sg: /^SG_\s+([A-Za-z_][\w-]*)\s*(m\d+M?|M)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(\s*([^,\s]+)\s*,\s*([^)\s]+)\s*\)\s*\[\s*([^|]*?)\s*\|\s*([^\]]*?)\s*\]\s*"([^"]*)"\s*(.*)$/,
  val: /^VAL_\s+(\d+)\s+([A-Za-z_][\w-]*)\s+(.*?);?\s*$/,
  valTable: /^VAL_TABLE_\s+([A-Za-z_][\w-]*)\s+(.*?);?\s*$/,
  valPairs: /(-?\d+)\s+"((?:[^"\\]|\\.)*)"/g,
  cmSg: /^CM_\s+SG_\s+(\d+)\s+([A-Za-z_][\w-]*)\s+"([\s\S]*)"\s*;?\s*$/,
  cmBo: /^CM_\s+BO_\s+(\d+)\s+"([\s\S]*)"\s*;?\s*$/,
  cmBu: /^CM_\s+BU_\s+([A-Za-z_][\w-]*)\s+"([\s\S]*)"\s*;?\s*$/,
  cmGlobal: /^CM_\s+"([\s\S]*)"\s*;?\s*$/,
  baDefDef: /^BA_DEF_DEF_\s+"([^"]+)"\s+(.+?)\s*;?\s*$/,
  baSg: /^BA_\s+"([^"]+)"\s+SG_\s+(\d+)\s+([A-Za-z_][\w-]*)\s+(.+?)\s*;?\s*$/,
  baBo: /^BA_\s+"([^"]+)"\s+BO_\s+(\d+)\s+(.+?)\s*;?\s*$/,
  sigValtype: /^SIG_VALTYPE_\s+(\d+)\s+([A-Za-z_][\w-]*)\s*:?\s*(\d+)\s*;?\s*$/,
  bu: /^BU_\s*:\s*(.*)$/,
  sgMulVal: /^SG_MUL_VAL_\s/,
};

/**
 * Parse DBC text into a Cluster.
 * @param {string} text DBC file contents
 * @param {string} fileName original file name (cluster is named after it)
 */
export function parseDbc(text, fileName) {
  const name = fileName.replace(/\.[^.]*$/, '');
  const cluster = new Cluster(name, fileName);
  const byDbcId = new Map(); // raw DBC id (incl. ext flag) -> Message
  const valueTables = new Map(); // VAL_TABLE_ name -> Map
  const sigStartValues = []; // applied at the end (BA_ can precede nothing)
  let currentMessage = null;
  let extMuxWarned = false;

  const err = (line, textMsg) => cluster.parseErrors.push({ line, text: textMsg });

  const statements = splitStatements(text);
  for (const { line, stmt } of statements) {
    try {
      if (stmt.startsWith('BO_ ')) {
        const m = RE.bo.exec(stmt);
        if (!m) {
          err(line, `Malformed BO_ statement: ${truncate(stmt)}`);
          currentMessage = null;
          continue;
        }
        const dbcId = Number(m[1]) >>> 0;
        const extended = (dbcId & DBC_EXT_FLAG) !== 0;
        const msg = new Message({
          id: dbcId & ~DBC_EXT_FLAG,
          extended,
          name: m[2],
          dlc: Number(m[3]),
          transmitter: m[4] === 'Vector__XXX' ? '' : m[4],
        });
        byDbcId.set(dbcId, msg);
        cluster.messages.set(dbcId >>> 0, msg);
        currentMessage = msg;
      } else if (stmt.startsWith('SG_ ')) {
        if (!currentMessage) {
          err(line, 'SG_ outside of a BO_ block');
          continue;
        }
        const m = RE.sg.exec(stmt);
        if (!m) {
          err(line, `Malformed SG_ statement: ${truncate(stmt)}`);
          continue;
        }
        const mux = m[2] ?? '';
        const signal = new Signal({
          name: m[1],
          startBit: Number(m[3]),
          bitLength: Number(m[4]),
          byteOrder: Number(m[5]), // 1 = Intel, 0 = Motorola
          signed: m[6] === '-',
          factor: Number(m[7]),
          offset: Number(m[8]),
          min: m[9] === '' ? 0 : Number(m[9]),
          max: m[10] === '' ? 0 : Number(m[10]),
          unit: m[11],
          receivers: m[12]
            .split(/[,\s]+/)
            .filter((r) => r && r !== 'Vector__XXX'),
          muxRole: mux === 'M' ? 'multiplexor' : mux ? 'multiplexed' : 'none',
          muxValue: /^m\d+/.test(mux) ? Number(mux.match(/^m(\d+)/)[1]) : null,
        });
        currentMessage.signals.push(signal);
      } else if (stmt.startsWith('VAL_TABLE_ ')) {
        const m = RE.valTable.exec(stmt);
        if (m) valueTables.set(m[1], parseValuePairs(m[2]));
        else err(line, `Malformed VAL_TABLE_: ${truncate(stmt)}`);
      } else if (stmt.startsWith('VAL_ ')) {
        const m = RE.val.exec(stmt);
        if (!m) {
          err(line, `Malformed VAL_: ${truncate(stmt)}`);
          continue;
        }
        const sig = findSignal(byDbcId, Number(m[1]), m[2]);
        if (sig) {
          // Either inline pairs or a VAL_TABLE_ reference.
          const rest = m[3].trim();
          const table = valueTables.get(rest);
          sig.valueTable = table ?? parseValuePairs(rest);
          if (sig.valueTable.size === 0) sig.valueTable = null;
        }
      } else if (stmt.startsWith('CM_')) {
        let m;
        if ((m = RE.cmSg.exec(stmt))) {
          const sig = findSignal(byDbcId, Number(m[1]), m[2]);
          if (sig) sig.comment = unescapeQuotes(m[3]);
        } else if ((m = RE.cmBo.exec(stmt))) {
          const msg = byDbcId.get(Number(m[1]) >>> 0);
          if (msg) msg.comment = unescapeQuotes(m[2]);
        } else if ((m = RE.cmBu.exec(stmt))) {
          // node comments: not surfaced yet
        } else if ((m = RE.cmGlobal.exec(stmt))) {
          cluster.comment = unescapeQuotes(m[1]);
        }
      } else if (stmt.startsWith('BA_DEF_DEF_ ')) {
        const m = RE.baDefDef.exec(stmt);
        if (m && m[1] === 'GenSigStartValue') {
          const def = Number(stripQuotes(m[2]));
          if (!Number.isNaN(def) && def !== 0) {
            sigStartValues.push({ default: def });
          }
        }
      } else if (stmt.startsWith('BA_ ')) {
        let m;
        if ((m = RE.baSg.exec(stmt))) {
          if (m[1] === 'GenSigStartValue') {
            const sig = findSignal(byDbcId, Number(m[2]), m[3]);
            const v = Number(stripQuotes(m[4]));
            if (sig && !Number.isNaN(v)) sig.startValue = v;
          }
        } else if ((m = RE.baBo.exec(stmt))) {
          // message attributes (GenMsgCycleTime etc.) — not surfaced yet
        }
      } else if (stmt.startsWith('SIG_VALTYPE_ ')) {
        const m = RE.sigValtype.exec(stmt);
        if (m) {
          const sig = findSignal(byDbcId, Number(m[1]), m[2]);
          if (sig) {
            sig.isFloat = m[3] === '1' || m[3] === '2';
            sig.isDouble = m[3] === '2';
          }
        }
      } else if (RE.sgMulVal.test(stmt)) {
        if (!extMuxWarned) {
          err(line, 'Extended multiplexing (SG_MUL_VAL_) is not decoded; affected signals use simple m<N> selectors only.');
          extMuxWarned = true;
        }
      } else if (stmt.startsWith('BU_')) {
        const m = RE.bu.exec(stmt);
        if (m) {
          cluster.nodes = m[1].split(/\s+/).filter((n) => n && n !== 'Vector__XXX');
        }
      }
      // VERSION, NS_, BS_, BA_DEF_, EV_, SIG_GROUP_, ... intentionally ignored.
    } catch (e) {
      err(line, `Parser error: ${e.message}`);
    }
  }

  // Apply GenSigStartValue default to signals without an explicit BA_ value.
  const defEntry = sigStartValues.find((s) => 'default' in s);
  if (defEntry) {
    for (const msg of cluster.messages.values()) {
      for (const sig of msg.signals) {
        if (sig.startValue == null) sig.startValue = defEntry.default;
      }
    }
  }

  // Deterministic signal order: by start bit within each message.
  for (const msg of cluster.messages.values()) {
    msg.signals.sort((a, b) => a.startBit - b.startBit || a.name.localeCompare(b.name));
  }
  return cluster;
}

/**
 * Split DBC text into statements with their starting line numbers.
 * Statements are line-based, except quoted strings (comments!) may span
 * lines — so lines are joined while inside an open quote. SG_ lines belong to
 * the preceding BO_; the parser keeps that state, so here every physical
 * statement is emitted separately.
 */
function splitStatements(text) {
  const out = [];
  const lines = text.split(/\r\n|\r|\n/);
  let buf = '';
  let bufLine = 0;
  let inQuote = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inQuote) {
      buf = line.trim();
      bufLine = i + 1;
      if (!buf) continue;
    } else {
      buf += '\n' + line;
    }
    inQuote = countUnescapedQuotes(buf) % 2 === 1;
    if (!inQuote) out.push({ line: bufLine, stmt: buf });
  }
  if (inQuote && buf.trim()) out.push({ line: bufLine, stmt: buf });
  return out;
}

function countUnescapedQuotes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && s[i - 1] !== '\\') n++;
  }
  return n;
}

function parseValuePairs(s) {
  const table = new Map();
  RE.valPairs.lastIndex = 0;
  let m;
  while ((m = RE.valPairs.exec(s))) table.set(Number(m[1]), unescapeQuotes(m[2]));
  return table;
}

function findSignal(byDbcId, dbcId, sigName) {
  const msg = byDbcId.get(dbcId >>> 0);
  return msg?.signals.find((s) => s.name === sigName) ?? null;
}

function stripQuotes(s) {
  return s.replace(/^"(.*)"$/s, '$1');
}

function unescapeQuotes(s) {
  return s.replace(/\\"/g, '"');
}

function truncate(s, n = 80) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
