const HEX = '0123456789ABCDEF';

/** Uint8Array -> "DE AD BE EF" (or without spaces). */
export function bytesToHex(bytes, sep = ' ') {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    if (i && sep) out += sep;
    out += HEX[bytes[i] >> 4] + HEX[bytes[i] & 15];
  }
  return out;
}

/** "DEADBEEF" / "DE AD BE EF" -> Uint8Array. Ignores whitespace. */
export function hexToBytes(str) {
  const clean = str.replace(/\s+/g, '');
  const n = clean.length >> 1;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/** CAN identifier for display: 3 hex digits for standard, 8 for extended. */
export function formatId(id, ext) {
  return '0x' + id.toString(16).toUpperCase().padStart(ext ? 8 : 3, '0');
}
