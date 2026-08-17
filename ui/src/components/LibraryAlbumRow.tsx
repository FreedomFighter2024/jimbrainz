import { useState } from 'preact/hooks'

import type { LibraryAlbum, MetadataIssueType } from '../api/types'
import { formatSize } from '../lib/format'
import type { AlbumGroup } from '../lib/groupAlbums'
import { describeIssues, issueLabel, outstandingIssues } from '../lib/metadataQueue'

//? Two chips and a count, not the full list. An unidentified album trips five or six rules at
//? once - all of them downstream of the one fact that it was never matched to a release - and a
//? row that turns into a wall of amber for a single underlying problem reads as much worse than
//? it is. The worst two say what to do; the editor spells the rest out.
const CHIPS_SHOWN = 2

/**
 * What's wrong with an album, said in the row rather than only in the editor.
 *
 * This is the part that removes the original complaint: finding out whether an album needed
 * attention meant opening it. Now the row says so, and the queue facets in the filter column
 * gather them up.
 */
function IssueChips(
  { issues, types, ignored }:
  { issues: readonly string[]; types: Record<string, MetadataIssueType>; ignored?: boolean },
) {
  if (!issues.length) return null

  const shown = issues.slice(0, CHIPS_SHOWN)
  const rest = issues.length - shown.length

  return (
    <span
      class={`library-issues${ignored ? ' is-ignored' : ''}`}
      title={describeIssues(issues, types)}
    >
      {shown.map((code) => (
        <span class="library-issue-chip" key={code}>{issueLabel(code, types)}</span>
      ))}
      {rest > 0 && <span class="library-issue-more">+{rest}</span>}
    </span>
  )
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

/**
 * Cover art, from the best source available.
 *
 * Tries in order and falls through on load failure:
 *
 *   1. the library's own art endpoint - a cover file beside the tracks, or art embedded in
 *      the audio. Instant, works offline, and shows what's actually on disk.
 *   2. the Cover Art Archive, keyed on the *release* MBID. Note the search view uses the
 *      release-GROUP id; the release id is used here because groupAlbums picks whichever
 *      edition actually has a cover, and that edition's own art is the right one to ask for.
 *
 * The fallback is driven by onError rather than by probing up front: a HEAD request per
 * album to decide would double the requests for no benefit, and the browser already tells
 * us for free when an image fails.
 */
function AlbumArt({ album }: { album: LibraryAlbum }) {
  const sources: string[] = []

  if (album.art) {
    sources.push(`/jimbrainz/library/art?album=${encodeURIComponent(album.path)}`)
  }
  if (album.release_mbid) {
    sources.push(`https://coverartarchive.org/release/${album.release_mbid}/front-250`)
  }

  const [attempt, setAttempt] = useState(0)
  const src = sources[attempt]

  // an empty square rather than nothing, so rows don't jump around as art loads or fails
  if (!src) return <div class="library-art is-empty" aria-hidden="true" />

  return (
    <img
      class="library-art"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setAttempt((n) => n + 1)}
    />
  )
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
function EditionRow(
  { album, issueTypes, onEdit, onDelete }:
  {
    album: LibraryAlbum
    issueTypes: Record<string, MetadataIssueType>
    onEdit: (a: LibraryAlbum) => void
    onDelete: (a: LibraryAlbum) => void
  },
) {
  const [expanded, setExpanded] = useState(false)
  const issues = outstandingIssues(album)

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

        {/* mixed tags is one of the issue codes now, so it arrives as a chip like the rest
            rather than as its own hand-placed warning */}
        <IssueChips issues={issues} types={issueTypes} />

        <span class="text white-tertiary library-path" title={album.path}>{album.path}</span>

        <button
          type="button"
          class="library-edit-button"
          title="correct this edition's metadata"
          onClick={() => onEdit(album)}
        >
          edit
        </button>

        <button
          type="button"
          class="library-delete-button"
          title="delete this edition from disk"
          onClick={() => onDelete(album)}
        >
          ✕
        </button>
      </div>

      {expanded && <TrackList album={album} />}
    </div>
  )
}

interface Props {
  group: AlbumGroup
  /** Issue code -> label and hint, straight from the scan. See lib/metadataQueue.ts. */
  issueTypes: Record<string, MetadataIssueType>
  onSearchArtist: (artist: string) => void
  onSearchAlbum: (group: AlbumGroup) => void
  /** Opens the metadata editor. Takes an edition, since that's what gets corrected. */
  onEdit: (album: LibraryAlbum) => void
  /** Opens the delete confirmation. Also per-edition: one pressing is not the others. */
  onDelete: (album: LibraryAlbum) => void
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
export function LibraryAlbumRow(
  { group, issueTypes, onSearchArtist, onSearchAlbum, onEdit, onDelete }: Props,
) {
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
    <div
      class={`library-album${multiple ? ' multi-edition' : ''}${
        group.needsAttention ? ' needs-attention' : ''
      }`}
    >
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

        {group.artFrom && <AlbumArt album={group.artFrom} />}

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

        {/*
          With several editions the chips describe the album as a whole, since the controls to
          fix any one of them live on the edition rows below - so the count is what says where
          to look, and the chips say what for.
        */}
        {multiple && group.needsAttention > 0 && (
          <span
            class="library-issue-count"
            title={`${group.needsAttention} of ${group.editions.length} editions need metadata`}
          >
            {group.needsAttention} of {group.editions.length}
          </span>
        )}

        <IssueChips issues={group.issues} types={issueTypes} />

        {/* with several editions the control belongs on each of them, since correcting one
            is not correcting the others */}
        {!multiple && only && (
          <button
            type="button"
            class="library-edit-button"
            title="correct this album's metadata"
            onClick={() => onEdit(only)}
          >
            edit
          </button>
        )}

        {!multiple && only && (
          <button
            type="button"
            class="library-delete-button"
            title="delete this album from disk"
            onClick={() => onDelete(only)}
          >
            ✕
          </button>
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
            <EditionRow
              key={album.path}
              album={album}
              issueTypes={issueTypes}
              onEdit={onEdit}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}

      {expanded && !multiple && only && <TrackList album={only} />}
    </div>
  )
}
