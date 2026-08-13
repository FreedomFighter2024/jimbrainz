import { useState } from 'preact/hooks'

import type { LibraryAlbum } from '../api/types'
import { formatSize } from '../lib/format'

interface Props {
  album: LibraryAlbum
  onSearchArtist: (artist: string) => void
  onSearchAlbum: (album: LibraryAlbum) => void
}

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

export function LibraryAlbumRow({ album, onSearchArtist, onSearchAlbum }: Props) {
  const [expanded, setExpanded] = useState(false)

  const meta = [
    `${album.track_count} track${album.track_count === 1 ? '' : 's'}`,
    formatDuration(album.duration),
    formatSize(album.total_size),
    album.formats.join('/').toUpperCase(),
  ].filter(Boolean)

  return (
    <div class={`library-album${album.edition_count > 1 ? ' multi-edition' : ''}`}>
      <div class="library-album-head">
        <button
          type="button"
          class="library-expand"
          aria-expanded={expanded}
          title={expanded ? 'hide tracks' : 'show tracks'}
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
            title={`search MusicBrainz for ${album.album}`}
            onClick={() => onSearchAlbum(album)}
          >
            {album.album}
          </button>

          <button
            type="button"
            class="library-link library-artist-name"
            title={`search MusicBrainz for ${album.artist}`}
            onClick={() => onSearchArtist(album.artist)}
          >
            {album.artist}
          </button>
        </div>

        {album.year && <span class="library-year">{album.year}</span>}

        {/* the point of the view: which version of this record is this one */}
        {album.edition && (
          <span
            class={`library-edition${album.edition_count > 1 ? ' has-siblings' : ''}`}
            title={
              album.edition_count > 1
                ? `${album.edition_count} versions of this album are in your library`
                : undefined
            }
          >
            {album.edition}
          </span>
        )}

        {album.mixed_tags && (
          <span class="library-warning" title="files in this folder disagree about the album name">
            mixed tags
          </span>
        )}
      </div>

      <div class="library-album-meta">
        <span class="text default-muted">{meta.join(' · ')}</span>
        <span class="text white-tertiary library-path" title={album.path}>{album.path}</span>
      </div>

      {/*
        Not rendered while collapsed, on purpose. Building every album's track list up front
        is the measured 711ms freeze in the search view (see CLAUDE.md); this view would hit
        it harder, since a library has far more albums than one search returns.
      */}
      {expanded && (
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
      )}
    </div>
  )
}
