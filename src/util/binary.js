// Little-endian binary read/write helpers over ArrayBuffer / DataView.

export class BinaryReader {
  constructor(buffer, offset = 0, length) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.pos = offset;
    this.end = length == null ? this.bytes.length : offset + length;
  }

  get remaining() {
    return this.end - this.pos;
  }

  seek(pos) {
    this.pos = pos;
  }

  skip(n) {
    this.pos += n;
  }

  u8() { return this.view.getUint8(this.pos++); }
  i8() { return this.view.getInt8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos, true); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { const v = this.view.getUint32(this.pos, true); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos, true); this.pos += 4; return v; }
  u64() { const v = this.view.getBigUint64(this.pos, true); this.pos += 8; return v; }
  f32() { const v = this.view.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.view.getFloat64(this.pos, true); this.pos += 8; return v; }

  fourcc() {
    const s = String.fromCharCode(
      this.bytes[this.pos], this.bytes[this.pos + 1],
      this.bytes[this.pos + 2], this.bytes[this.pos + 3],
    );
    this.pos += 4;
    return s;
  }

  bytesOf(n) {
    const s = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }

  str(n, encoding = 'utf-8') {
    const s = new TextDecoder(encoding).decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s.replace(/\0.*$/, '');
  }
}

export class BinaryWriter {
  constructor(initial = 1024) {
    this.buf = new ArrayBuffer(initial);
    this.view = new DataView(this.buf);
    this.bytes = new Uint8Array(this.buf);
    this.pos = 0;
  }

  #ensure(n) {
    if (this.pos + n <= this.buf.byteLength) return;
    let cap = this.buf.byteLength;
    while (cap < this.pos + n) cap *= 2;
    const nb = new ArrayBuffer(cap);
    new Uint8Array(nb).set(this.bytes);
    this.buf = nb;
    this.view = new DataView(nb);
    this.bytes = new Uint8Array(nb);
  }

  u8(v) { this.#ensure(1); this.view.setUint8(this.pos++, v); return this; }
  u16(v) { this.#ensure(2); this.view.setUint16(this.pos, v, true); this.pos += 2; return this; }
  u32(v) { this.#ensure(4); this.view.setUint32(this.pos, v >>> 0, true); this.pos += 4; return this; }
  i32(v) { this.#ensure(4); this.view.setInt32(this.pos, v, true); this.pos += 4; return this; }
  u64(v) { this.#ensure(8); this.view.setBigUint64(this.pos, BigInt(v), true); this.pos += 8; return this; }
  f32(v) { this.#ensure(4); this.view.setFloat32(this.pos, v, true); this.pos += 4; return this; }
  f64(v) { this.#ensure(8); this.view.setFloat64(this.pos, v, true); this.pos += 8; return this; }

  fourcc(s) {
    this.#ensure(4);
    for (let i = 0; i < 4; i++) this.bytes[this.pos++] = s.charCodeAt(i);
    return this;
  }

  raw(u8arr) {
    this.#ensure(u8arr.length);
    this.bytes.set(u8arr, this.pos);
    this.pos += u8arr.length;
    return this;
  }

  zeros(n) {
    this.#ensure(n);
    this.pos += n;
    return this;
  }

  align(n) {
    const pad = (n - (this.pos % n)) % n;
    return this.zeros(pad);
  }

  /** Overwrite a u32 at an absolute offset (for back-patching sizes). */
  patchU32(offset, v) {
    this.view.setUint32(offset, v >>> 0, true);
  }

  finish() {
    return this.bytes.subarray(0, this.pos);
  }
}

/** zlib deflate via the browser's native CompressionStream. */
export async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(cs));
  return new Uint8Array(await stream.arrayBuffer());
}

/** zlib inflate via the browser's native DecompressionStream. */
export async function inflate(bytes) {
  const ds = new DecompressionStream('deflate');
  const stream = new Response(new Blob([bytes]).stream().pipeThrough(ds));
  return new Uint8Array(await stream.arrayBuffer());
}
