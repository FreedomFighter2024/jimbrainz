import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { MusicBrainzUnavailable } from '../api/http'
import * as libraryApi from '../api/library'
import * as musicbrainz from '../api/musicbrainz'
import type { LibraryAlbum, Release, RetagPlan, RetagRelease } from '../api/types'
import {
  buildRetagRelease,
  describeRelease,
  isCurrentRelease,
  releaseTrackCount,
  scoreReleaseMatch,
} from '../lib/release'

interface Props {
  album: LibraryAlbum
  onClose: () => void
  /** Called after a successful apply, so the library can pick up the new tags and path. */
  onApplied: () => void
}

/** The fields you can type into. Everything else comes from the release you pick. */
interface Fields {
  artist: string
  album: string
  year: string
  editionLabel: string
}

//? A plan is a server round trip, and every keystroke would be one. Long enough to finish a
//? word, short enough that the preview still feels attached to what you typed.
const PREVIEW_DEBOUNCE_MS = 400

/**
 * The cover you'd end up with, beside the one you have.
 *
 * Loaded straight from the Cover Art Archive by the browser rather than through the server -
 * exactly as the library rows already do for albums with no local art. Fetching it server-side
 * to preview it would mean downloading the image twice, and downloading on preview is the
 * thing plan_art() deliberately avoids.
 *
 * Shown whenever a release is selected, not only when the checkbox is ticked: seeing the art
 * is how you decide whether you want it.
 */
function ArtComparison({ album, release }: { album: LibraryAlbum; release: Release | null }) {
  const [currentFailed, setCurrentFailed] = useState(false)
  const [incomingFailed, setIncomingFailed] = useState(false)

  //? reset when the release changes, or a single failure would stick for every later pick
  useEffect(() => setIncomingFailed(false), [release?.id])

  const current = album.art
    ? `/jimbrainz/library/art?album=${encodeURIComponent(album.path)}`
    : null
  const incoming = release ? `https://coverartarchive.org/release/${release.id}/front-250` : null

  if (!current && !incoming) return null

  return (
    <div class="metadata-art">
      <div class="metadata-art-slot">
        <span class="text white-tertiary">current</span>
        {current && !currentFailed ? (
          <img src={current} alt="" onError={() => setCurrentFailed(true)} />
        ) : (
          <div class="metadata-art-empty">none</div>
        )}
      </div>

      <span class="metadata-art-arrow text default-secondary">→</span>

      <div class="metadata-art-slot">
        <span class="text white-tertiary">from this release</span>
        {incoming && !incomingFailed ? (
          <img
            src={incoming}
            alt=""
            /* keyed so switching releases replaces the element rather than reusing one whose
               onError already fired */
            key={release?.id}
            onError={() => setIncomingFailed(true)}
          />
        ) : (
          <div class="metadata-art-empty">{release ? 'none on file' : 'pick a release'}</div>
        )}
      </div>
    </div>
  )
}

