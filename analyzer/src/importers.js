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
import { readTdms } from './tdms.js';
import { parseNumericTable } from './fastcsv.js';
import { state, compactFull, makeView, fullStats, rateInfo, fmtRate, fmtTime, windowByTime, exportWindowCsv } from './bigdata.js';
import { installBar, refreshBar, setProgress } from './ui.js';

const TIME_RE = /^(time|time[ _]?\(?s\)?|time_s|timestamp|datetime|date[ _]?time|date|seconds|sec|t|zeit|elapsed|elapsed[ _]?time|time[ _]?stamp)$/i;
const ACCEPT = '.csv,.tsv,.txt,.dat,.log,.lvm,.xlsx,.xlsm,.xlsb,.xls,.ods,.tdms,.mdb,.accdb,.db,.sqlite,.sqlite3,.db3,.sql,.json';

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
  const { timeCol: tc, inds } = detectColumns(header, sample);
  let timeCol = tc;
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
  inds.splice(0, inds.length, ...inds.filter((i) => i !== timeCol));
  const units = inds.map((i) => splitUnits(header[i])[1]), names = inds.map((i) => splitUnits(header[i])[0]);
  const data = inds.map((i) => Float64Array.from(rows, (r) => toNumber(r[i])));
  return { name, kind, names, t: Float64Array.from(t), data, units, sampleInfo };
}
function splitUnits(h) { const m = h.match(/^(.*?)\s*[[(]([^\])]{1,12})[\])]\s*$/); return m ? [m[1], m[2]] : [h, '']; }
function detectColumns(header, sample) {
  const numericRatio = (i) => {
    let ok = 0, n = 0;
    for (const r of sample) { const v = r[i]; if (v === '' || v == null) continue; n++; if (Number.isFinite(toNumber(v))) ok++; }
    return n ? ok / n : 0;
  };
  let timeCol = header.findIndex((h) => TIME_RE.test(h.replace(/\[.*?\]|\(.*?\)/g, '').trim()));
  if (timeCol < 0) {
    timeCol = header.findIndex((_, i) => {
      const vals = sample.map((r) => r[i]).filter((v) => v !== '' && v != null);
      return vals.length && vals.every((v) => v instanceof Date || (typeof v === 'string' && /\d[-/:]\d/.test(v) && Number.isFinite(toTime(v))));
    });
  }
  const inds = header.map((_, i) => i).filter((i) => i !== timeCol && numericRatio(i) >= 0.8);
  const isId = (i) => /^(id|index|idx|row|rowid|no|nr|#|sl\.?\s*no)$/i.test(header[i]) && sample.every((r, k) => k === 0 || toNumber(r[i]) - toNumber(sample[k - 1][i]) >= 1);
  if (inds.some((i) => !isId(i))) for (let k = inds.length - 1; k >= 0; k--) if (isId(inds[k])) inds.splice(k, 1);
  return { timeCol, inds };
}

// ---------- delimited text ----------
const FAST_BYTES = 4e6; // above this size use the byte-level numeric parser
export async function parseDelimited(input, name, kind = 'Imported CSV', progress) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // split the head of the file into lines with their byte offsets
  const headLen = Math.min(bytes.length, 512 * 1024), dec = new TextDecoder();
  const lines = []; let st = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  for (let i = st; i < headLen; i++) if (bytes[i] === 10) { lines.push({ off: st, s: dec.decode(bytes.subarray(st, i)).replace(/\r$/, '') }); st = i + 1; if (lines.length > 400) break; }
  if (lines.length <= 400 && st < headLen) lines.push({ off: st, s: dec.decode(bytes.subarray(st, headLen)).replace(/\r$/, '') });
  // preamble: comments, blank lines and "key: value" metadata lines before the table
  let k = 0; const meta = [];
  const isNumRow = (l) => l.trim().split(/[\s,;|\t]+/).filter(Boolean).every((c) => Number.isFinite(toNumber(c)));
  while (k < lines.length && (!lines[k].s.trim() || /^\s*(#|\/\/|%|;)/.test(lines[k].s))) meta.push(lines[k++].s);
  let eoh = -1; lines.forEach((l, i) => { if (/^\*\*\*End_of_Header\*\*\*/.test(l.s)) eoh = i; }); // LabVIEW LVM
  if (eoh >= 0) { for (let i = k; i <= eoh; i++) meta.push(lines[i].s); k = eoh + 1; }
  const body = lines.slice(k).filter((l) => l.s.trim() && !/^\s*(#|\/\/|%)/.test(l.s));
  const probe = body.slice(0, 60).map((l) => l.s);
  let delim = null, best = 0;
  for (const d of ['\t', ';', ',', '|']) {
    const counts = probe.slice(-40).map((l) => splitLine(l, d).length);
    const c = counts[Math.floor(counts.length / 2)] || 0;
    const consistent = counts.filter((x) => x === c).length / (counts.length || 1);
    // a header line among the first lines must split into the same number of fields
    const hdr = probe.slice(0, 12).filter((l) => !isNumRow(l));
    const score = c * consistent * (!hdr.length || hdr.some((l) => splitLine(l, d).length === c) ? 1 : 0.2);
    if (c > 1 && consistent >= 0.8 && score > best) { best = score; delim = d; }
  }
  const split = delim ? (l) => splitLine(l, delim) : (l) => l.trim().split(/\s+/);
  // table start: first line whose field count matches the data rows (skips "key: value" preambles)
  const dataCount = split(probe[probe.length - 1] || '').length;
  let h = 0;
  while (h < body.length - 2 && (split(body[h].s).length !== dataCount || (!isNumRow(body[h].s) && split(body[h + 1].s).length !== dataCount))) { meta.push(body[h].s); h++; }
  const first = split(body[h].s);
  const isHeader = first.filter((c) => !Number.isFinite(toNumber(c))).length >= first.length / 2;
  let header = isHeader ? first : first.map((_, i) => `Channel ${i + 1}`);
  let dataLine = isHeader ? h + 1 : h;
  const u = body[dataLine] && split(body[dataLine].s);
  if (isHeader && u && u.every((c) => !c || (!Number.isFinite(toNumber(c)) && c.length <= 12)) && u.some((c) => c) && !u.some((c) => /\d[-/:]\d/.test(c))) {
    header = header.map((x, i) => (u[i] ? `${x} [${u[i].replace(/[[\]()]/g, '')}]` : x)); dataLine++;
  }
  const fsMeta = sampleRateFromMeta(meta);
  if (!body[dataLine]) throw Error('No data rows found.');
  if (bytes.length < FAST_BYTES) {
    const all = dec.decode(bytes.subarray(body[dataLine].off)).split(/\r?\n/).filter((l) => l.trim()).map(split);
    if (!isHeader && all.length > 1 && all.every((r, i) => i === 0 || toNumber(r[0]) > toNumber(all[i - 1][0]))) header = header.map((x, i) => (i === 0 ? 'Time' : `Channel ${i}`));
    const d = tableToDataset(header, all, name, kind);
    return applyMetaRate(d, fsMeta);
  }
  // ---- fast path for large files ----
  const sampleRows = body.slice(dataLine, dataLine + 60).map((l) => split(l.s));
  if (!isHeader && sampleRows.every((r, i) => i === 0 || toNumber(r[0]) > toNumber(sampleRows[i - 1][0]))) header = header.map((x, i) => (i === 0 ? 'Time' : `Channel ${i}`));
  const { timeCol, inds } = detectColumns(header, sampleRows);
  const decComma = delim !== ',' && sampleRows.some((r) => r.some((c) => /^-?\d+,\d+$/.test(c)));
  const delimCode = delim ? delim.charCodeAt(0) : -1;
  const slowCell = (col, b, s, e) => { const txt = dec.decode(b.subarray(s, e)).replace(/^"|"$/g, ''); return col === timeCol ? toTime(txt) : toNumber(txt); };
  const cols = await parseNumericTable(bytes, body[dataLine].off, header.length, delimCode, decComma, slowCell, progress);
  let t, info;
  if (timeCol >= 0) {
    t = cols[timeCol]; const t0 = t[0] > 1e8 ? t[0] : 0;
    if (t0) for (let i = 0; i < t.length; i++) t[i] = Math.round((t[i] - t0) * 1e6) / 1e6;
    info = `From "${header[timeCol]}" column` + (t0 ? ` (relative to ${new Date(t0 * 1000).toISOString()})` : '');
  } else { t = new Float64Array(cols[0].length); for (let i = 0; i < t.length; i++) t[i] = i; info = 'Row index (no time column)'; }
  return applyMetaRate({ name, kind, names: inds.map((i) => splitUnits(header[i])[0]), units: inds.map((i) => splitUnits(header[i])[1]), t, data: inds.map((i) => cols[i]), sampleInfo: info }, fsMeta);
}
function sampleRateFromMeta(meta) {
  for (const l of meta) {
    let m = l.match(/(sample|sampling|scan)\s*rate[^\d]*([\d.]+)\s*(k|m)?\s*(hz|s\/s|sps)?/i);
    if (m) return Number(m[2]) * (/k/i.test(m[3] || '') ? 1e3 : /m/i.test(m[3] || '') ? 1e6 : 1);
    m = l.match(/(delta[\s_]*t|dt|sample\s*interval|increment)\s*[:=,;\t]\s*([\d.eE+-]+)/i);
    if (m && Number(m[2]) > 0) return 1 / Number(m[2]);
  }
  return 0;
}
function applyMetaRate(d, fs) {
  if (fs > 0 && /Row index/.test(d.sampleInfo)) { for (let i = 0; i < d.t.length; i++) d.t[i] = i / fs; d.sampleInfo = `Sample rate ${fmtRate(fs)} from file header`; }
  return d;
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
async function parseTdms(buf, name, progress) {
  const { channels } = await readTdms(buf, progress);
  if (!channels.length) throw Error('TDMS file contains no numeric channels.');
  const groups = [...new Set(channels.map((c) => c.group))];
  const labels = groups.map((g) => { const cs = channels.filter((c) => c.group === g); return `${g}  (${cs.length} ch × ${Math.max(...cs.map((c) => c.data.length)).toLocaleString()} samples)`; });
  const group = groups[labels.indexOf(await choose('Select TDMS group', labels, name))];
  const gc = channels.filter((c) => c.group === group);
  const timeCh = gc.find((c) => c.isTime || TIME_RE.test(c.name.replace(/\[.*?\]|\(.*?\)/g, '').trim()));
  let sig = gc.filter((c) => c !== timeCh);
  if (!sig.length) throw Error('Group has no data channels.');
  const n = Math.max(...sig.map((c) => c.data.length));
  let t, info;
  if (timeCh) {
    t = new Float64Array(n); const t0 = timeCh.data[0] > 1e8 ? timeCh.data[0] : 0;
    for (let i = 0; i < n; i++) t[i] = i < timeCh.data.length ? timeCh.data[i] - t0 : NaN;
    info = `From TDMS channel "${timeCh.name}"`;
  } else {
    const ref = sig.find((c) => c.props.wf_increment);
    const dt = ref ? Number(ref.props.wf_increment) : 0, x0 = ref ? Number(ref.props.wf_start_offset || 0) : 0;
    t = new Float64Array(n); for (let i = 0; i < n; i++) t[i] = dt ? x0 + i * dt : i;
    info = dt ? `Waveform timing ${fmtRate(1 / dt)} (wf_increment ${dt} s)` : 'Sample index (no timing info)';
    if (ref && typeof ref.props.wf_start_time === 'number' && ref.props.wf_start_time > 0) info += ` · start ${new Date(ref.props.wf_start_time * 1000).toISOString()}`;
  }
  const pad = (d) => { if (d.length === n) return d; const o = new Float64Array(n).fill(NaN); o.set(d); return o; };
  return {
    name: `${name} › ${group}`, kind: 'TDMS', names: sig.map((c) => c.name),
    units: sig.map((c) => String(c.props.unit_string || c.props.NI_UnitDescription || '')),
    t, data: sig.map((c) => pad(c.data)), sampleInfo: info,
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
export async function importFile(file, progress) {
  const name = file.name, ext = (name.split('.').pop() || '').toLowerCase();
  if (progress) await progress(0, 'Reading file');
  const buf = await file.arrayBuffer();
  const prog = progress && ((f) => progress(f, 'Parsing'));
  const head = new Uint8Array(buf, 0, Math.min(16, buf.byteLength));
  const magic = String.fromCharCode(...head);
  if (magic.startsWith('TDSm')) return parseTdms(buf, name, prog);
  if (magic.startsWith('SQLite format 3')) return parseSqliteFile(buf, name);
  if (head[0] === 0 && head[1] === 1 && head[2] === 0 && head[3] === 0 && /Standard (Jet|ACE) DB/.test(String.fromCharCode(...new Uint8Array(buf, 4, 16)))) return parseAccess(buf, name);
  if (magic.startsWith('PK') || (head[0] === 0xd0 && head[1] === 0xcf)) return parseExcel(buf, name);
  const bytes = new Uint8Array(buf);
  const text = () => new TextDecoder().decode(bytes);
  const start = new TextDecoder().decode(bytes.subarray(0, 2000));
  switch (ext) {
    case 'tdms': return parseTdms(buf, name, prog);
    case 'mdb': case 'accdb': return parseAccess(buf, name);
    case 'db': case 'sqlite': case 'sqlite3': case 'db3': return parseSqliteFile(buf, name);
    case 'xlsx': case 'xlsm': case 'xlsb': case 'xls': case 'ods': return parseExcel(buf, name);
    case 'sql': return parseSqlDump(text(), name);
    case 'json': return parseJson(text(), name);
    case 'txt': case 'dat': case 'log': case 'lvm': return parseDelimited(bytes, name, ext === 'lvm' ? 'LabVIEW LVM' : 'Text', prog);
    default:
      if (/^\s*[[{]/.test(start)) return parseJson(text(), name);
      if (/^\s*(create|insert|--|begin)/i.test(start)) return parseSqlDump(text(), name);
      if (/<table|<\?xml|<html/i.test(start)) return parseExcel(buf, name);
      return parseDelimited(bytes, name, ext === 'tsv' ? 'TSV' : 'Imported CSV', prog);
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

// ---------- wire into the analyzer (capture phase → original CSV handler not run) ----------
function install() {
  const input = document.getElementById('fileInput');
  if (!input) return;
  input.setAttribute('accept', ACCEPT);
  const lbl = input.closest('label');
  if (lbl) for (const n of lbl.childNodes) if (n.nodeType === 3 && /Open CSV/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace('Open CSV', 'Open Data');
  if (lbl) lbl.title = 'Excel, CSV, TXT, LVM, TDMS, MS Access, SQLite, SQL, JSON';
  input.addEventListener('change', async (e) => {
    e.stopImmediatePropagation();
    const f = e.target.files[0];
    if (!f) return;
    await loadFile(f);
    e.target.value = '';
  }, true);
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f && !(input.disabled)) loadFile(f); });
  installBar(api);
  // the reference "Reset Demo" / demo loaders call loadData directly → drop the big-data record
  const orig = window.loadData;
  window.loadData = function (d) { if (!d || !d.__view) { state.full = null; refreshBar(api); } return orig.apply(this, arguments); };
}
async function loadFile(f) {
  const badge = document.getElementById('fileBadge');
  const prev = badge && badge.textContent;
  const t0 = performance.now();
  try {
    const full = compactFull(await importFile(f, (frac, what) => { setProgress(`${what || 'Parsing'} ${f.name} · ${Math.round(frac * 100)}%`); if (badge) badge.textContent = `● LOADING ${Math.round(frac * 100)}%`; return new Promise((r) => setTimeout(r)); }));
    full.loadMs = performance.now() - t0; full.bytes = f.size;
    state.full = full; state.a = 0; state.b = full.t.length;
    showView(true);
    if (typeof window.navigate === 'function') window.navigate('overview');
  } catch (err) {
    if (badge) badge.textContent = prev;
    if (!err.cancelled) alert('Unable to import ' + f.name + ': ' + err.message);
  } finally { setProgress(''); }
}
function showView(resetSelection) {
  const full = state.full; if (!full) return;
  const v = makeView(full, state.a, state.b); v.__view = true;
  let keep = null;
  try { if (!resetSelection) keep = new Set(selected); } catch {}
  window.loadData(v);
  if (keep) try { selected = keep; renderAll(); } catch {}
  const badge = document.getElementById('fileBadge');
  if (badge) badge.textContent = `● ${full.kind.toUpperCase()} · ${full.names.length} CH · ${full.t.length.toLocaleString()} SAMPLES`;
  refreshBar(api);
}
function setWindow(t1, t2) { const [a, b] = windowByTime(state.full, t1, t2); state.a = a; state.b = b; showView(false); }
function setRate(fs) { const t = state.full.t; for (let i = 0; i < t.length; i++) t[i] = i / fs; state.full.sampleInfo = `Sample rate ${fmtRate(fs)} (user set)`; showView(false); }
const api = { state, showView, setWindow, setRate, fullStats, rateInfo, fmtTime, fmtRate, exportWindowCsv };
window.AnalyzerImport = { importFile, parseDelimited, tableToDataset, loadFile, accept: ACCEPT, state, api };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install); else install();
