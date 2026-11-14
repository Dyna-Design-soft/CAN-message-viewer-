// Bundles src/importers.js (+ SheetJS, sql.js wasm, mdb-reader, TDMS reader) into analyzer-import.js
import * as esbuild from 'esbuild';
await esbuild.build({
  entryPoints: ['src/importers.js'], outfile: 'analyzer-import.js', bundle: true, format: 'iife', minify: true,
  platform: 'browser', loader: { '.wasm': 'binary' }, inject: ['tools/shim.js'],
  alias: { stream: 'stream-browserify' },
  external: ['fs', 'path', 'crypto', 'node:fs', 'node:crypto', 'node:path'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
});
