/**
 * The search-result ordering.
 *
 * A script for the same reason as the other sims: there is no JS test runner here. It earns
 * its place on the cases that are easy to get wrong and invisible when you do - undated
 * groups, ties, and the difference between "sort by relevance" and "leave alone".
 *
 * Note this loads interface/scripts/sort.mjs directly with a dynamic import. It is a plain ES
 * module with no DOM dependency precisely so it can be run like this - and the .mjs extension
 * is what makes that possible, since Node reads a bare .js as CommonJS. When the search view
 * is ported it moves into ui/src/lib and this switches to the tsc-compile approach the other
 * sims use.
 *
 * Run it with:  node ui/test/sort.sim.cjs
 */

const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(
  path.resolve(__dirname, '../../interface/scripts/sort.mjs')
).href;

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${JSON.stringify(actual)}` +
              (ok ? '' : `  (expected ${JSON.stringify(expected)})`));
}

/** A release group, as MusicBrainz shapes it. */
const group = (title, date, score = 50, artist = 'A') => ({
  id: `${title}-${date}`,
  title,
  score,
  'first-release-date': date,
  'artist-credit': [{ name: artist }],
});

const titles = (list) => list.map((g) => g.title);

(async () => {
  const { sortReleaseGroups, SORT_MODES, DEFAULT_SORT, isSortMode } = await import(MODULE);

  /* ====================================================================== */
  console.log('\nchronological is the default, and it means oldest first');

  {
    const groups = [group('Third', '2008-04-27'), group('Dummy', '1994-08-22'),
                    group('Portishead', '1997-09-29')];

    check('the default id is a real mode', isSortMode(DEFAULT_SORT), true);
    check('default order', titles(sortReleaseGroups(groups, DEFAULT_SORT)),
          ['Dummy', 'Portishead', 'Third']);
    check('newest first reverses it', titles(sortReleaseGroups(groups, 'year_desc')),
          ['Third', 'Portishead', 'Dummy']);
  }

  /* ====================================================================== */
  console.log('\nundated groups sink, whichever way round the sort is');

  {
    //? The bug this pins: reading a missing date as year 0 puts every bootleg MusicBrainz
    //? knows least about at the TOP of "oldest first", burying the actual answer.
    const groups = [group('Bootleg', null), group('Dummy', '1994'), group('Third', '2008')];

    check('oldest first', titles(sortReleaseGroups(groups, 'year_asc')),
          ['Dummy', 'Third', 'Bootleg']);
    check('newest first - still last, not first',
          titles(sortReleaseGroups(groups, 'year_desc')), ['Third', 'Dummy', 'Bootleg']);
  }

  {
    //? An empty string and a malformed date are as absent as null.
    const groups = [group('Blank', ''), group('Junk', 'not-a-date'), group('Real', '1994')];
    check('blank and malformed dates both sink',
          titles(sortReleaseGroups(groups, 'year_asc'))[0], 'Real');
  }

  /* ====================================================================== */
  console.log('\nties break on relevance, then title - so the order is total');

  {
    const groups = [
      group('Zebra', '1994', 40),
      group('Alpha', '1994', 90),
      group('Beta', '1994', 90),
    ];

    check('same year: best match first, then alphabetical',
          titles(sortReleaseGroups(groups, 'year_asc')), ['Alpha', 'Beta', 'Zebra']);
  }

  {
    //? Stability matters: sorting twice must not shuffle equal rows about.
    const groups = [group('B', '1994', 50), group('A', '1994', 50), group('C', '1994', 50)];
    const once = titles(sortReleaseGroups(groups, 'year_asc'));
    const twice = titles(sortReleaseGroups(sortReleaseGroups(groups, 'year_asc'), 'year_asc'));
    check('sorting an already-sorted list changes nothing', twice, once);
  }

  /* ====================================================================== */
  console.log('\nrelevance is a deliberate no-op, not a sort by score');

  {
    //? MusicBrainz already answered in relevance order. Re-sorting by the score field would
    //? only reshuffle the many groups that tie on 100 - see the note in CLAUDE.md about the
    //? first five results all scoring exactly 100.
    const groups = [group('Live', '1996', 100), group('Album', '1991', 100),
                    group('Interview', '1993', 100)];

    check('order is left exactly as it arrived',
          titles(sortReleaseGroups(groups, 'relevance')), ['Live', 'Album', 'Interview']);
    check('an unknown mode also leaves it alone',
          titles(sortReleaseGroups(groups, 'nonsense')), ['Live', 'Album', 'Interview']);
  }

  /* ====================================================================== */
  console.log('\ntitle and artist orders');

  {
    const groups = [group('Vol. 10', '1994'), group('Vol. 2', '1994'), group('Abbey', '1994')];
    //? numeric collation, so 2 comes before 10 rather than after it as a string would
    check('titles sort numerically where they end in numbers',
          titles(sortReleaseGroups(groups, 'title')), ['Abbey', 'Vol. 2', 'Vol. 10']);
  }

  {
    const groups = [
      group('X', '2000', 50, 'Portishead'),
      group('Y', '1990', 50, 'Aphex Twin'),
      group('Z', '1980', 50, 'Portishead'),
    ];
    check('artist first, then chronological within the artist',
          titles(sortReleaseGroups(groups, 'artist')), ['Y', 'Z', 'X']);
  }

  /* ====================================================================== */
  console.log('\nthe caller’s array is never mutated');

  {
    const groups = [group('Third', '2008'), group('Dummy', '1994')];
    const before = titles(groups);
    sortReleaseGroups(groups, 'year_asc');
    check('input order is untouched', titles(groups), before);
  }

  {
    check('every advertised mode is accepted',
          SORT_MODES.map((m) => isSortMode(m.id)), SORT_MODES.map(() => true));
    check('junk in is not a mode', isSortMode('year_sideways'), false);
    check('empty input is fine', sortReleaseGroups(null, 'year_asc'), []);
  }

  console.log(failures ? `\n${failures} expectation(s) FAILED\n` : '\nall expectations held\n');
  process.exit(failures ? 1 : 0);
})();
