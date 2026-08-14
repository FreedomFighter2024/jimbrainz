import { useCallback, useEffect, useState } from 'preact/hooks'

import * as libraryApi from '../api/library'
import * as musicbrainz from '../api/musicbrainz'
import { MusicBrainzUnavailable } from '../api/http'
import type { LibraryAlbum, Release, RetagPlan, RetagRelease } from '../api/types'
import { buildRetagRelease, describeRelease, releaseTrackCount } from '../lib/release'

interface Props {
  album: LibraryAlbum
  onClose: () => void
  /** Called after a successful apply, so the library can pick up the new tags and path. */
  onApplied: () => void
}

/**
 * Pick which MusicBrainz release an album on disk actually is, and write that back.
 *
 * An overlay rather than a tab: it acts on one album, which you were already looking at in
 * the library, and it should disappear when you're done. It reuses the candidates-window
 * pattern the download flow already uses, because this is structurally the same interaction
 * - here is a thing, here are candidate matches, pick one.
 *
 * Nothing is written until Apply. The preview comes from the same planner the write uses, so
 * what it shows is what will happen rather than a separate guess at it.
 */
export function MetadataEditor({ album, onClose, onApplied }: Props) {
  const [query, setQuery] = useState(`${album.artist} ${album.album}`.trim())
  const [releases, setReleases] = useState<Release[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)

  const [selected, setSelected] = useState<Release | null>(null)
  const [editionLabel, setEditionLabel] = useState('')
  /*
   * Default on only when the album has no cover of its own. Fetching art is a network round
   * trip and, for an album that already has one, a replacement — so it opts in when there's
   * nothing to lose and opts out when there is.
   */
  const [fetchArt, setFetchArt] = useState(!album.art)
  const [plan, setPlan] = useState<RetagPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyError, setApplyError] = useState<string | null>(null)
  const [applied, setApplied] = useState<string | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const search = useCallback(async () => {
    setSearching(true)
    setSearchError(null)
    setSelected(null)
    setPlan(null)

    try {
      // the album's own name and artist, as a plain query - the album on disk may be tagged
      // loosely enough that a fielded search finds nothing
      const result = await musicbrainz.fullySearch(query, 25)
      const groups = result['release-groups'] ?? []

      // Releases, not release groups: an edition IS a release, so grouping them would hide
      // exactly the distinction this editor exists to make.
      const found: Release[] = []
      for (const group of groups.slice(0, 3)) {
        const detail = await musicbrainz.getReleases(group.id)
        for (const release of detail.releases ?? []) {
          found.push({ ...release, _groupMbid: group.id } as Release)
        }
      }

      setReleases(found)
    } catch (caught) {
      setSearchError(
        caught instanceof MusicBrainzUnavailable
          ? "MusicBrainz is unreachable right now, so there's nothing to match against. " +
            "This isn't a problem with the album — try again shortly."
          : caught instanceof Error
            ? caught.message
            : 'the search failed',
      )
      setReleases([])
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }, [query])

  /** Rebuild the payload whenever the release or the label override changes. */
  const payloadFor = useCallback(
    (release: Release): RetagRelease => {
      const built = buildRetagRelease(release, {
        artist: album.artist,
        album: album.album,
        releaseGroupMbid: (release as { _groupMbid?: string })._groupMbid ?? null,
      })
      return editionLabel.trim() ? { ...built, edition_label: editionLabel.trim() } : built
    },
    [album.artist, album.album, editionLabel],
  )

  const preview = useCallback(
    async (release: Release) => {
      setSelected(release)
      setPlanning(true)
      setApplyError(null)

      try {
        setPlan(await libraryApi.previewRetag(album.path, payloadFor(release), fetchArt))
      } catch (caught) {
        setApplyError(caught instanceof Error ? caught.message : 'could not work out the changes')
        setPlan(null)
      } finally {
        setPlanning(false)
      }
    },
    [album.path, payloadFor, fetchArt],
  )

  // both of these change what the plan says, so it has to be recomputed
  useEffect(() => {
    if (selected) void preview(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editionLabel, fetchArt])

  const apply = async () => {
    if (!selected) return
    setApplying(true)
    setApplyError(null)

    try {
      const response = await libraryApi.applyRetag(album.path, payloadFor(selected), fetchArt)
      const { results } = response

      if (results.failed) {
        setApplyError(`${results.failed} file(s) could not be written`)
      } else {
        setApplied(
          [
            `Retagged ${results.tagged} file(s)`,
            results.art_written ? `saved ${results.art_written}` : '',
            results.moved_to ? 're-filed the folder' : '',
          ].filter(Boolean).join(', ') + '.',
        )
        onApplied()
      }
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : 'could not apply the changes')
    } finally {
      setApplying(false)
    }
  }

  return (
    <div id="metadata-window" onClick={(event) => event.stopPropagation()}>
      <div id="metadata-panel">
        <div id="metadata-header">
          <h4 class="text white">
            {album.album} <span class="text default-secondary">{album.artist}</span>
          </h4>
          <span class="text white-tertiary metadata-path">{album.path}</span>
          <button type="button" id="metadata-close-button" title="close" onClick={onClose}>✕</button>
        </div>

        <div id="metadata-search">
          <input
            type="text"
            class="releases-filter-input"
            value={query}
            placeholder="artist and album"
            onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void search() }}
          />
          <button type="button" class="columns-toggle-button" disabled={searching} onClick={() => void search()}>
            {searching ? 'searching...' : 'find releases'}
          </button>
        </div>

        <div id="metadata-body">
          <div class="scrollable metadata-releases">
            {searchError && <h4 class="text yellow metadata-status">{searchError}</h4>}

            {!searchError && searched && !releases.length && !searching && (
              <h4 class="text default-muted metadata-status">no releases found for that search</h4>
            )}

            {!searched && !searching && (
              <h4 class="text default-muted metadata-status">
                search MusicBrainz to pick which release this album is
              </h4>
            )}

            {releases.map((release) => {
              const tracks = releaseTrackCount(release)
              const detail = describeRelease(release)

              return (
                <button
                  key={release.id}
                  type="button"
                  class={`metadata-release${selected?.id === release.id ? ' active' : ''}`}
                  onClick={() => void preview(release)}
                >
                  <span class="metadata-release-title">{release.title}</span>
                  <span class="metadata-release-detail text default-muted">
                    {[release.date?.substring(0, 4), detail].filter(Boolean).join(' · ')}
                  </span>
                  {/* the strongest signal that a release is the wrong one for these files */}
                  <span
                    class={`metadata-release-tracks${tracks && tracks !== album.track_count ? ' mismatch' : ''}`}
                  >
                    {tracks || '?'} trk
                  </span>
                </button>
              )
            })}
          </div>

          <div class="scrollable metadata-plan">
            {planning && <h4 class="text default-muted metadata-status">working out the changes...</h4>}

            {!planning && !plan && (
              <h4 class="text default-muted metadata-status">pick a release to see what would change</h4>
            )}

            {!planning && plan && (
              <>
                <label class="metadata-field">
                  <span class="text default-secondary">edition name</span>
                  <input
                    type="text"
                    class="releases-filter-input"
                    placeholder={plan.edition_label || 'Standard'}
                    value={editionLabel}
                    onInput={(event) => setEditionLabel((event.target as HTMLInputElement).value)}
                  />
                  <span class="text white-tertiary metadata-hint">
                    overrides what's worked out from the release. Names the folder.
                  </span>
                </label>

                <label class="metadata-checkbox">
                  <input
                    type="checkbox"
                    checked={fetchArt}
                    onChange={(event) => setFetchArt((event.target as HTMLInputElement).checked)}
                  />
                  <span class="text default-secondary">
                    {plan.art.existing ? `replace ${plan.art.existing}` : 'download cover art'}
                  </span>
                  <span class="text white-tertiary metadata-hint">
                    {plan.art.existing
                      ? 'this album already has a cover; only overwrite it if the new one is better'
                      : 'from the Cover Art Archive, saved into the album folder'}
                  </span>
                </label>

                {plan.problems.map((problem) => (
                  <h5 class="text yellow metadata-problem" key={problem}>{problem}</h5>
                ))}

                {plan.moves && (
                  <div class="metadata-move">
                    <span class="text default-secondary">folder</span>
                    <span class="text white-tertiary">{plan.album_path}</span>
                    <span class="text default">→ {plan.target_path}</span>
                  </div>
                )}

                {plan.empty && (
                  <h4 class="text default-muted metadata-status">
                    this album already matches that release — nothing to change
                  </h4>
                )}

                {plan.files.filter((file) => Object.keys(file.changes).length).map((file) => (
                  <div class="metadata-file" key={file.filename}>
                    <div class="metadata-file-name text white">{file.filename}</div>
                    {Object.entries(file.changes).map(([tag, change]) => (
                      <div class="metadata-change" key={tag}>
                        <span class="metadata-tag text default-secondary">{tag}</span>
                        <span class="metadata-from text white-tertiary">{change.from || '—'}</span>
                        <span class="metadata-to text default">{change.to}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>

        <div id="metadata-footer">
          {applied && <span class="text green metadata-result">{applied}</span>}
          {applyError && <span class="text red metadata-result">{applyError}</span>}

          {!applied && plan && !plan.empty && (
            <span class="text default-muted metadata-summary">
              {plan.changed_file_count} of {plan.file_count} file(s) would change
              {plan.art.action ? `, cover art would be ${plan.art.action}d` : ''}
              {plan.moves ? ', and the folder would be renamed' : ''}
            </span>
          )}

          <button type="button" class="columns-toggle-button" onClick={onClose}>
            {applied ? 'close' : 'cancel'}
          </button>

          <button
            type="button"
            id="metadata-apply-button"
            disabled={!plan || plan.empty || planning || applying || Boolean(applied)}
            onClick={() => void apply()}
          >
            {applying ? 'applying...' : 'apply'}
          </button>
        </div>
      </div>
    </div>
  )
}
