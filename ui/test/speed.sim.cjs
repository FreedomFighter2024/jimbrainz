/**
 * A simulation harness for lib/speed.ts, the derived download rate.
 *
 * This exists as a plain script rather than a unit test because there is no JS test runner in
 * this project - every test is Python, and adding vitest needs a newer Node than the one this
 * repo currently builds on. It is still worth having checked in: the sampler is the one piece
 * of frontend logic whose failure is silent. A wrong rate looks perfectly plausible on screen,
 * and the bug it was written to catch (the panel showing no speed at all, on and off, during a
 * completely steady transfer) is invisible to any assertion about a single poll.
 *
 * Run it with:  node ui/test/speed.sim.cjs
 * It compiles lib/speed.ts itself and exits non-zero if any expectation fails.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UI = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'jimbrainz-speed-'));

execFileSync(path.join(UI, 'node_modules/.bin/tsc'), [
  'src/lib/speed.ts', '--outDir', OUT, '--module', 'commonjs',
  '--target', 'es2022', '--skipLibCheck', '--moduleResolution', 'node',
], { cwd: UI, stdio: 'inherit' });

const { sampleSpeeds } = require(path.join(OUT, 'lib/speed.js'));

const MB = 1024 * 1024;
let failures = 0;

function check(label, actual, predicate, expectation) {
  const ok = predicate(actual);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}  (expected ${expectation})`);
}

/** Poll a transfer that moves at `trueRate` while slskd refreshes its counter every tick. */
function run({ trueRate, slskdTickMs, pollMs, seconds, diesAt = Infinity }) {
  const samples = new Map();
  const rates = [];
  let counter = 0, lastUpdate = 0, shown = 0, polls = 0, lastShownAt = null;

  for (let t = 0; t <= seconds * 1000; t += pollMs) {
    if (t <= diesAt && t - lastUpdate >= slskdTickMs) {
      counter = Math.floor(trueRate * (Math.min(t, diesAt) / 1000));
      lastUpdate = t;
    }
    const speeds = sampleSpeeds(samples, [{ id: 1, status: 'downloading', bytes_transferred: counter }], t);
    polls++;
    if (speeds.has(1)) { shown++; lastShownAt = t; rates.push(speeds.get(1)); }
  }

  const avg = rates.reduce((a, b) => a + b, 0) / (rates.length || 1);
  return { coverage: shown / polls, avg, lastShownAt };
}

console.log('\nthe rate it reports is the rate the bytes imply');
for (const slskdTickMs of [1000, 2000, 3000, 5000]) {
  const { avg } = run({ trueRate: MB, slskdTickMs, pollMs: 500, seconds: 60 });
  check(`slskd counter every ${slskdTickMs}ms -> error`,
    `${(((avg - MB) / MB) * 100).toFixed(1)}%`, (v) => Math.abs(parseFloat(v)) < 1, '< 1%');
}

console.log('\nit keeps reporting one, even when slskd\'s counter is far coarser than our polling');
for (const slskdTickMs of [1000, 2000, 3000, 5000]) {
  const { coverage } = run({ trueRate: MB, slskdTickMs, pollMs: 500, seconds: 60 });
  check(`slskd counter every ${slskdTickMs}ms -> speed shown on`,
    `${(coverage * 100).toFixed(0)}% of polls`, (v) => parseFloat(v) >= 90, '>= 90%');
}

console.log('\nand it stops claiming one once the transfer really has died - at the same');
console.log('wall-clock deadline whatever the poll cadence is, which is the point of STALE_RATE_MS');
for (const pollMs of [500, 5000]) {
  const { lastShownAt } = run({ trueRate: MB, slskdTickMs: 1000, pollMs, seconds: 40, diesAt: 10000 });
  check(`polling every ${pollMs}ms -> kept claiming a speed for`,
    `${((lastShownAt - 10000) / 1000).toFixed(1)}s after it stopped`,
    (v) => parseFloat(v) <= 7, '<= 7s');
}

fs.rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} expectation(s) failed\n` : '\nall expectations held\n');
process.exit(failures ? 1 : 0);
