import { ApiError, MusicBrainzUnavailable, get } from './http'
import type { FullySearchResponse, PingResponse, ReleasesResponse } from './types'

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
export async function fullySearch(query: string, limit = 5): Promise<FullySearchResponse> {
  const params = new URLSearchParams({ query, limit: String(limit) })

  try {
    return await get<FullySearchResponse>(`/search_musicbrainz/fully_search?${params}`)
  } catch (error) {
    throw asUnavailable(error)
  }
}

export async function getReleases(releaseGroupMbid: string): Promise<ReleasesResponse> {
  const params = new URLSearchParams({ release_group_mbid: releaseGroupMbid })

  try {
    return await get<ReleasesResponse>(`/search_musicbrainz/releases?${params}`)
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
