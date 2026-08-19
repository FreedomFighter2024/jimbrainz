import { useMemo, useState } from 'preact/hooks'

import * as libraryApi from '../api/library'
import type { LibraryAlbum } from '../api/types'
import { bridge } from '../bridge'
import { useLibrary } from '../hooks/useLibrary'
import { groupAlbums, type AlbumGroup } from '../lib/groupAlbums'
import { isNewImport, issueLabel, queueAlbums } from '../lib/metadataQueue'
import { DeleteAlbumDialog } from './DeleteAlbumDialog'
import { LibraryAlbumRow } from './LibraryAlbumRow'
import { Loading, LoadingPanel } from './Loading'
import { MetadataEditor } from './MetadataEditor'
import type { TabId } from './Tabs'

interface Props {
  /** The library only loads once this is true — see useLibrary. */
  active: boolean
  onNavigate: (tab: TabId) => void
}

/**
 * Where you are in the review queue.
 *
 * Paths rather than album objects, deliberately. Applying a release rewrites tags and can
 * rename the folder, so an album captured when the queue started is stale the moment you fix
 * it - and holding the objects would mean stepping forward into a copy that no longer matches
 * anything on disk.
 *
 * This is navigation state ONLY. The album on screen is `editing`, which is set from a list
 * the caller is holding rather than derived from `albums` on every render - see the note there.
 */
interface ReviewState {
  paths: string[]
  index: number
}

/**
 * What's already on disk.
 *
 * Laid out like the search view on purpose - filter column on the left, results in the
 * middle, same controls in the same places - because it answers the neighbouring question
 * and shouldn't feel like a different application. The content differs where the question
 * does: there is an edition column here, and no download buttons.
 *
 * It also answers a second question the search view never has to: not just what you have, but
 * what is *wrong* with what you have. The metadata queue lives in this view rather than in a
 * tab of its own because every answer to it is an album in this list - the facets narrow the
 * same list, and reviewing opens the same editor the edit button does.
 */
