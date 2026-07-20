// Node test entry: imports all *.test.js, runs, prints, exits non-zero on failure.
import './decoder.test.js';
import './dbc-parser.test.js';
import './asc-reader.test.js';
import './blf.test.js';
import './asc-writer.test.js';
import './tdms.test.js';
import { runAll, summarize } from './test-runner.js';

const results = await runAll();
for (const r of results) {
  console.log(`${r.ok ? '\x1b[32m  ok\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${r.name}`);
  if (!r.ok) console.log(`      ${r.error.replace(/\n/g, '\n      ')}`);
}
const s = summarize(results);
console.log(`\n${s.passed}/${s.total} passed, ${s.failed} failed`);
process.exit(s.failed ? 1 : 0);