/**
 * Pick which MusicBrainz release an album on disk actually is, correct it by hand, and write
 * it back.
 *
 * An overlay rather than a tab: it acts on one album, which you were already looking at in
 * the library, and it should disappear when you're done. It reuses the candidates-window
 * pattern the download flow already uses, because this is structurally the same interaction
 * - here is a thing, here are candidate matches, pick one.
 *
 * Two ways in, deliberately. Picking a release fills the fields from MusicBrainz, which is
 * what you want when the album is mistagged. Typing in the fields directly is what you want
 * when MusicBrainz is wrong, or unreachable, or the record simply isn't in it - so the
 * fields work with no release selected at all.
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

  //? seeded from what's on disk, so the editor opens showing the album as it is rather than
  //? empty boxes you have to fill before anything makes sense
  const [fields, setFields] = useState<Fields>({
    artist: album.artist,
    album: album.album,
    year: album.year,
    editionLabel: album.edition === 'Standard' ? '' : album.edition,
  })

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

  const setField = (key: keyof Fields, value: string) =>
    setFields((current) => ({ ...current, [key]: value }))

  const search = useCallback(async () => {
    setSearching(true)
    setSearchError(null)

    try {
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

      // best match first. For a tagged album that's the release it already names, which is
      // the whole point - you can see what it currently matches instead of hunting for it.
      found.sort((a, b) => scoreReleaseMatch(b, album) - scoreReleaseMatch(a, album))
      setReleases(found)

      const current = found.find((r) => isCurrentRelease(r, album.release_mbid))
      if (current) setSelected(current)
    } catch (caught) {
      setSearchError(
        caught instanceof MusicBrainzUnavailable
          ? "MusicBrainz is unreachable right now, so there's nothing to match against. " +
            'You can still correct the fields by hand.'
          : caught instanceof Error
            ? caught.message
            : 'the search failed',
      )
      setReleases([])
    } finally {
      setSearching(false)
      setSearched(true)
    }
  }, [query, album])

  /** Picking a release replaces the fields with its values, which you can then still edit. */
  const chooseRelease = (release: Release) => {
    setSelected(release)
    const built = buildRetagRelease(release, {
      artist: album.artist,
      album: album.album,
      releaseGroupMbid: (release as { _groupMbid?: string })._groupMbid ?? null,
    })
    setFields({
      artist: built.artist,
      album: built.album,
      year: built.year ?? '',
      //? the release's own disambiguation is what the folder name would use anyway, so
      //? leaving this blank lets editions.py decide rather than pinning it
      editionLabel: '',
    })
  }

  /**
   * What would be applied: the selected release, with the typed fields laid over the top.
   *
   * With no release selected this still produces a usable payload from the album's own
   * values and an empty tracklist - so hand-editing works without MusicBrainz, and an empty
   * tracklist means no file gets a title or track number it didn't ask for.
   */
  const payload = useMemo((): RetagRelease => {
    const base: RetagRelease = selected
      ? buildRetagRelease(selected, {
          artist: album.artist,
          album: album.album,
          releaseGroupMbid: (selected as { _groupMbid?: string })._groupMbid ?? null,
        })
      : {
          artist: album.artist,
          album: album.album,
          year: album.year || null,
          //? keep the id the album already carries so the folder can still be disambiguated
          release_mbid: album.release_mbid || null,
          tracks: [],
        }

    return {
      ...base,
      artist: fields.artist,
      album: fields.album,
      year: fields.year || null,
      edition_label: fields.editionLabel.trim() || null,
    }
  }, [selected, fields, album])

  // Debounced: the plan is a server round trip and this runs on every keystroke.
  useEffect(() => {
    if (applied) return

    setPlanning(true)
    const timer = setTimeout(async () => {
      try {
        setPlan(await libraryApi.previewRetag(album.path, payload, fetchArt))
        setApplyError(null)
      } catch (caught) {
        setApplyError(caught instanceof Error ? caught.message : 'could not work out the changes')
        setPlan(null)
      } finally {
        setPlanning(false)
      }
    }, PREVIEW_DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [album.path, payload, fetchArt, applied])

  const apply = async () => {
    setApplying(true)
    setApplyError(null)

    try {
      const { results } = await libraryApi.applyRetag(album.path, payload, fetchArt)

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

  const taggedRelease = album.release_mbid
  const foundCurrent = releases.some((r) => isCurrentRelease(r, taggedRelease))

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

        {/*
          What the album currently claims to be. Without this you can't tell whether it's
          tagged at all, let alone which release it points at.
        */}
        <div id="metadata-current" class="text default-muted">
          <span>currently:</span>
          <span class="text white-tertiary">{album.edition || 'no edition'}</span>
          <span class="text white-tertiary">{album.year || 'no year'}</span>
          <span class="text white-tertiary">{album.track_count} tracks</span>
          <span class={taggedRelease ? 'metadata-mbid' : 'text yellow'}>
            {taggedRelease
              ? `${taggedRelease.slice(0, 8)}…`
              : 'not tagged with a MusicBrainz release'}
          </span>
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
                search to match this against a release, or just edit the fields
              </h4>
            )}

            {/* the album names a release that isn't in these results - worth saying, since
                the top result is otherwise indistinguishable from a confirmed match */}
            {searched && releases.length > 0 && taggedRelease && !foundCurrent && (
              <h5 class="text yellow metadata-status">
                the release this album is tagged with isn't in these results
              </h5>
            )}

            {releases.map((release) => {
              const tracks = releaseTrackCount(release)
              const current = isCurrentRelease(release, taggedRelease)

              return (
                <button
                  key={release.id}
                  type="button"
                  class={`metadata-release${selected?.id === release.id ? ' active' : ''}${current ? ' current' : ''}`}
                  onClick={() => chooseRelease(release)}
                >
                  {current && <span class="metadata-current-badge" title="this album is tagged with this release">current</span>}
                  <span class="metadata-release-title">{release.title}</span>
                  <span class="metadata-release-detail text default-muted">
                    {[release.date?.substring(0, 4), describeRelease(release)].filter(Boolean).join(' · ')}
                  </span>
                  <span class={`metadata-release-tracks${tracks && tracks !== album.track_count ? ' mismatch' : ''}`}>
                    {tracks || '?'} trk
                  </span>
                </button>
              )
            })}
          </div>

          <div class="scrollable metadata-plan">
            <div class="metadata-fields">
              <label class="metadata-field">
                <span class="text default-secondary">artist</span>
                <input class="releases-filter-input" value={fields.artist}
                       onInput={(e) => setField('artist', (e.target as HTMLInputElement).value)} />
              </label>

              <label class="metadata-field">
                <span class="text default-secondary">album</span>
                <input class="releases-filter-input" value={fields.album}
                       onInput={(e) => setField('album', (e.target as HTMLInputElement).value)} />
              </label>

              <label class="metadata-field metadata-field-short">
                <span class="text default-secondary">year</span>
                <input class="releases-filter-input" value={fields.year}
                       onInput={(e) => setField('year', (e.target as HTMLInputElement).value)} />
              </label>

              <label class="metadata-field">
                <span class="text default-secondary">edition</span>
                <input class="releases-filter-input" value={fields.editionLabel}
                       placeholder={plan?.edition_label || 'worked out from the release'}
                       onInput={(e) => setField('editionLabel', (e.target as HTMLInputElement).value)} />
              </label>
            </div>

            <span class="text white-tertiary metadata-hint">
              Blank fields are left alone rather than cleared. The edition names the folder.
            </span>

            <ArtComparison album={album} release={selected} />

            <label class="metadata-checkbox">
              <input type="checkbox" checked={fetchArt}
                     onChange={(e) => setFetchArt((e.target as HTMLInputElement).checked)} />
              <span class="text default-secondary">
                {plan?.art.existing ? `replace ${plan.art.existing}` : 'download cover art'}
              </span>
              <span class="text white-tertiary metadata-hint">
                {plan?.art.existing
                  ? 'this album already has a cover; only overwrite it if the new one is better'
                  : 'from the Cover Art Archive, saved into the album folder'}
              </span>
            </label>

            {planning && <h5 class="text default-muted metadata-status">working out the changes...</h5>}

            {!planning && plan && (
              <>
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
                  <h5 class="text default-muted metadata-status">nothing to change</h5>
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

          {!applied && !applyError && plan && !plan.empty && (
            <span class="text default-muted metadata-summary">
              {plan.changed_file_count} of {plan.file_count} file(s) would change
              {plan.art.action === 'download' ? ', cover art would be downloaded' : ''}
              {plan.art.action === 'replace' ? ', the cover art would be replaced' : ''}
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