export function LibraryView({ active, onNavigate }: Props) {
  const {
    albums, artists, queue, issueTypes, reviewTracking,
    problem, error, loading, loaded, scanSeconds, libraryPath, reload,
  } = useLibrary(active)

  const [filter, setFilter] = useState('')
  const [artistFilter, setArtistFilter] = useState<string | null>(null)
  const [multiOnly, setMultiOnly] = useState(false)
  /** Only albums with outstanding metadata issues. */
  const [queueOnly, setQueueOnly] = useState(false)
  /** Narrowed further to one kind of issue, or null for any. */
  const [issueFilter, setIssueFilter] = useState<string | null>(null)
  /** Only albums jimbrainz just filed that haven't been looked at — what the tab badge counts. */
  const [newOnly, setNewOnly] = useState(false)
  /*
   * Only has any effect on mobile, where CSS both reveals the toggle and acts on the class.
   * Starts collapsed because on a phone a 190px artist list above the albums pushes the
   * first one most of the way off the screen, and the albums are what you came for.
   */
  const [filtersCollapsed, setFiltersCollapsed] = useState(true)

  /*
   * Which album the metadata editor is open for, or null. One at a time on purpose - it is an
   * overlay over the whole view, not a per-row inline form.
   *
   * Held as the album itself, and kept up to date explicitly, rather than being derived from
   * `albums` by path on every render. Deriving it looked tidier and was wrong: applying a
   * release renames the folder, so the reloaded library and the queue's own record of where
   * the album now lives are two separate state commits, and for the render in between them
   * NEITHER the old path nor the new one resolves to anything. The editor unmounted mid-queue
   * every time a rename was applied. One value, updated once, cannot disagree with itself.
   */
  const [editing, setEditing] = useState<LibraryAlbum | null>(null)

  //? set alongside `editing` when the editor was opened from the queue rather than from a row
  const [review, setReview] = useState<ReviewState | null>(null)

  /*
   * Bumped every time the queue moves to a different album, and used as the editor's `key`.
   *
   * The editor deliberately does NOT reset itself when its album prop changes - that happens
   * after an apply, where the release list on screen is still the right one and re-searching
   * MusicBrainz would be wasted. Moving to a different album is the opposite case: nothing
   * about the previous one applies, so it wants a genuinely fresh component, which is what
   * changing the key gives us. Re-mounting is also what re-runs its search-on-open, so each
   * album in the queue arrives with candidates already being fetched.
   */
  const [session, setSession] = useState(0)

  //? the album awaiting a delete confirmation, or null
  const [deleting, setDeleting] = useState<LibraryAlbum | null>(null)

  //? grouped first, then filtered, so a filter never splits an album from its own editions
  const groups = useMemo(() => groupAlbums(albums), [albums])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()

    return groups.filter((group) => {
      if (artistFilter && group.artist !== artistFilter) return false
      if (multiOnly && group.editions.length < 2) return false
      if (queueOnly && !group.needsAttention) return false
      if (newOnly && !group.editions.some(isNewImport)) return false
      if (issueFilter && !group.issues.includes(issueFilter)) return false
      if (!needle) return true

      return (
        group.album.toLowerCase().includes(needle) ||
        group.artist.toLowerCase().includes(needle) ||
        group.editions.some((e) => e.edition.toLowerCase().includes(needle))
      )
    })
  }, [groups, filter, artistFilter, multiOnly, queueOnly, newOnly, issueFilter])

  const multiEditionCount = useMemo(
    () => groups.filter((g) => g.editions.length > 1).length,
    [groups],
  )

  //? what "review" would walk through: the queue, narrowed by the issue facet if one is on,
  //? in the order lib/metadataQueue decides
  const waiting = useMemo(() => queueAlbums(albums, issueFilter), [albums, issueFilter])

  /** Issue facets, most-common first, so the biggest job to do is at the top. */
  const issueFacets = useMemo(
    () => Object.entries(queue.by_issue).sort((a, b) => b[1] - a[1]),
    [queue.by_issue],
  )

  //? the tab badge lives in a different render tree and can't see any of this state, so it is
  //? told to recount rather than being left to notice on its own timer - see bridge.ts
  const recountBadge = () => bridge().refreshNewImports?.()

  /**
   * Point the editor at this album's current state, from a list the caller has just received.
   *
   * Always given the freshly loaded array rather than reading `albums`, because the caller is
   * inside the async continuation of a reload and the state it set has not necessarily been
   * committed yet. Reading it there is how the editor ended up showing an album that no longer
   * existed.
   */
  const syncEditing = (fresh: readonly LibraryAlbum[], path: string) => {
    const updated = fresh.find((album) => album.path === path)
    if (updated) setEditing(updated)
    return updated
  }

  const startReview = () => {
    if (!waiting.length) return
    setReview({ paths: waiting.map((album) => album.path), index: 0 })
    setEditing(waiting[0] ?? null)
    setSession((n) => n + 1)
  }

  const leaveQueue = () => {
    const wasReviewing = review !== null

    setEditing(null)
    setReview(null)

    /*
     * Reload once on the way out, not on every step.
     *
     * Stepping through marks each album reviewed on the server, but the facet counts come from
     * the scan payload - so without this you close the queue having just cleared the tab badge
     * while the column still says "newly added 1". Deliberately NOT per step: the walkthrough
     * works from a snapshot so that "next" can't reorder underneath you, and a scan between
     * every album would be paying for a list nothing is reading yet.
     */
    if (wasReviewing) void reload(false)
  }

  const step = (delta: number) => {
    if (!review) return

    //? moving on counts as having looked at it, which is what clears a freshly imported album
    //? from the "something new arrived" prompt. It keeps every issue it had - a queue that
    //? empties because you glanced at things is a queue that lies.
    const leaving = review.paths[review.index]
    if (leaving) {
      void libraryApi.markReviewed(leaving).then(recountBadge).catch(() => undefined)
    }

    const index = Math.min(Math.max(review.index + delta, 0), review.paths.length - 1)
    if (index === review.index) return

    const next = albums.find((album) => album.path === review.paths[index])

    //? The album has gone - deleted, or renamed by something other than an apply here. There
    //? is nothing to show, and this is a click rather than a render, so `albums` is settled
    //? and the absence is real rather than a state update in flight.
    if (!next) {
      leaveQueue()
      return
    }

    setReview({ ...review, index })
    setEditing(next)
    setSession((n) => n + 1)
  }

  const ignoreAlbum = async (album: LibraryAlbum, issues: string[]) => {
    await libraryApi.ignoreIssues(album.path, issues)
    recountBadge()
    //? ignoring changes what the editor should be showing about this album, so it re-resolves
    //? from the reloaded list rather than sitting on the copy it was opened with
    syncEditing(await reload(false), album.path)
  }

  const unignoreAlbum = async (album: LibraryAlbum) => {
    await libraryApi.unignoreAlbum(album.path)
    recountBadge()
    syncEditing(await reload(false), album.path)
  }

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

  const clearFilters = () => {
    setArtistFilter(null)
    setMultiOnly(false)
    setQueueOnly(false)
    setNewOnly(false)
    setIssueFilter(null)
  }

  return (
    <div id="library-content">
      <div id="library-filter-column" class={filtersCollapsed ? 'collapsed' : undefined}>
        <div id="library-filter-header">
          {/* tightened spacing so it can't wrap in a 220px column — see main.css */}
          <h3 class="text default">░▒▓ artists ▓▒░</h3>
          <button
            type="button"
            id="library-clear-filters"
            disabled={!artistFilter && !multiOnly && !queueOnly && !newOnly && !issueFilter}
            onClick={clearFilters}
          >
            clear
          </button>
          <button
            type="button"
            class="filter-collapse-toggle"
            aria-expanded={!filtersCollapsed}
            title="show or hide artists"
            onClick={() => setFiltersCollapsed((on) => !on)}
          >
            {filtersCollapsed ? '▾' : '▴'}
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

        {/*
          The queue, as facets over the same list rather than a separate view. Only rendered
          when there is something in it: a permanent "0 need metadata" heading is a heading you
          stop reading, and then the day it says 12 you don't notice either.
        */}
        {loaded && (queue.total > 0 || queue.new_imports > 0) && (
          <div id="library-queue-facets">
            <h3 class="text default">░▒▓ metadata ▓▒░</h3>

            {/*
              The tab badge counts these, so there has to be a way to see WHICH albums it
              means. Without it the interface said one album wanted attention and then had
              nowhere to point - a freshly imported album with good tags has no issues, so it
              appeared in no facet and in no row chip, and the whole section was hidden when
              nothing else was wrong.
            */}
            {queue.new_imports > 0 && (
              <button
                type="button"
                class={`library-facet newly-added${newOnly ? ' active' : ''}`}
                title="albums jimbrainz just filed that you haven't looked at yet"
                onClick={() => setNewOnly((on) => !on)}
              >
                newly added <span class="library-facet-count">{queue.new_imports}</span>
              </button>
            )}

            {queue.total > 0 && (
              <button
                type="button"
                class={`library-facet needs-attention${queueOnly ? ' active' : ''}`}
                title="albums with something missing or off-convention"
                onClick={() => setQueueOnly((on) => !on)}
              >
                needs attention <span class="library-facet-count">{queue.total}</span>
              </button>
            )}

            {issueFacets.map(([code, count]) => (
              <button
                key={code}
                type="button"
                class={`library-facet library-issue-facet${issueFilter === code ? ' active' : ''}`}
                title={issueTypes[code]?.hint}
                onClick={() =>
                  setIssueFilter((current) => (current === code ? null : code))
                }
              >
                {issueLabel(code, issueTypes)}{' '}
                <span class="library-facet-count">{count}</span>
              </button>
            ))}

            {!reviewTracking && (
              <p class="text yellow library-queue-note">
                ignores can't be saved — the job store couldn't be opened, so albums you accept
                will come back
              </p>
            )}
          </div>
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
            {!loaded ? (
              <Loading label="reading your library" />
            ) : loading ? (
              //? a rescan keeps the previous list on screen, so this says work is happening
              //? without the count vanishing out from under you
              <Loading label={`${groups.length} albums · rescanning`} />
            ) : visible.length === groups.length ? (
              `${groups.length} album${groups.length === 1 ? '' : 's'}`
            ) : (
              `${visible.length} of ${groups.length} albums`
            )}
          </span>

          {/*
            The whole point of the queue: start at the first album that needs something and
            work through them without coming back here between each one. Named for what it
            will actually do, including the narrowing an issue facet applies, so it can't
            surprise you with a hundred albums when you meant the five missing covers.
          */}
          {loaded && waiting.length > 0 && (
            <button
              type="button"
              id="library-review-button"
              title={
                issueFilter
                  ? `work through the ${waiting.length} album(s) with: ${issueLabel(issueFilter, issueTypes)}`
                  : 'work through every album that needs metadata or has just been added, '
                    + 'one at a time - stepping past a new one is what marks it seen'
              }
              onClick={startReview}
            >
              review {waiting.length}
              {issueFilter ? ` · ${issueLabel(issueFilter, issueTypes)}` : ''}
              {!issueFilter && queue.new_imports > 0 ? ` · ${queue.new_imports} new` : ''}
            </button>
          )}

          <button
            type="button"
            class="columns-toggle-button"
            disabled={loading}
            title="re-read every file, ignoring the cache"
            onClick={() => reload(true)}
          >
            {/* no label: the button is narrow and the summary beside it already says what
                is happening */}
            {loading ? <Loading /> : 'rescan'}
          </button>
        </div>

        <div class="scrollable" id="library-scrollable">
          {/* the first scan reads tags off every file, so it is worth saying so */}
          {!loaded && !problem && !error && (
            <LoadingPanel label="reading tags from your library..." />
          )}

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
              issueTypes={issueTypes}
              onSearchArtist={searchArtist}
              onSearchAlbum={searchAlbum}
              onEdit={setEditing}
              onDelete={setDeleting}
              /* the server dropped the folder from its scan cache when it wrote the cover, so
                 a plain reload picks up the new art_mtime and the URL changes with it */
              onArtFetched={() => void reload(false)}
            />
          ))}

          {loaded && albums.length > 0 && (
            <p class="text white-tertiary library-scan-note">
              scanned in {scanSeconds}s
            </p>
          )}
        </div>
      </div>

      {deleting && (
        <DeleteAlbumDialog
          album={deleting}
          onCancel={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null)
            //? the server already dropped it from the scan cache, so a plain reload is enough
            void reload(false)
          }}
        />
      )}

      {editing && (
        <MetadataEditor
          key={session}
          album={editing}
          issueTypes={issueTypes}
          queue={
            review
              ? {
                  position: review.index + 1,
                  total: review.paths.length,
                  onNext: () => step(1),
                  onPrevious: () => step(-1),
                }
              : undefined
          }
          onClose={leaveQueue}
          onIgnore={ignoreAlbum}
          onUnignore={unignoreAlbum}
          /*
            The retag already dropped this folder from the server's cache, so a plain reload
            picks up the new tags and path without a full rescan - but the editor is holding
            the album object it was opened with, which is now stale in every field that just
            changed. Re-resolve it by its new path so the open editor shows what it did.
          */
          onApplied={async (newPath) => {
            const fresh = await reload(false)
            recountBadge()
            syncEditing(fresh, newPath)

            //? the queue is holding paths and this album's has just changed under it, so its
            //? entry moves too - otherwise stepping back to it later would look for a folder
            //? that was renamed out from under the list
            if (review) {
              setReview((current) => current && {
                ...current,
                paths: current.paths.map((path, i) => (i === current.index ? newPath : path)),
              })
            }
          }}
        />
      )}
    </div>
  )
}
