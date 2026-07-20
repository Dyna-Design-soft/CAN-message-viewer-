// Minimal test harness usable both in the browser (test.html) and in Node.
// Collects results; a reporter prints them.

const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

export function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || 'not equal'}\n  expected: ${e}\n  actual:   ${a}`);
}

export function assertClose(actual, expected, eps = 1e-9, msg) {
  if (Math.abs(actual - expected) > eps) {
    throw new Error(`${msg || 'not close'}: expected ${expected}, got ${actual}`);
  }
}

export async function runAll() {
  const results = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  return results;
}

export function summarize(results) {
  const passed = results.filter((r) => r.ok).length;
  return { passed, failed: results.length - passed, total: results.length };
}
