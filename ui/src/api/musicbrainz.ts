import { ApiError, MusicBrainzUnavailable, get } from './http'
import type { FullySearchResponse, PingResponse, Release, ReleasesResponse } from './types'

/**
 * Search release groups, plus the releases of the best match.
 *
 * Two failure modes that must stay distinct:
 *   - resolves to `{}`            the query ran and matched nothing
 *   - throws MusicBrainzUnavailable   MusicBrainz is unreachable; the query never ran
 *
 * Callers that render "no results" for the second case are reintroducing the bug this
 * split exists to fix.
 */
export async function fullySearch(
  query: string,
  limit = 5,
  /**
   * Whether to also fetch the best group's releases.
   *
   * Leave it on when you're about to render them. Turn it OFF if you rank the groups yourself
   * and fetch what you want afterwards — this walks the best group's entire release list with
   * tracklists attached, which for a big album is five requests and 1.4 MB, and MusicBrainz
   * allows roughly one request a second.
   */
  includeReleases = true,
): Promise<FullySearchResponse> {
  const params = new URLSearchParams({ query, limit: String(limit) })
  if (!includeReleases) params.set('releases', 'false')

  try {
    return await get<FullySearchResponse>(`/search_musicbrainz/fully_search?${params}`)
  } catch (error) {
    throw asUnavailable(error)
  }
}

/**
 * Every release in a group.
 *
 * `withTracks` defaults to true because the download flow matches Soulseek folders against a
 * release's real tracklist. Pass false when you only need to tell pressings APART — format,
 * country, catalogue number and `media[].track-count` all survive, and it is the difference
 * between one request and five. Pair it with `getRelease` for whichever one gets chosen.
 */
export async function getReleases(
  releaseGroupMbid: string,
  withTracks = true,
): Promise<ReleasesResponse> {
  const params = new URLSearchParams({ release_group_mbid: releaseGroupMbid })
  if (!withTracks) params.set('tracks', 'false')

  try {
    return await get<ReleasesResponse>(`/search_musicbrainz/releases?${params}`)
  } catch (error) {
    throw asUnavailable(error)
  }
}

/** One release, with its tracklist. The other half of `getReleases(id, false)`. */
export async function getRelease(releaseMbid: string): Promise<Release> {
  const params = new URLSearchParams({ release_mbid: releaseMbid })

  try {
    return await get<Release>(`/search_musicbrainz/release?${params}`)
  } catch (error) {
    throw asUnavailable(error)
  }
}

export function ping(): Promise<PingResponse> {
  return get<PingResponse>('/search_musicbrainz/ping')
}

function asUnavailable(error: unknown): unknown {
  if (error instanceof ApiError && error.status === 503) {
    return new MusicBrainzUnavailable(error.detail)
  }
  return error
}
