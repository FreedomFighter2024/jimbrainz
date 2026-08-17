import type { LibraryAlbum, MetadataIssueType } from '../api/types'

/**
 * Reading the metadata queue the server computed.
 *
 * Deliberately thin. The rules for what is *wrong* with an album live in
 * src/metadata_health.py, where they are pure and covered by tests, and the labels for them
 * arrive with the scan — so there is nothing to duplicate here. What's left is ordering and
 * filtering, which are presentation decisions and belong on this side.
 */

/**
 * The issues on this album that still want attention.
 *
 * `album.issues` is everything detected, including what has been ignored, because the editor
 * still wants to show an ignored issue with a note that you've accepted it. Queue membership is
 * this list being non-empty — which is exactly what the server's `needs_attention` says, and it
 * is the cheaper thing to check when you don't need the codes themselves.
 *
 * Order is preserved from the server, which sorts worst first.
 */
export function outstandingIssues(album: LibraryAlbum): string[] {
  if (!album.ignored_issues.length) return album.issues
  return album.issues.filter((code) => !album.ignored_issues.includes(code))
}

/**
 * The albums to work through, in the order worth working through them.
 *
 * Albums jimbrainz just filed come first: those are the ones you were prompted about, and
 * burying a fresh import under a hundred pre-existing gaps is how the prompt stops meaning
 * anything. After that it's worst-first, then alphabetical so the order is stable between
 * scans — an album that quietly changed places would make "next" feel like it skipped
 * something.
 */
export function queueAlbums(albums: readonly LibraryAlbum[], issue?: string | null): LibraryAlbum[] {
  const waiting = albums.filter((album) => {
    if (!album.needs_attention) return false
    if (!issue) return true
    return outstandingIssues(album).includes(issue)
  })

  return waiting.sort((a, b) => {
    const freshness = Number(b.imported && !b.reviewed) - Number(a.imported && !a.reviewed)
    if (freshness) return freshness

    if (a.severity !== b.severity) return b.severity - a.severity

    return a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album)
  })
}

/** An issue's short label, falling back to the raw code if the server didn't describe it. */
export function issueLabel(code: string, types: Record<string, MetadataIssueType>): string {
  return types[code]?.label ?? code
}

/** Every issue spelled out, for a title attribute — one per line. */
export function describeIssues(
  codes: readonly string[],
  types: Record<string, MetadataIssueType>,
): string {
  return codes.map((code) => types[code]?.hint ?? code).join('\n\n')
}
