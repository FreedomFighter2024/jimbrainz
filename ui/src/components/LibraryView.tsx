import { useMemo, useState } from 'preact/hooks'

import { bridge } from '../bridge'
import { useLibrary } from '../hooks/useLibrary'
import { groupAlbums, type AlbumGroup } from '../lib/groupAlbums'
import { LibraryAlbumRow } from './LibraryAlbumRow'
import type { TabId } from './Tabs'

interface Props {
  /** The library only loads once this is true — see useLibrary. */
  active: boolean
  onNavigate: (tab: TabId) => void
}

/**
 * What's already on disk.
 *
 * Laid out like the search view on purpose - filter column on the left, results in the
 * middle, same controls in the same places - because it answers the neighbouring question
 * and shouldn't feel like a different application. The content differs where the question
 * does: there is an edition column here, and no download buttons.
 */
export function LibraryView({ active, onNavigate }: Props) {
  const { albums, artists, problem, error, loading, loaded, scanSeconds, libraryPath, reload } =
    useLibrary(active)

  const [filter, setFilter] = useState('')
  const [artistFilter, setArtistFilter] = useState<string | null>(null)
  const [multiOnly, setMultiOnly] = useState(false)

  //? grouped first, then filtered, so a filter never splits an album from its own editions
  const groups = useMemo(() => groupAlbums(albums), [albums])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()

    return groups.filter((group) => {
      if (artistFilter && group.artist !== artistFilter) return false
      if (multiOnly && group.editions.length < 2) return false
      if (!needle) return true

      return (
        group.album.toLowerCase().includes(needle) ||
        group.artist.toLowerCase().includes(needle) ||
        group.editions.some((e) => e.edition.toLowerCase().includes(needle))
      )
    })
  }, [groups, filter, artistFilter, multiOnly])

  const multiEditionCount = useMemo(
    () => groups.filter((g) => g.editions.length > 1).length,
    [groups],
  )

  const searchArtist = (artist: string) => {
    bridge().runSearch?.({ artist })
    onNavigate('search')
  }

  // the album name alone is ambiguous - there are a lot of records called "Greatest Hits" -
  // so the artist goes along with it
  const searchAlbum = (group: AlbumGroup) => {
    bridge().runSearch?.({ artist: group.artist, album: group.album })
    onNavigate('search')
  }

  return (
    <div id="library-content">
      <div id="library-filter-column">
        <div id="library-filter-header">
          {/* tightened spacing so it can't wrap in a 220px column — see main.css */}
          <h3 class="text default">░▒▓ artists ▓▒░</h3>
          <button
            type="button"
            id="library-clear-filters"
            disabled={!artistFilter && !multiOnly}
            onClick={() => {
              setArtistFilter(null)
              setMultiOnly(false)
            }}
          >
            clear
          </button>
        </div>
        <hr />

        {multiEditionCount > 0 && (
          <button
            type="button"
            class={`library-facet${multiOnly ? ' active' : ''}`}
            onClick={() => setMultiOnly((on) => !on)}
          >
            multiple editions <span class="library-facet-count">{multiEditionCount}</span>
          </button>
        )}

        <div class="scrollable" id="library-artists">
          {artists.map((entry) => (
            <button
              key={entry.artist}
              type="button"
              class={`library-facet${artistFilter === entry.artist ? ' active' : ''}`}
              onClick={() =>
                setArtistFilter((current) => (current === entry.artist ? null : entry.artist))
              }
            >
              {entry.artist} <span class="library-facet-count">{entry.album_count}</span>
            </button>
          ))}

          {loaded && !artists.length && (
            <p class="text default-muted library-empty">nothing here yet</p>
          )}
        </div>
      </div>

      <div id="library-middle">
        <div id="library-toolbar">
          <input
            type="text"
            id="library-filter-input"
            class="releases-filter-input"
            placeholder="Filter library..."
            value={filter}
            onInput={(event) => setFilter((event.target as HTMLInputElement).value)}
          />

          <span id="library-summary" class="text default-muted">
            {!loaded
              ? 'reading your library...'
              : visible.length === groups.length
                ? `${groups.length} album${groups.length === 1 ? '' : 's'}`
                : `${visible.length} of ${groups.length} albums`}
          </span>

          <button
            type="button"
            class="columns-toggle-button"
            disabled={loading}
            title="re-read every file, ignoring the cache"
            onClick={() => reload(true)}
          >
            {loading ? 'scanning...' : 'rescan'}
          </button>
        </div>

        <div class="scrollable" id="library-scrollable">
          {/*
            An unconfigured LIBRARY_PATH is a setup step, not a failure - say which knob to
            turn rather than rendering an empty list that looks like a broken scan.
          */}
          {problem && <h4 class="text yellow library-status">{problem}</h4>}

          {error && <h4 class="text red library-status">{error}</h4>}

          {!problem && !error && loaded && !albums.length && (
            <h4 class="text default-muted library-status">
              nothing found in {libraryPath || 'your library'} — downloads appear here once
              they've been organized
            </h4>
          )}

          {!problem && !error && loaded && albums.length > 0 && !visible.length && (
            <h4 class="text default-muted library-status">nothing matches that filter</h4>
          )}

          {visible.map((group) => (
            <LibraryAlbumRow
              key={group.key}
              group={group}
              onSearchArtist={searchArtist}
              onSearchAlbum={searchAlbum}
            />
          ))}

          {loaded && albums.length > 0 && (
            <p class="text white-tertiary library-scan-note">
              scanned in {scanSeconds}s
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
