// Streaming-speed numeric parser for large delimited DAQ exports (hundreds of MB).
// Scans raw bytes, parses numbers without creating strings, grows typed arrays.
// Columns that are not numeric fall back to per-cell string parsing via `slowCell`.
export async function parseNumericTable(bytes, startOffset, ncols, delimCode, decimalComma, slowCell, progress) {
  const len = bytes.length;
  let cap = Math.max(1024, Math.ceil(((len - startOffset) / Math.max(4, ncols * 6)) * 1.1));
  if (cap > 2e8) cap = 2e8;
  let cols = Array.from({ length: ncols }, () => new Float64Array(cap));
  let row = 0, i = startOffset, nextYield = i + 16e6;
  const ws = delimCode === -1; // whitespace separated
  const DEC = decimalComma ? 44 : 46;
  while (i < len) {
    // skip blank lines
    let c = bytes[i];
    if (c === 10 || c === 13) { i++; continue; }
    if (row >= cap) { cap = Math.ceil(cap * 1.6); cols = cols.map((a) => { const b = new Float64Array(cap); b.set(a); return b; }); }
    let col = 0;
    if (ws) while (i < len && (bytes[i] === 32 || bytes[i] === 9)) i++;
    while (i < len) {
      // parse one field
      const fs = i;
      let neg = false, val = 0, any = false, frac = 0, scale = 1, exp = 0, expNeg = false, bad = false, quoted = false;
      while (bytes[i] === 32 && !ws) i++;
      if (bytes[i] === 34) { quoted = true; i++; }
      c = bytes[i];
      if (c === 45) { neg = true; i++; } else if (c === 43) i++;
      while (i < len) { c = bytes[i]; if (c >= 48 && c <= 57) { val = val * 10 + (c - 48); any = true; i++; } else break; }
      if (bytes[i] === DEC) { i++; while (i < len) { c = bytes[i]; if (c >= 48 && c <= 57) { scale *= 10; frac = frac * 10 + (c - 48); any = true; i++; } else break; } }
      if (any && (bytes[i] === 101 || bytes[i] === 69)) {
        i++; if (bytes[i] === 45) { expNeg = true; i++; } else if (bytes[i] === 43) i++;
        while (i < len) { c = bytes[i]; if (c >= 48 && c <= 57) { exp = exp * 10 + (c - 48); i++; } else break; }
      }
      if (quoted && bytes[i] === 34) i++;
      while (bytes[i] === 32 && !ws) i++;
      c = bytes[i];
      const end = i >= len || c === 10 || c === 13 || (ws ? c === 32 || c === 9 : c === delimCode);
      if (!end) { bad = true; while (i < len) { c = bytes[i]; if (c === 10 || c === 13 || (ws ? c === 32 || c === 9 : c === delimCode && !quoted)) break; if (c === 34) quoted = !quoted; i++; } }
      if (col < ncols) {
        let v;
        if (bad) v = slowCell(col, bytes, fs, i);
        else if (!any) v = NaN;
        else { v = val + frac / scale; if (exp) v *= Math.pow(10, expNeg ? -exp : exp); if (neg) v = -v; }
        cols[col][row] = v;
      }
      col++;
      c = bytes[i];
      if (i >= len || c === 10 || c === 13) break;
      i++; // delimiter
      if (ws) { while (i < len && (bytes[i] === 32 || bytes[i] === 9)) i++; if (bytes[i] === 10 || bytes[i] === 13) break; }
    }
    for (let k = col; k < ncols; k++) cols[k][row] = NaN;
    row++;
    while (i < len && bytes[i] !== 10) i++;
    i++;
    if (i > nextYield && progress) { nextYield = i + 16e6; await progress(i / len); }
  }
  return cols.map((a) => a.subarray(0, row));
}
