// Pluggable log-file format registry.
//
// Each reader module registers { name, extensions, sniff(bytes), read(file) }.
// `read(file)` receives a File/Blob and resolves to a FrameStore.
// Detection: magic-byte sniff first (more reliable), then file extension.

const formats = [];

export function registerFormat(fmt) {
  formats.push(fmt);
}

export function listFormats() {
  return [...formats];
}

/**
 * Pick a reader for a file.
 * @param {File} file
 * @param {Uint8Array} head first bytes of the file (>= 64 recommended)
 */
export function detectFormat(file, head) {
  for (const f of formats) {
    if (f.sniff && f.sniff(head, file.name)) return f;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  for (const f of formats) {
    if (f.extensions.includes(ext)) return f;
  }
  return null;
}

/** Load a file into a FrameStore using the detected format. */
export async function loadLogFile(file, onProgress) {
  const head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const fmt = detectFormat(file, head);
  if (!fmt) {
    throw new Error(
      `Unsupported file format: "${file.name}". Supported: ` +
        formats.map((f) => f.name).join(', '),
    );
  }
  const store = await fmt.read(file, onProgress);
  return { store, format: fmt.name };
}
