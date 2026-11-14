// Industrial Analyzer — multi-format data import layer.
// Converts Excel / CSV / TXT / TDMS / MS Access / SQLite / SQL dump / JSON files
// into the analyzer's dataset shape: {name, kind, names, t, data, units, sampleInfo}.
// The reference analyzer code is left untouched; this module replaces only the
// file-input handler and calls the existing global loadData()/navigate().
import * as XLSX from 'xlsx';
import initSqlJs from 'sql.js/dist/sql-wasm.js';
import sqlWasm from 'sql.js/dist/sql-wasm.wasm';
import MDBReader from 'mdb-reader';
import { Buffer } from 'buffer';
import { parseTdmsChannels } from '../../src/io/tdms-reader.js';

const TIME_RE = /^(time|time[ _]?\(?s\)?|time_s|timestamp|datetime|date[ _]?time|date|seconds|sec|t|zeit|elapsed|elapsed[ _]?time|time[ _]?stamp)$/i;
const ACCEPT = '.csv,.tsv,.txt,.dat,.log,.xlsx,.xlsm,.xlsb,.xls,.ods,.tdms,.mdb,.accdb,.db,.sqlite,.sqlite3,.db3,.sql,.json';

// ---------- generic table -> dataset ----------
function toNumber(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime() / 1000;
  let s = String(v).trim();
  if (!s) return NaN;
  if (/^-?\d{1,3}(\.\d{3})*,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,5
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.'); // decimal comma
  if (/^(true|false)$/i.test(s)) return /^t/i.test(s) ? 1 : 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
function toTime(v) {
  if (v instanceof Date) return v.getTime() / 1000;
  const n = toNumber(v);
  if (Number.isFinite(n)) return n;
  if (typeof v === 'string' && /\d/.test(v)) {
    const d = Date.parse(v.trim().replace(' ', 'T'));
    if (Number.isFinite(d)) return d / 1000;
    const m = v.trim().match(/^(\d+):(\d{2}):(\d{2}(?:[.,]\d+)?)$/); // hh:mm:ss.fff
    if (m) return +m[1] * 3600 + +m[2] * 60 + Number(m[3].replace(',', '.'));
  }
  return NaN;
}
export function tableToDataset(header, rows, name, kind) {
  rows = rows.filter((r) => r && r.some((c) => c !== '' && c != null));
  if (rows.length < 2) throw Error('The table needs a header and at least two data rows.');
  const ncols = Math.max(header.length, ...rows.slice(0, 200).map((r) => r.length));
  header = Array.from({ length: ncols }, (_, i) => String(header[i] ?? '').trim() || `Channel ${i + 1}`);
  const sample = rows.length > 2000 ? rows.filter((_, i) => i % Math.ceil(rows.length / 2000) === 0) : rows;
  const numericRatio = (i) => {
    let ok = 0, n = 0;
    for (const r of sample) { const v = r[i]; if (v === '' || v == null) continue; n++; if (Number.isFinite(toNumber(v))) ok++; }
    return n ? ok / n : 0;
  };
  // time column: name match, or Date-typed / parseable datetime column
  let timeCol = header.findIndex((h) => TIME_RE.test(h.replace(/\[.*?\]/g, '').trim()));
  if (timeCol < 0) {
    timeCol = header.findIndex((_, i) => {
      const vals = sample.map((r) => r[i]).filter((v) => v !== '' && v != null);
      return vals.length && vals.every((v) => v instanceof Date || (typeof v === 'string' && /\d[-/:]\d/.test(v) && Number.isFinite(toTime(v))));
    });
  }
  let t, sampleInfo, timeIsDate = false;
  if (timeCol >= 0) {
    t = rows.map((r) => toTime(r[timeCol]));
    const fin = t.filter(Number.isFinite);
    if (fin.length < rows.length * 0.5) { t = rows.map((_, i) => i); timeCol = -1; sampleInfo = 'Row index (time column not parseable)'; }
    else {
      timeIsDate = fin[0] > 1e8; // epoch-like → relative seconds
      const t0 = timeIsDate ? fin[0] : 0;
      t = t.map((v, i) => (Number.isFinite(v) ? (timeIsDate ? Math.round((v - t0) * 1e6) / 1e6 : v) : i));
      sampleInfo = `From "${header[timeCol]}" column` + (timeIsDate ? ` (relative to ${new Date(t0 * 1000).toISOString()})` : '');
    }
  } else { t = rows.map((_, i) => i); sampleInfo = 'Row index (no time column)'; }
  const inds = header.map((_, i) => i).filter((i) => i !== timeCol && numericRatio(i) >= 0.8);
  // drop pure row-id columns (id / index / rowid counting 1,2,3…) when other channels exist
  const isId = (i) => /^(id|index|idx|row|rowid|no|nr|#|sl\.?\s*no)$/i.test(header[i]) && rows.every((r, k) => k === 0 || toNumber(r[i]) - toNumber(rows[k - 1][i]) === 1);
  if (inds.some((i) => !isId(i))) for (let k = inds.length - 1; k >= 0; k--) if (isId(inds[k])) inds.splice(k, 1);
  if (!inds.length) throw Error('No numeric data channels found. Columns: ' + header.join(', '));
  const units = [], names = inds.map((i) => {
    const m = header[i].match(/^(.*?)\s*[[(]([^\])]{1,12})[\])]\s*$/);
    units.push(m ? m[2] : '');
    return m ? m[1] : header[i];
  });
  const data = inds.map((i) => rows.map((r) => toNumber(r[i])));
  return { name, kind, names, t, data, units, sampleInfo };
}

// ---------- delimited text ----------
export function parseDelimited(text, name, kind = 'Imported CSV') {
  text = text.replace(/^﻿/, '');
  let lines = text.split(/\r?\n/);
  // drop comment/preamble lines (#, //, ;) at the top
  while (lines.length && (/^\s*(#|\/\/|%)/.test(lines[0]) || !lines[0].trim())) lines.shift();
  lines = lines.filter((l) => l.trim());
  const probe = lines.slice(0, 50);
  const cands = ['\t', ';', ',', '|'];
  let delim = null, best = 0;
  for (const d of cands) {
    const counts = probe.map((l) => splitLine(l, d).length);
    const c = counts[Math.min(1, counts.length - 1)];
    const consistent = counts.filter((x) => x === c).length / counts.length;
    const score = c * consistent * (counts[0] === c ? 1 : 0.25);
    if (c > 1 && consistent >= 0.8 && score > best) { best = score; delim = d; }
  }
  const split = delim ? (l) => splitLine(l, delim) : (l) => l.trim().split(/\s+/);
  let rows = lines.map(split);
  // header detection: first row mostly non-numeric
  const first = rows[0];
  const isHeader = first.filter((c) => !Number.isFinite(toNumber(c))).length >= first.length / 2;
  let header = isHeader ? first : first.map((_, i) => (i === 0 ? 'Time' : `Channel ${i}`));
  if (isHeader) rows = rows.slice(1);
  // optional units row right below header
  if (rows.length && rows[0].every((c) => !c || (!Number.isFinite(toNumber(c)) && c.length <= 12)) && rows[0].some((c) => c)) {
    const u = rows.shift();
    header = header.map((h, i) => (u[i] ? `${h} [${u[i].replace(/[[\]()]/g, '')}]` : h));
  }
  if (!isHeader) {
    const mono = rows.every((r, i) => i === 0 || toNumber(r[0]) >= toNumber(rows[i - 1][0]));
    if (!mono) header = first.map((_, i) => `Channel ${i + 1}`);
  }
  return tableToDataset(header, rows, name, kind);
}
function splitLine(s, d) {
  const out = []; let cur = '', q = false;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (ch === '"') { if (q && s[j + 1] === '"') { cur += '"'; j++; } else q = !q; }
    else if (ch === d && !q) { out.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// ---------- Excel / ODS ----------
async function parseExcel(buf, name) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: false, cellNF: true });
  const sheets = wb.SheetNames.filter((n) => {
    const ws = wb.Sheets[n]; return ws && ws['!ref'];
  });
  if (!sheets.length) throw Error('Workbook has no data sheets.');
  const sheet = await choose('Select worksheet', sheets, name);
  const ws = wb.Sheets[sheet];
  // exact date conversion from Excel serial numbers (keeps millisecond precision)
  for (const k in ws) {
    const c = ws[k];
    if (k[0] !== '!' && c && c.t === 'n' && c.z && XLSX.SSF.is_date(c.z)) c.v = new Date(Math.round((c.v - 25569) * 864e5));
  }
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
  // skip leading empty / title rows: header = first row with >= 2 non-empty cells
  let h = aoa.findIndex((r) => r.filter((c) => c !== '').length >= 2);
  if (h < 0) throw Error('Sheet is empty.');
  let header = aoa[h].map(String), rows = aoa.slice(h + 1);
  if (header.every((c) => Number.isFinite(toNumber(c)))) { rows = aoa.slice(h); header = header.map((_, i) => `Channel ${i + 1}`); }
  return tableToDataset(header, rows, `${name} › ${sheet}`, 'Excel');
}

// ---------- TDMS ----------
async function parseTdms(buf, name) {
  const chans = [...parseTdmsChannels(buf).values()].filter((c) => c.name && c.data && c.data.length && c.type !== 0x20);
  if (!chans.length) throw Error('TDMS file contains no numeric channels.');
  const groups = [...new Set(chans.map((c) => c.group))];
  const group = await choose('Select TDMS group', groups, name);
  const gc = chans.filter((c) => c.group === group);
  const timeCh = gc.find((c) => c.type === 0x44 || TIME_RE.test(c.name));
  const sig = gc.filter((c) => c !== timeCh);
  if (!sig.length) throw Error('Group has no data channels.');
  const n = Math.max(...sig.map((c) => c.data.length));
  let t, info;
  if (timeCh) {
    const t0 = timeCh.data[0] > 1e8 ? timeCh.data[0] : 0;
    t = Array.from({ length: n }, (_, i) => (i < timeCh.data.length ? timeCh.data[i] - t0 : NaN));
    info = `From TDMS channel "${timeCh.name}"`;
  } else {
    const ref = sig.find((c) => c['prop:wf_increment']);
    const dt = ref ? Number(ref['prop:wf_increment']) : 0;
    const x0 = ref ? Number(ref['prop:wf_start_offset'] || 0) : 0;
    t = Array.from({ length: n }, (_, i) => (dt ? x0 + i * dt : i));
    info = dt ? `Waveform timing wf_increment = ${dt} s` : 'Sample index (no timing info)';
  }
  return {
    name: `${name} › ${group}`, kind: 'TDMS',
    names: sig.map((c) => c.name),
    units: sig.map((c) => String(c['prop:unit_string'] || c['prop:NI_UnitDescription'] || '')),
    t, data: sig.map((c) => Array.from({ length: n }, (_, i) => (i < c.data.length ? Number(c.data[i]) : NaN))),
    sampleInfo: info,
  };
}

// ---------- MS Access ----------
async function parseAccess(buf, name) {
  const db = new MDBReader(Buffer.from(buf));
  const tables = db.getTableNames();
  if (!tables.length) throw Error('Access database has no user tables.');
  const tn = await choose('Select Access table', tables, name);
  const table = db.getTable(tn);
  const cols = table.getColumnNames();
  const rows = table.getData().map((r) => cols.map((c) => r[c]));
  return tableToDataset(cols, rows, `${name} › ${tn}`, 'MS Access');
}

// ---------- SQLite / SQL dump ----------
let SQL;
async function sqlEngine() {
  if (!SQL) SQL = await initSqlJs({ wasmBinary: sqlWasm });
  return SQL;
}
function sanitizeDump(sql) {
  return sql
    .replace(/\/\*![\s\S]*?\*\/;?/g, '') // MySQL conditional comments
    .replace(/^\s*(LOCK|UNLOCK|SET|USE|DELIMITER|START TRANSACTION|COMMIT|BEGIN|GO)\b[^;]*;?/gim, '')
    .replace(/`/g, '"')
    .replace(/\)\s*(ENGINE|DEFAULT CHARSET|AUTO_INCREMENT|CHARSET|COLLATE)[^;]*;/gi, ');')
    .replace(/\b(UNSIGNED|AUTO_INCREMENT|IDENTITY\(\d+,\s*\d+\))\b/gi, '')
    .replace(/\[([^\]]+)\]/g, '"$1"') // SQL Server brackets
    .replace(/\b(KEY|INDEX|UNIQUE KEY)\s+"[^"]*"\s*\([^)]*\),?/gi, '')
    .replace(/,\s*\)/g, ')');
}
async function parseSqlite(db, name, kind) {
  const res = db.exec("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name");
  const tables = res.length ? res[0].values.map((v) => v[0]) : [];
  if (!tables.length) throw Error('No tables found in database.');
  const choice = await choose('Select table (or type a SELECT query)', tables, name, true);
  const q = /^\s*(select|with)\b/i.test(choice) ? choice : `SELECT * FROM "${choice.replace(/"/g, '""')}"`;
  const out = db.exec(q);
  if (!out.length) throw Error('Query returned no rows.');
  return tableToDataset(out[0].columns, out[0].values, `${name} › ${/^\s*select/i.test(choice) ? 'query' : choice}`, kind);
}
async function parseSqliteFile(buf, name) {
  const S = await sqlEngine();
  return parseSqlite(new S.Database(new Uint8Array(buf)), name, 'SQLite');
}
async function parseSqlDump(text, name) {
  const S = await sqlEngine(); const db = new S.Database();
  try { db.run(text); } catch (e1) {
    try { db.close(); } catch {}
    const db2 = new S.Database();
    try { db2.run(sanitizeDump(text)); } catch (e2) { throw Error('Could not execute SQL script: ' + e2.message); }
    return parseSqlite(db2, name, 'SQL');
  }
  return parseSqlite(db, name, 'SQL');
}

// ---------- JSON ----------
function parseJson(text, name) {
  let j = JSON.parse(text);
  if (!Array.isArray(j)) {
    const arr = Object.values(j).find(Array.isArray);
    if (arr && typeof arr[0] === 'object') j = arr;
    else { // {col:[...], col2:[...]}
      const cols = Object.keys(j).filter((k) => Array.isArray(j[k]));
      const n = Math.max(...cols.map((k) => j[k].length));
      return tableToDataset(cols, Array.from({ length: n }, (_, i) => cols.map((k) => j[k][i])), name, 'JSON');
    }
  }
  if (Array.isArray(j[0])) return tableToDataset(j[0], j.slice(1), name, 'JSON');
  const cols = [...new Set(j.flatMap((o) => Object.keys(o)))];
  return tableToDataset(cols, j.map((o) => cols.map((c) => o[c])), name, 'JSON');
}

// ---------- dispatcher ----------
export async function importFile(file) {
  const name = file.name, ext = (name.split('.').pop() || '').toLowerCase();
  const buf = await file.arrayBuffer();
  const head = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
  const magic = String.fromCharCode(...head);
  if (magic.startsWith('TDSm')) return parseTdms(buf, name);
  if (magic.startsWith('SQLite format 3')) return parseSqliteFile(buf, name);
  if (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0 && /Standard (Jet|ACE) DB/.test(String.fromCharCode(...new Uint8Array(buf, 4, 16)))) return parseAccess(buf, name);
  if (magic.startsWith('PK') || (head[0] === 0xd0 && head[1] === 0xcf)) return parseExcel(buf, name);
  const text = new TextDecoder().decode(buf);
  switch (ext) {
    case 'tdms': return parseTdms(buf, name);
    case 'mdb': case 'accdb': return parseAccess(buf, name);
    case 'db': case 'sqlite': case 'sqlite3': case 'db3': return parseSqliteFile(buf, name);
    case 'xlsx': case 'xlsm': case 'xlsb': case 'xls': case 'ods': return parseExcel(buf, name);
    case 'sql': return parseSqlDump(text, name);
    case 'json': return parseJson(text, name);
    case 'txt': case 'dat': case 'log': return parseDelimited(text, name, 'Text');
    default:
      if (/^\s*[[{]/.test(text)) return parseJson(text, name);
      if (/^\s*(create|insert|--|begin)/i.test(text)) return parseSqlDump(text, name);
      if (/<table|<\?xml|<html/i.test(text.slice(0, 2000))) return parseExcel(buf, name); // HTML/XML spreadsheet
      return parseDelimited(text, name, ext === 'tsv' ? 'TSV' : 'Imported CSV');
  }
}

// ---------- chooser dialog ----------
function choose(title, options, fileName, allowQuery = false) {
  if (options.length === 1 && !allowQuery) return Promise.resolve(options[0]);
  return new Promise((resolve, reject) => {
    const ov = document.createElement('div');
    ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,8,14,.72);display:flex;align-items:center;justify-content:center;font-family:inherit';
    ov.innerHTML = `<div style="background:#0d1722;border:1px solid #23415a;border-radius:14px;padding:20px;min-width:min(420px,92vw);max-width:92vw;color:#d9e7f2;box-shadow:0 20px 60px rgba(0,0,0,.6)">
      <div style="font-size:11px;letter-spacing:.12em;color:#58e0e0">IMPORT · ${esc(fileName)}</div>
      <h3 style="margin:6px 0 12px">${esc(title)}</h3>
      <select size="${Math.min(10, Math.max(3, options.length))}" style="width:100%;background:#08111a;color:#d9e7f2;border:1px solid #23415a;border-radius:8px;padding:6px">${options.map((o, i) => `<option ${i ? '' : 'selected'}>${esc(o)}</option>`).join('')}</select>
      ${allowQuery ? '<textarea placeholder="Optional: SELECT ... query" style="width:100%;margin-top:10px;height:60px;background:#08111a;color:#d9e7f2;border:1px solid #23415a;border-radius:8px;padding:6px;box-sizing:border-box"></textarea>' : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button data-x style="padding:8px 14px;border-radius:8px;border:1px solid #23415a;background:transparent;color:#d9e7f2;cursor:pointer">Cancel</button>
        <button data-ok style="padding:8px 14px;border-radius:8px;border:0;background:#58e0e0;color:#04121a;font-weight:700;cursor:pointer">Load</button></div></div>`;
    document.body.appendChild(ov);
    const sel = ov.querySelector('select'), ta = ov.querySelector('textarea');
    const done = (v) => { ov.remove(); v == null ? reject(Object.assign(Error('Import cancelled'), { cancelled: true })) : resolve(v); };
    ov.querySelector('[data-x]').onclick = () => done(null);
    ov.querySelector('[data-ok]').onclick = () => done(ta && ta.value.trim() ? ta.value.trim() : sel.value);
    sel.ondblclick = () => done(sel.value);
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- wire into the analyzer (capture phase → original handler not run) ----------
function install() {
  const input = document.getElementById('fileInput');
  if (!input) return;
  input.setAttribute('accept', ACCEPT);
  const lbl = input.closest('label');
  if (lbl) for (const n of lbl.childNodes) if (n.nodeType === 3 && /Open CSV/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace('Open CSV', 'Open Data');
  if (lbl) lbl.title = 'Excel, CSV, TXT, TDMS, MS Access, SQLite, SQL, JSON';
  input.addEventListener('change', async (e) => {
    e.stopImmediatePropagation();
    const f = e.target.files[0];
    if (!f) return;
    await loadFile(f);
    e.target.value = '';
  }, true);
  // drag & drop anywhere
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
}
async function loadFile(f) {
  const badge = document.getElementById('fileBadge');
  const prev = badge && badge.textContent;
  if (badge) badge.textContent = '● LOADING ' + f.name.toUpperCase() + '…';
  try {
    const d = await importFile(f);
    window.loadData(d);
    if (typeof window.navigate === 'function') window.navigate('overview');
  } catch (err) {
    if (badge) badge.textContent = prev;
    if (!err.cancelled) alert('Unable to import ' + f.name + ': ' + err.message);
  }
}
window.AnalyzerImport = { importFile, parseDelimited, tableToDataset, loadFile, accept: ACCEPT };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
