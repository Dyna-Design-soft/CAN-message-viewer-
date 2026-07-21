// Build a single self-contained dist/canviewer.html: all CSS + JS + vendored
// uPlot inlined, so it opens directly from the filesystem with no server and no
// network. Dev-only; requires esbuild (npm i -D esbuild, or npx esbuild).
//
//   node tools/make-singlefile.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFile(root + p, 'utf8');

async function loadEsbuild() {
  const require = createRequire(import.meta.url);
  for (const spec of ['esbuild', root + 'node_modules/esbuild/lib/main.js']) {
    try {
      return require(spec);
    } catch {}
  }
  throw new Error('esbuild not found. Run:  npm i -D esbuild');
}

const esbuild = await loadEsbuild();

// 1. Bundle the app as an IIFE; --define folds the worker path to dead code.
const { outputFiles } = await esbuild.build({
  entryPoints: [root + 'src/main.js'],
  bundle: true,
  format: 'iife',
  minify: true,
  define: { __SINGLEFILE__: 'true' },
  write: false,
  logLevel: 'warning',
});
if (outputFiles.length !== 1) {
  throw new Error(`expected 1 output chunk, got ${outputFiles.length} (worker not folded?)`);
}
const appJs = outputFiles[0].text;

// 2. Read vendored uPlot + CSS.
const uplotJs = await read('src/graph/uplot.min.js');
const uplotCss = await read('src/graph/uplot.css');
const appCss = await read('css/app.css');

// 3. Take index.html and strip the four external references.
let html = await read('index.html');
html = html
  .replace(/\s*<link rel="stylesheet" href="css\/app\.css">/, '')
  .replace(/\s*<link rel="stylesheet" href="src\/graph\/uplot\.css">/, '')
  .replace(/\s*<script src="src\/graph\/uplot\.min\.js"><\/script>/, '')
  .replace(/\s*<script type="module" src="src\/main\.js"><\/script>/, '')
  // PWA-only tags make no sense in a standalone file:// bundle
  .replace(/\s*<link rel="manifest"[^>]*>/, '')
  .replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '');

// 4. Inline styles into <head> and scripts before </body>.
// NOTE: use function replacers — the JS/CSS contain `$` sequences (e.g. `$\``
// from template literals) that a string replacement would interpret as special
// patterns and corrupt the output.
html = html.replace('</head>', () => `<style>\n${uplotCss}\n${appCss}\n</style>\n</head>`);
html = html.replace(
  '</body>',
  () => `<script>\n${uplotJs}\n</script>\n<script>\n${appJs}\n</script>\n</body>`,
);

await mkdir(root + 'dist', { recursive: true });
await writeFile(root + 'dist/canviewer.html', html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote dist/canviewer.html (${kb} KB)`);
