import { useEffect, useState } from 'preact/hooks'

import * as libraryApi from '../api/library'
import type { DeletionSummary, LibraryAlbum } from '../api/types'
import { formatSize } from '../lib/format'
import { Loading, LoadingPanel } from './Loading'

interface Props {
  album: LibraryAlbum
  onCancel: () => void
  /** Called once the folder is gone, so the library can drop it from the list. */
  onDeleted: () => void
}

/**
 * Confirm deleting an album.
 *
 * The summary is fetched live rather than taken from the album the library already has,
 * because the point of a confirmation is to describe what is about to happen to the disk
 * right now - and because the scan ignores files this doesn't. A rip log or a cue sheet in
 * that folder might be the only copy, so they're named individually before they go.
 *
 * Deliberately not a browser confirm(): it can't show any of that, and this is the one
 * action in jimbrainz with no undo.
 */
export function DeleteAlbumDialog({ album, onCancel, onDeleted }: Props) {
  const [summary, setSummary] = useState<DeletionSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      //? Escape cancels; Enter deliberately does NOT confirm. The destructive button should
      //? take a deliberate click rather than a keypress you might already be making.
      if (event.key === 'Escape') onCancel()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const result = await libraryApi.deletionSummary(album.path)
        if (!cancelled) setSummary(result)
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'could not read that folder')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [album.path])

  const confirm = async () => {
    setDeleting(true)
    setError(null)

    try {
      await libraryApi.deleteAlbum(album.path)
      onDeleted()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'could not delete it')
      setDeleting(false)
    }
  }

  return (
    <div id="delete-window" onClick={(event) => event.stopPropagation()}>
      <div id="delete-panel">
        <h4 class="text red">Delete this album?</h4>

        <div class="delete-subject">
          <span class="text white">{album.album}</span>
          <span class="text default-secondary">{album.artist}</span>
          {album.edition && <span class="library-edition">{album.edition}</span>}
        </div>

        <div class="text white-tertiary delete-path">{album.path}</div>

        {loading && <LoadingPanel label="checking what's in there..." />}

        {error && <h5 class="text red delete-problem">{error}</h5>}

        {summary && (
          <>
            <div class="text default-muted delete-counts">
              {summary.audio_files} track{summary.audio_files === 1 ? '' : 's'}
              {summary.total_bytes ? ` · ${formatSize(summary.total_bytes)}` : ''}
            </div>

            {/* named individually, because these are the ones that might not exist elsewhere */}
            {summary.other_file_count > 0 && (
              <div class="delete-others">
                <span class="text yellow">
                  and {summary.other_file_count} other file
                  {summary.other_file_count === 1 ? '' : 's'}:
                </span>
                <span class="text white-tertiary">
                  {summary.other_files.join(', ')}
                  {summary.other_file_count > summary.other_files.length ? ', …' : ''}
                </span>
              </div>
            )}
          </>
        )}

        <p class="text red delete-warning">
          This deletes the folder and everything in it, permanently. There is no undo.
        </p>

        <div id="delete-actions">
          <button type="button" class="columns-toggle-button" disabled={deleting} onClick={onCancel}>
            cancel
          </button>
          <button
            type="button"
            id="delete-confirm-button"
            disabled={loading || deleting || !summary}
            onClick={() => void confirm()}
          >
            {deleting ? <Loading label="deleting" /> : 'delete permanently'}
          </button>
        </div>
      </div>
    </div>
  )
}
