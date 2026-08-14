import { get, post } from './http'
import type {
  DeleteResult, DeletionSummary, LibraryResponse, RetagPlan, RetagRelease, RetagResponse,
} from './types'

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

/**
 * What applying this release to that album would change. Writes nothing.
 *
 * A separate endpoint from apply rather than a flag on it — this runs while you're still
 * choosing, so it must be impossible for it to modify anything by accident.
 */
export function previewRetag(
  albumPath: string,
  release: RetagRelease,
  fetchArt = false,
): Promise<RetagPlan> {
  return post<RetagPlan>('/library/retag/preview', {
    album_path: albumPath, release, fetch_art: fetchArt,
  })
}

/**
 * Write the tags and re-file the folder.
 *
 * The server recomputes the plan rather than taking the previewed one back, so this sends
 * the same two arguments the preview did — a plan is a list of file operations, and handing
 * one over the wire would let a caller name arbitrary paths to write to.
 */
export function applyRetag(
  albumPath: string,
  release: RetagRelease,
  fetchArt = false,
): Promise<RetagResponse> {
  return post<RetagResponse>('/library/retag/apply', {
    album_path: albumPath, release, fetch_art: fetchArt,
  })
}

/** What deleting this album would remove. Touches nothing. */
export function deletionSummary(albumPath: string): Promise<DeletionSummary> {
  return get<DeletionSummary>(`/library/deletion_summary?album=${encodeURIComponent(albumPath)}`)
}

/**
 * Delete an album folder and everything in it. Permanent, and the only call in here with no
 * undo — the guards that make it safe live in src/library.py::delete_album.
 */
export function deleteAlbum(albumPath: string): Promise<DeleteResult> {
  return post<DeleteResult>('/library/delete', { album_path: albumPath })
}
