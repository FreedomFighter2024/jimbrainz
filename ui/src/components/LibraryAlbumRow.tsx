import { useState } from 'preact/hooks'

import type { LibraryAlbum } from '../api/types'
import { formatSize } from '../lib/format'
import type { AlbumGroup } from '../lib/groupAlbums'

function formatDuration(seconds: number): string {
  if (!seconds) return ''
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function trackTime(seconds: number): string {
  if (!seconds) return ''
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

function TrackList({ album }: { album: LibraryAlbum }) {
  return (
    <div class="library-tracks">
      {album.tracks.map((track) => (
        <div class="library-track" key={track.filename}>
          <span class="library-track-number">
            {track.position === null ? '–' : String(track.position).padStart(2, '0')}
          </span>
          <span class="library-track-title">{track.title}</span>
          <span class="library-track-time">{trackTime(track.length)}</span>
          <span class="library-track-format">{track.format.toUpperCase()}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * One edition, listed under its album. Expands to its own tracklist.
 *
 * Only rendered when an album actually has more than one edition - see the group row below.
 */
function EditionRow({ album }: { album: LibraryAlbum }) {
  const [expanded, setExpanded] = useState(false)

  const meta = [
    `${album.track_count} track${album.track_count === 1 ? '' : 's'}`,
    formatDuration(album.duration),
    formatSize(album.total_size),
    album.formats.join('/').toUpperCase(),
  ].filter(Boolean)

  return (
    <div class="library-edition-row">
      <div class="library-edition-head">
        <button
          type="button"
          class="library-expand"
          aria-expanded={expanded}
          title={expanded ? 'hide tracks' : 'show tracks'}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? '▽' : '▷'}
        </button>

        <span class="library-edition has-siblings">{album.edition || 'Standard'}</span>
        {album.year && <span class="library-year">{album.year}</span>}
        <span class="text default-muted library-edition-meta">{meta.join(' · ')}</span>

        {album.mixed_tags && (
          <span class="library-warning" title="files in this folder disagree about the album name">
            mixed tags
          </span>
        )}

        <span class="text white-tertiary library-path" title={album.path}>{album.path}</span>
      </div>

      {expanded && <TrackList album={album} />}
    </div>
  )
}

interface Props {
  group: AlbumGroup
  onSearchArtist: (artist: string) => void
  onSearchAlbum: (group: AlbumGroup) => void
}

/**
 * One album, with its editions underneath.
 *
 * Structured after the search view, where a release group is the album and the releases
 * under it are the editions. Listing every edition as a top-level row made three pressings
 * of one record look like three different albums.
 *
 * The nesting is skipped when there's only one edition: expanding goes straight to the
 * tracks rather than through a single pointless "Standard" row, which is the overwhelmingly
 * common case in a real library.
 */
export function LibraryAlbumRow({ group, onSearchArtist, onSearchAlbum }: Props) {
  const [expanded, setExpanded] = useState(false)

  const multiple = group.editions.length > 1
  const only = group.editions[0]

  const meta = [
    multiple
      ? `${group.editions.length} editions`
      : `${group.trackCount} track${group.trackCount === 1 ? '' : 's'}`,
    formatDuration(group.duration),
    formatSize(group.totalSize),
    group.formats.join('/').toUpperCase(),
  ].filter(Boolean)

  return (
    <div class={`library-album${multiple ? ' multi-edition' : ''}`}>
      <div class="library-album-head">
        <button
          type="button"
          class="library-expand"
          aria-expanded={expanded}
          title={expanded ? 'collapse' : multiple ? 'show editions' : 'show tracks'}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? '▽' : '▷'}
        </button>

        <div class="library-album-titles">
          {/*
            Buttons rather than anchors: these run a search in the other tab, they don't
            navigate anywhere, and an <a href="#"> would put junk in the address bar and
            offer a meaningless "open in new tab".
          */}
          <button
            type="button"
            class="library-link library-album-name"
            title={`search MusicBrainz for ${group.album}`}
            onClick={() => onSearchAlbum(group)}
          >
            {group.album}
          </button>

          <button
            type="button"
            class="library-link library-artist-name"
            title={`search MusicBrainz for ${group.artist}`}
            onClick={() => onSearchArtist(group.artist)}
          >
            {group.artist}
          </button>
        </div>

        {(group.yearRange || group.year) && (
          <span class="library-year">{group.yearRange || group.year}</span>
        )}

        {/* the point of the view: how many versions of this record you actually hold */}
        {multiple && (
          <span
            class="library-edition has-siblings"
            title={`${group.editions.length} versions of this album are in your library`}
          >
            {group.editions.length} editions
          </span>
        )}

        {!multiple && only?.edition && <span class="library-edition">{only.edition}</span>}

        {group.hasMixedTags && (
          <span class="library-warning" title="files disagree about the album name">
            mixed tags
          </span>
        )}
      </div>

      <div class="library-album-meta">
        <span class="text default-muted">{meta.join(' · ')}</span>
        {!multiple && only && (
          <span class="text white-tertiary library-path" title={only.path}>{only.path}</span>
        )}
      </div>

      {/*
        Not rendered while collapsed, on purpose. Building every album's track list up front
        is the measured 711ms freeze in the search view (see CLAUDE.md); this view would hit
        it harder, since a library has far more albums than one search returns.
      */}
      {expanded && multiple && (
        <div class="library-editions">
          {group.editions.map((album) => (
            <EditionRow key={album.key} album={album} />
          ))}
        </div>
      )}

      {expanded && !multiple && only && <TrackList album={only} />}
    </div>
  )
}
