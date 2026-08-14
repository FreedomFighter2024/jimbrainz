import type { Release, RetagRelease, Track } from '../api/types'

const EDITION_KEYWORDS: ReadonlyArray<[RegExp, string]> = [
  [/super deluxe/, 'SUPER DELUXE'],
  [/deluxe/, 'DELUXE'],
  [/box set|boxset/, 'BOX SET'],
  [/anniversary/, 'ANNIVERSARY'],
  [/expanded/, 'EXPANDED'],
  [/limited edition/, 'LIMITED'],
  [/special edition/, 'SPECIAL EDITION'],
]

/**
 * Edition markers detected from a release's own text.
 *
 * Mirrors getEditionTags() in interface/scripts/main.js and EDITION_PATTERNS in
 * src/matching.py — the same vocabulary in three places because the frontend tags the
 * release, the backend tags the candidate folder, and then they get compared. Changing one
 * without the others silently weakens the edition signal.
 */
export function detectEditionTags(release: Release): string[] {
  const haystack = `${release.disambiguation ?? ''} ${release.title ?? ''}`.toLowerCase()
  const tags: string[] = []

  if (haystack.includes('remaster')) tags.push('REMASTER')

  for (const [pattern, label] of EDITION_KEYWORDS) {
    if (pattern.test(haystack)) {
      tags.push(label)
      // "super deluxe" also trips the plain "deluxe" pattern on the same text
      if (label === 'SUPER DELUXE') break
    }
  }

  if (release.packaging === 'Box' && !tags.includes('BOX SET')) tags.push('BOX SET')

  return tags
}

/** Flatten MusicBrainz's per-disc numbering into one running sequence. */
function flattenTracks(release: Release): Track[] {
  const tracks: Track[] = []
  let position = 0

  for (const medium of release.media ?? []) {
    const discTracks = (medium as { tracks?: unknown[] }).tracks ?? []

    for (const raw of discTracks) {
      const entry = raw as {
        title?: string
        length?: number | null
        recording?: { title?: string; length?: number | null }
      }
      position += 1
      tracks.push({
        position,
        title: entry.recording?.title || entry.title || '',
        length_ms: entry.recording?.length ?? entry.length ?? null,
      })
    }
  }

  return tracks
}

/**
 * Turn a MusicBrainz release into the payload the retag endpoints take.
 *
 * The typed counterpart of buildExpectedFromRelease() in main.js, and deliberately produces
 * the same shape: an album corrected by hand should end up carrying exactly the tags one
 * downloaded fresh would have, rather than a second dialect of the same thing.
 *
 * When the search view is ported this replaces the vanilla function outright.
 */
export function buildRetagRelease(
  release: Release,
  context: { artist: string; album: string; releaseGroupMbid?: string | null },
): RetagRelease {
  const rawDate = release['release-events']?.[0]?.date || release.date || ''
  const catalogNumbers = (release['label-info'] ?? [])
    .map((entry) => entry['catalog-number'])
    .filter((value): value is string => Boolean(value))

  return {
    artist: context.artist,
    album: release.title || context.album,
    year: rawDate ? rawDate.substring(0, 4) : null,
    release_mbid: release.id,
    release_group_mbid: context.releaseGroupMbid ?? null,
    disambiguation: release.disambiguation || null,
    media_format: (release.media ?? []).map((m) => m.format).filter(Boolean).join(' + ') || null,
    // the raw ISO code, NOT the flag-display mapping — src/editions.py recognises and
    // discards the "worldwide" codes rather than labelling a folder "[UN]"
    country: release['release-events']?.[0]?.area?.['iso-3166-1-codes']?.[0] ?? release.country ?? null,
    catalog_number: catalogNumbers.join(', ') || null,
    edition_tags: detectEditionTags(release),
    tracks: flattenTracks(release),
  }
}

/** A short human description of a release, for picking between siblings in a list. */
export function describeRelease(release: Release): string {
  const parts = [
    release.disambiguation,
    (release.media ?? []).map((m) => m.format).filter(Boolean).join(' + '),
    release['release-events']?.[0]?.area?.['iso-3166-1-codes']?.[0],
    (release['label-info'] ?? []).map((l) => l['catalog-number']).filter(Boolean)[0],
  ].filter(Boolean)

  return parts.join(' · ')
}

/** Total tracks across all discs, for comparing a release against what's on disk. */
export function releaseTrackCount(release: Release): number {
  return (release.media ?? []).reduce((total, m) => total + (m['track-count'] ?? 0), 0)
}
