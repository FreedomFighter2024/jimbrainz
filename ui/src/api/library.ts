import { get, post } from './http'
import type { LibraryResponse } from './types'

/**
 * Everything currently in LIBRARY_PATH.
 *
 * The server caches per folder on mtime, so this is cheap to call again — but the first scan
 * of a large library reads tags off every file and can take seconds. Treat it as a load, not
 * a poll.
 */
export function listAlbums(): Promise<LibraryResponse> {
  return get<LibraryResponse>('/library/albums')
}

/** Drop the server's per-folder cache and read everything again. */
export function rescan(): Promise<LibraryResponse> {
  return post<LibraryResponse>('/library/rescan')
}
