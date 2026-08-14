import { useCallback, useEffect, useState } from 'preact/hooks'

import * as api from '../api/library'
import type { LibraryAlbum, LibraryArtist } from '../api/types'

export interface LibraryState {
  albums: LibraryAlbum[]
  artists: LibraryArtist[]
  /** Set when the library can't be read at all — unset/missing LIBRARY_PATH. Not an error. */
  problem: string | null
  /** Set when the request itself failed. */
  error: string | null
  loading: boolean
  /** False until the first load finishes, so the empty state doesn't flash before data. */
  loaded: boolean
  scanSeconds: number
  libraryPath: string
  /**
   * Refetch. Resolves with the fresh album list, so a caller holding on to one album (the
   * metadata editor does) can find its new state rather than keeping a stale copy.
   */
  reload: (force?: boolean) => Promise<LibraryAlbum[]>
}

/**
 * Load the library, once, when it's first needed.
 *
 * `enabled` is the Library tab being open. A first scan reads tags off every file in the
 * library, so doing it on page load would tax people who never open this tab - and doing it
 * on a timer would tax everyone. It loads when you look at it, and otherwise only when you
 * ask.
 */
export function useLibrary(enabled: boolean): LibraryState {
  const [albums, setAlbums] = useState<LibraryAlbum[]>([])
  const [artists, setArtists] = useState<LibraryArtist[]>([])
  const [problem, setProblem] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [scanSeconds, setScanSeconds] = useState(0)
  const [libraryPath, setLibraryPath] = useState('')

  const load = useCallback(async (force: boolean): Promise<LibraryAlbum[]> => {
    setLoading(true)

    try {
      const result = force ? await api.rescan() : await api.listAlbums()
      setAlbums(result.albums)
      setArtists(result.artists)
      setProblem(result.problem)
      setLibraryPath(result.library_path)
      setScanSeconds(result.scan_seconds)
      setError(null)
      return result.albums
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'failed to read the library')
      return []
    } finally {
      setLoading(false)
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    // deliberately not re-running when the tab is closed and reopened - the scan is cached
    // server-side anyway, and reloading on every visit makes the view flicker for no gain
    if (enabled && !loaded && !loading) void load(false)
  }, [enabled, loaded, loading, load])

  const reload = useCallback((force = false) => load(force), [load])

  return {
    albums, artists, problem, error, loading, loaded, scanSeconds, libraryPath, reload,
  }
}
