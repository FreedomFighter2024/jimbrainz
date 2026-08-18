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

/**
 * Poll a transfer while slskd refreshes its counter every `slskdTickMs`.
 *
 * `rateAt(seconds)` gives the instantaneous true rate, so a wobbling transfer can be simulated
 * as well as a perfectly steady one.
 */
function run({ trueRate, rateAt, slskdTickMs, pollMs, seconds, diesAt = Infinity }) {
  const instantaneous = rateAt ?? (() => trueRate);
  const samples = new Map();
  const rates = [];
  let counter = 0, carried = 0, lastUpdate = 0;
  let shown = 0, polls = 0, lastShownAt = null;
  let changes = 0, previousValue = null, firstChangeAt = null, lastChangeAt = null;

  for (let t = 0; t <= seconds * 1000; t += pollMs) {
    // integrate the true rate so a varying transfer produces a realistic byte count
    if (t > 0 && t <= diesAt) carried += instantaneous(t / 1000) * (pollMs / 1000);
    if (t <= diesAt && t - lastUpdate >= slskdTickMs) { counter = Math.floor(carried); lastUpdate = t; }

    const speeds = sampleSpeeds(samples, [{ id: 1, status: 'downloading', bytes_transferred: counter }], t);
    polls++;

    if (speeds.has(1)) {
      shown++; lastShownAt = t; rates.push(speeds.get(1));
      if (speeds.get(1) !== previousValue) {
        changes++;
        if (firstChangeAt === null) firstChangeAt = t;
        lastChangeAt = t;
        previousValue = speeds.get(1);
      }
    }
  }

  const avg = rates.reduce((a, b) => a + b, 0) / (rates.length || 1);
  // how often the displayed figure actually changed, across the span it was changing over
  const span = lastChangeAt !== null && firstChangeAt !== null ? lastChangeAt - firstChangeAt : 0;
  const msPerChange = changes > 1 ? span / (changes - 1) : Infinity;
  return { coverage: shown / polls, avg, lastShownAt, msPerChange, rates };
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

console.log('\nthe figure changes about once a second, not on every poll - it is measured over');
console.log('a one-second window rather than thrown away and recomputed twice a second');
for (const pollMs of [250, 500]) {
  const { msPerChange } = run({ trueRate: MB, rateAt: (s) => MB * (1 + 0.3 * Math.sin(s * 2)),
                                slskdTickMs: 250, pollMs, seconds: 60 });
  check(`polling every ${pollMs}ms -> new figure every`,
    `${Math.round(msPerChange)}ms`, (v) => parseFloat(v) >= 900, '>= 900ms');
}

console.log('\nand a wobbling transfer reads steadier for it - a full second of bytes per');
console.log('reading quantises far less against slskd\'s own counter than half a second does');
{
  const wobbly = (s) => MB * (1 + 0.3 * Math.sin(s * 2));
  const { rates } = run({ rateAt: wobbly, slskdTickMs: 250, pollMs: 500, seconds: 60 });
  const distinct = [...new Set(rates)];
  const spread = (Math.max(...distinct) - Math.min(...distinct)) / MB;
  // the transfer itself swings +/-30%, so the readings should span roughly that and no more -
  // a noisy sampler would overshoot it badly
  check('reported spread across a +/-30% transfer', `${(spread * 100).toFixed(0)}%`,
    (v) => parseFloat(v) <= 75, '<= 75% (the transfer swings 60% peak to peak)');
}

fs.rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} expectation(s) failed\n` : '\nall expectations held\n');
process.exit(failures ? 1 : 0);
