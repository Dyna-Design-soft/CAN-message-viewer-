// Fixture loader that works in both the browser (fetch) and Node (fs).

const isNode = typeof process !== 'undefined' && process.versions?.node;

export async function loadFixture(name) {
  if (isNode) {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const dir = fileURLToPath(new URL('./fixtures/', import.meta.url));
    return readFile(dir + name, 'utf8');
  }
  const res = await fetch(new URL(`./fixtures/${name}`, import.meta.url));
  if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
  return res.text();
}
