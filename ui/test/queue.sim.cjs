/**
 * The relationship between the tab badge and the review queue.
 *
 * A script for the same reason as speed.sim.cjs: there is no JS test runner here. It earns its
 * place by pinning the bug it was written for - the badge counted albums the queue did not,
 * so the interface reported that an album wanted attention and then had nowhere to point, and
 * no way to clear it.
 *
 * Run it with:  node ui/test/queue.sim.cjs
 */

const { execFileSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');

const UI = path.resolve(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'jimbrainz-queue-'));

execFileSync(path.join(UI, 'node_modules/.bin/tsc'), [
  'src/lib/metadataQueue.ts', '--outDir', OUT, '--module', 'commonjs',
  '--target', 'es2022', '--skipLibCheck', '--moduleResolution', 'node',
], { cwd: UI, stdio: 'inherit' });

const { queueAlbums, isNewImport } = require(path.join(OUT, 'lib/metadataQueue.js'));

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}` +
              (ok ? '' : `  (expected ${JSON.stringify(expected)})`));
}

const album = (over) => ({
  path: over.path, artist: 'A', album: 'B', issues: [], ignored_issues: [],
  needs_attention: false, severity: 0, imported: false, reviewed: false, ...over,
});

// exactly the case that was broken: jimbrainz filed it, its metadata is perfect, nobody looked
const cleanImport = album({ path: 'a/clean', imported: true, reviewed: false });
const withIssues  = album({ path: 'a/broken', issues: ['no_release'], needs_attention: true, severity: 3 });
const seenImport  = album({ path: 'a/seen', imported: true, reviewed: true });
const ordinary    = album({ path: 'a/fine' });

console.log('\na newly imported album is findable even when nothing is wrong with it');
check('counted as a new import', isNewImport(cleanImport), true);
check('in the review queue', queueAlbums([cleanImport, ordinary]).map(a => a.path), ['a/clean']);

console.log('\nthe badge and the queue agree on what is outstanding');
{
  const all = [ordinary, withIssues, cleanImport, seenImport];
  const badge = all.filter(isNewImport).length;          // what the tab shows
  const queue = queueAlbums(all).map(a => a.path);       // what "review" walks
  check('badge count', badge, 1);
  check('every badged album is in the queue',
    all.filter(isNewImport).every(a => queue.includes(a.path)), true);
  check('queue, new first then worst first', queue, ['a/clean', 'a/broken']);
}

console.log('\nonce looked at, a clean import leaves both - which is how the badge reaches zero');
check('reviewed import is not new', isNewImport(seenImport), false);
check('and is not in the queue', queueAlbums([seenImport]).map(a => a.path), []);

console.log('\nnarrowing to one kind of issue is about issues, so a clean import is not one');
check('filtered queue', queueAlbums([cleanImport, withIssues], 'no_release').map(a => a.path), ['a/broken']);

fs.rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} expectation(s) failed\n` : '\nall expectations held\n');
process.exit(failures ? 1 : 0);
