/**
 * The downloads panel's optimistic overlays.
 *
 * A script for the same reason as speed.sim.cjs and queue.sim.cjs: there is no JS test runner
 * here. It earns its place by pinning the behaviour that makes the panel feel responsive at
 * all - clicking cancel or "clear finished" used to change nothing on screen until two
 * sequential round-trips had completed, so the buttons felt disconnected from the app.
 *
 * The interesting cases are all about the prediction being WRONG or SLOW, which is exactly
 * what is hard to reach in a browser: a cancel the server refuses, a cancel it accepts but
 * has not applied yet, and a cancel it never confirms at all.
 *
 * Run it with:  node ui/test/downloads.sim.cjs
 */

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const UI = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'jimbrainz-downloads-'));

execFileSync(path.join(UI, 'node_modules/.bin/tsc'), [
  'src/lib/downloadOverlay.ts', '--outDir', OUT, '--module', 'commonjs',
  '--target', 'es2022', '--skipLibCheck', '--moduleResolution', 'node',
], { cwd: UI, stdio: 'inherit' });

const {
  visibleJobs, activeCount, reconcile, finishedIds, withAdded, withRemoved,
} = require(path.join(OUT, 'lib/downloadOverlay.js'));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}` +
              (ok ? '' : `  (expected ${JSON.stringify(expected)})`));
}

const job = (id, status) => ({ id, status, artist: 'a', album: 'b', username: 'u' });

const overlays = (cancelling = [], cleared = []) => ({
  cancelling: new Set(cancelling),
  cleared: new Set(cleared),
});

const ids = (jobs) => jobs.map((j) => j.id);

/* ========================================================================== */
console.log('\ncancelling: the click has to land before the server answers');

{
  const jobs = [job(1, 'downloading'), job(2, 'queued'), job(3, 'organized')];

  check('active before the click', activeCount(jobs, overlays()), 2);

  //? The instant cancel is pressed on job 1, before any request has returned.
  const pending = overlays([1]);

  check('the row is still listed - the transfer really is still running',
        ids(visibleJobs(jobs, pending)), [1, 2, 3]);
  check('but it stops counting as active, so the badge drops immediately',
        activeCount(jobs, pending), 1);
}

/* ========================================================================== */
console.log('\nreconcile: wait for the DATA to agree, not for the request to return');

{
  const pending = overlays([1]);

  //? The cancel request has returned, but slskd has not transitioned the job yet. The
  //? overlay must survive this poll or the row flips back to "downloading" for one tick.
  const stillRunning = [job(1, 'downloading'), job(2, 'queued')];
  check('kept while the server still reports it active',
        [...reconcile(stillRunning, pending).cancelling], [1]);

  //? Now the server agrees.
  const cancelled = [job(1, 'cancelled'), job(2, 'queued')];
  check('dropped once the status is terminal',
        [...reconcile(cancelled, pending).cancelling], []);

  //? A job that vanished entirely also counts as confirmed.
  check('dropped when the job disappears',
        [...reconcile([job(2, 'queued')], pending).cancelling], []);
}

{
  //? Identity is used to skip re-renders, so nothing-changed must return the SAME object.
  const pending = overlays([1]);
  const jobs = [job(1, 'downloading')];
  check('unchanged reconcile returns the identical object',
        reconcile(jobs, pending) === pending, true);
}

/* ========================================================================== */
console.log('\nclear finished: only the finished ones, and only until the server agrees');

{
  const jobs = [job(1, 'downloading'), job(2, 'organized'), job(3, 'failed'), job(4, 'queued')];

  check('picks the finished jobs, leaving the active ones alone',
        finishedIds(jobs), [2, 3]);

  const cleared = overlays([], finishedIds(jobs));
  check('they vanish from the list immediately',
        ids(visibleJobs(jobs, cleared)), [1, 4]);
  check('the active count is untouched by clearing',
        activeCount(jobs, cleared), 2);

  //? The server has now actually removed them.
  const after = [job(1, 'downloading'), job(4, 'queued')];
  check('the overlay is dropped once they are gone server-side',
        [...reconcile(after, cleared).cleared], []);

  //? If the request failed, the caller rolls back by hand and the rows return.
  const rolledBack = { ...cleared, cleared: withRemoved(cleared.cleared, [2, 3]) };
  check('rollback puts them back', ids(visibleJobs(jobs, rolledBack)), [1, 2, 3, 4]);
}

/* ========================================================================== */
console.log('\nthe prediction must not outlive its usefulness');

{
  //? The safety valve. If the server never confirms, the hook expires the overlay so the
  //? truth reasserts itself - a row stuck on "cancelling…" while the file is still arriving
  //? is a worse lie than never having said it.
  const pending = overlays([1]);
  const jobs = [job(1, 'downloading')];

  check('still active while the overlay stands', activeCount(jobs, pending), 0);

  const expired = { ...pending, cancelling: withRemoved(pending.cancelling, [1]) };
  check('and honest again once it expires', activeCount(jobs, expired), 1);
}

{
  //? Two cancels in flight at once, which is easy to get wrong with a single id.
  const jobs = [job(1, 'downloading'), job(2, 'downloading'), job(3, 'downloading')];
  const both = overlays([1, 3]);

  check('both are excluded from the active count', activeCount(jobs, both), 1);

  const partly = [job(1, 'cancelled'), job(2, 'downloading'), job(3, 'downloading')];
  check('confirming one leaves the other standing',
        [...reconcile(partly, both).cancelling], [3]);
}

{
  //? Adding an id that is already overlaid must not duplicate or disturb the others.
  check('withAdded is idempotent', [...withAdded(new Set([1, 2]), [2, 3])], [1, 2, 3]);
  check('withRemoved ignores absent ids', [...withRemoved(new Set([1, 2]), [3])], [1, 2]);
}

/* ========================================================================== */
console.log(failures ? `\n${failures} expectation(s) FAILED\n` : '\nall expectations held\n');
process.exit(failures ? 1 : 0);
