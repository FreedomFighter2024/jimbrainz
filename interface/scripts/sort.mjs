/**
 * Ordering for the search results.
 *
 * WHAT THIS SORTS, AND WHAT IT HONESTLY CANNOT
 *
 * MusicBrainz has no sort parameter on a search - it answers in relevance order and that is
 * the only order it will give you. So this reorders THE RESULTS YOU GOT, which is not the
 * same as asking MusicBrainz for the oldest releases by an artist.
 *
 * Concretely: with the limit at 50, sorting by year shows the oldest of the fifty most
 * RELEVANT groups, not the fifty oldest. That distinction is the same one the type filter
 * note in CLAUDE.md is about, and it is why the results summary keeps saying how many groups
 * were returned - the sort rearranges that set, it never widens it. Raising the limit is the
 * only way to reach further back.
 *
 * Pure and free of the DOM so it can be exercised without a browser - see
 * ui/test/sort.sim.cjs. It lives here rather than in ui/src/lib because the search view is
 * still the vanilla half; when that view is ported this module moves across unchanged.
 *
 * The .mjs EXTENSION is load-bearing for the test, not for the browser. Node treats a bare
 * .js file as CommonJS unless a package.json says otherwise, so the sim could not import it;
 * .mjs is unambiguous to Node and serves as text/javascript either way.
 */

/**
 * The orders offered, in the order the dropdown lists them.
 *
 * `id` is persisted in localStorage, so renaming one silently resets the preference for
 * everybody who had chosen it. Add, don't rename.
 */
export const SORT_MODES = [
    { id: 'year_asc', label: 'Year (oldest first)' },
    { id: 'year_desc', label: 'Year (newest first)' },
    { id: 'relevance', label: 'Best match' },
    { id: 'title', label: 'Title (A–Z)' },
    { id: 'artist', label: 'Artist (A–Z)' },
];

/*
  Chronological, oldest first.

  "Sorted by year" is ambiguous and the two readings suit different jobs, but the one that
  matters here is reading an artist's output in the order they made it - which is what a
  discography is for. One default across both views rather than two, so the control means the
  same thing wherever you meet it.
*/
export const DEFAULT_SORT = 'year_asc';

export function isSortMode(value) {
    return SORT_MODES.some((mode) => mode.id === value);
}

export function sortModeLabel(value) {
    return (SORT_MODES.find((mode) => mode.id === value) || SORT_MODES[0]).label;
}

/**
 * The year as a number, or null when the group hasn't got one.
 *
 * Null rather than 0 deliberately. A missing date is not "the year zero" - treating it as a
 * number would float undated groups to one end of the list and bury real results behind
 * them, and which end would flip with the sort direction. They sink to the bottom either
 * way; see below.
 */
function yearOf(group) {
    const raw = group?.['first-release-date'];
    if (!raw) return null;

    const year = Number(String(raw).slice(0, 4));
    return Number.isFinite(year) && year > 0 ? year : null;
}

function scoreOf(group) {
    const score = group?.score;
    return typeof score === 'number' && Number.isFinite(score) ? score : -1;
}

function titleOf(group) {
    return String(group?.title || '');
}

function artistOf(group) {
    const credit = group?.['artist-credit'];
    if (!Array.isArray(credit) || !credit.length) return '';
    return String(credit[0]?.name || credit[0]?.artist?.name || '');
}

//? localeCompare with numeric so "Vol. 2" sorts before "Vol. 10", and base sensitivity so
//? case and accents don't split otherwise-identical names apart.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sort release groups for display.
 *
 * Returns a NEW array; the caller's copy of the server's response is left alone, which is
 * what lets the order be changed repeatedly without re-searching.
 *
 * Every comparison falls back to relevance and then to title, so the order is TOTAL - two
 * groups sharing a year come out in a stable, meaningful sequence rather than in whatever
 * order the engine happened to leave them.
 */
export function sortReleaseGroups(groups, mode = DEFAULT_SORT) {
    const list = Array.isArray(groups) ? [...groups] : [];
    if (!isSortMode(mode) || mode === 'relevance') {
        //? Relevance IS the order MusicBrainz answered in, so this is a deliberate no-op
        //? rather than a sort by score - re-sorting would only shuffle equal scores about.
        return list;
    }

    const byRelevanceThenTitle = (a, b) =>
        scoreOf(b) - scoreOf(a) || collator.compare(titleOf(a), titleOf(b));

    return list.sort((a, b) => {
        if (mode === 'title') {
            return collator.compare(titleOf(a), titleOf(b)) || byRelevanceThenTitle(a, b);
        }

        if (mode === 'artist') {
            return (
                collator.compare(artistOf(a), artistOf(b)) ||
                (yearOf(a) ?? Infinity) - (yearOf(b) ?? Infinity) ||
                byRelevanceThenTitle(a, b)
            );
        }

        const yearA = yearOf(a);
        const yearB = yearOf(b);

        /*
          Undated groups sink, whichever direction is asked for.

          They are overwhelmingly bootlegs and unofficial compilations, and putting them at
          the top of "oldest first" - which is what treating null as 0 would do - buries every
          real answer behind the ones MusicBrainz knows least about.
        */
        if (yearA === null && yearB === null) return byRelevanceThenTitle(a, b);
        if (yearA === null) return 1;
        if (yearB === null) return -1;

        const difference = mode === 'year_asc' ? yearA - yearB : yearB - yearA;
        return difference || byRelevanceThenTitle(a, b);
    });
}
