import { useEffect, useRef, useState } from 'preact/hooks'

import { bridge } from '../bridge'
import { useDownloadJobs } from '../hooks/useDownloadJobs'
import { DownloadJobRow } from './DownloadJobRow'

/**
 * The downloads dropdown, in full - toggle, badge, toolbar and list.
 *
 * This owns the whole `#downloads-control` subtree rather than just the list, because split
 * ownership between the vanilla app and this bundle would mean two things toggling the same
 * class. IDs and class names are unchanged so the existing CSS applies untouched.
 *
 * What this replaces: `renderDownloads()` and its 81 lines of `data-job-id` lookup,
 * `insertBefore` and `seen`-set pruning - a hand-written keyed reconciler. `key={job.id}`
 * below is the entire replacement, and it is also what fixes the flicker and lost text
 * selection the manual version was written to avoid in the first place.
 */
export function DownloadsPanel() {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const {
    jobs,
    trackingEnabled,
    speeds,
    activeCount,
    finishedCount,
    error,
    refresh,
    cancel,
    clearFinished,
  } = useDownloadJobs(open)

  // let the vanilla app poke us after it enqueues something
  useEffect(() => {
    const shared = bridge()
    shared.refreshDownloads = refresh

    return () => {
      delete shared.refreshDownloads
    }
  }, [refresh])

  useEffect(() => {
    if (error) console.error(`Downloads refresh error: ${error}`)
  }, [error])

  useEffect(() => {
    if (!open) return

    const onDocumentClick = (event: MouseEvent) => {
      const root = rootRef.current
      if (root && !root.contains(event.target as Node)) setOpen(false)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onKeyDown)

    return () => {
      document.removeEventListener('click', onDocumentClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = (event: MouseEvent) => {
    // without this the document listener above sees the same click and closes it again
    event.stopPropagation()

    const next = !open
    setOpen(next)

    // only one dropdown open at a time
    if (next) bridge().closeOtherDropdowns?.()

    // no explicit refresh here: `open` is a dependency of the polling effect, so changing it
    // already re-runs the effect and polls immediately
  }

  const onClear = (event: MouseEvent) => {
    event.stopPropagation()
    void clearFinished().catch((caught: unknown) => {
      console.error(`Clear jobs error: ${caught instanceof Error ? caught.message : caught}`)
    })
  }

  return (
    <div id="downloads-control" class={open ? 'open' : undefined} ref={rootRef}>
      <button type="button" id="downloads-toggle-button" onClick={toggle}>
        <span>downloads ▾</span>
        {/*
          Not rendered at all when idle, rather than rendered with `hidden`. The vanilla
          version set `.hidden = true` and the badge stayed on screen showing "0", because
          `.log-unread-badge` sets `display: flex` and that beats the browser's `[hidden]`
          rule. main.css now forces `[hidden]` to win, but not depending on the attribute in
          the first place is the sturdier answer.
        */}
        {activeCount > 0 && (
          <span id="downloads-active-badge" class="log-unread-badge">
            {activeCount}
          </span>
        )}
      </button>

      <div id="downloads-window">
        <div id="downloads-toolbar">
          <span id="downloads-summary" class="text default-muted">
            {jobs.length ? `${activeCount} active · ${finishedCount} finished` : ''}
          </span>
          <button
            type="button"
            id="downloads-clear-button"
            disabled={finishedCount === 0}
            onClick={onClear}
          >
            clear finished
          </button>
        </div>

        <div class="scrollable" id="downloads-scrollable">
          <DownloadsList
            jobs={jobs}
            trackingEnabled={trackingEnabled}
            speeds={speeds}
            onCancel={cancel}
          />
        </div>
      </div>
    </div>
  )
}

interface ListProps {
  jobs: ReturnType<typeof useDownloadJobs>['jobs']
  trackingEnabled: boolean
  speeds: Map<number, number>
  onCancel: (jobId: number) => Promise<void>
}

function DownloadsList({ jobs, trackingEnabled, speeds, onCancel }: ListProps) {
  // an unwritable database is not a broken app - downloads still work, they're just not
  // remembered - so this says which knob to turn rather than reading as a crash
  if (!trackingEnabled) {
    return (
      <h4 class="text red candidates-status">
        job tracking is off — the database path isn't writable, check DB_PATH
      </h4>
    )
  }

  if (!jobs.length) {
    return <h4 class="text default-muted candidates-status">nothing downloaded yet</h4>
  }

  return (
    <>
      {jobs.map((job) => (
        <DownloadJobRow
          key={job.id}
          job={job}
          liveSpeed={speeds.get(job.id) ?? null}
          onCancel={onCancel}
        />
      ))}
    </>
  )
}
