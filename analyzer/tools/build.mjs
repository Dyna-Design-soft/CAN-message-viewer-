// Builds the standalone single-file app: reference.html (unchanged UI) + bundled importer
// (SheetJS, sql.js wasm, mdb-reader, TDMS / fast CSV readers, large-data engine) inlined.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
const r = await esbuild.build({
  entryPoints: ['src/importers.js'], write: false, bundle: true, format: 'iife', minify: true,
  platform: 'browser', loader: { '.wasm': 'binary' }, inject: ['tools/shim.js'],
  alias: { stream: 'stream-browserify' },
  external: ['fs', 'path', 'crypto', 'node:fs', 'node:crypto', 'node:path'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
});
const js = r.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');
const ref = fs.readFileSync('reference.html', 'utf8');
const i = ref.lastIndexOf('</body>');
fs.writeFileSync('Industrial_Analyzer.html', ref.slice(0, i) + '<script>\n' + js + '\n</script>\n' + ref.slice(i));
console.log('Industrial_Analyzer.html', (fs.statSync('Industrial_Analyzer.html').size / 1048576).toFixed(2), 'MB');
