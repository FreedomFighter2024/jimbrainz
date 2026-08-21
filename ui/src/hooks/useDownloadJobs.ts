import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'

import * as api from '../api/download'
import type { DownloadJob } from '../api/types'
import { isActive } from '../lib/jobs'
import {
  activeCount as countActive, finishedIds, reconcile, visibleJobs, withAdded, withRemoved,
  type Overlays,
} from '../lib/downloadOverlay'
import { sampleSpeeds, type SpeedSamples } from '../lib/speed'

/*
 * Fast while you're watching, slow in the background just to keep the badge honest.
 *
 * The open cadence is faster than slskd refreshes its own byte counters, so a good share of
 * these polls return identical numbers. That's fine for progress - it just means the bar
 * doesn't move - but it's why ../lib/speed.ts holds the last measured rate across quiet
 * ticks instead of reporting "unknown" every other second.
 *
 * Note the speed is NOT recomputed per poll. ../lib/speed.ts measures it over a one-second
 * window and so publishes a new figure once a second whatever this cadence is; the extra polls
 * feed progress and status, and their bytes accumulate into the next window rather than being
 * thrown away. Changing the numbers here does not change how often the speed updates.
 *
 * Each open poll is one request to jimbrainz and, while anything is downloading, one onward
 * request to slskd. Going below ~500ms starts being rude to slskd for no visible gain.
 */
const POLL_OPEN_MS = 500
const POLL_BACKGROUND_MS = 5000

export interface DownloadJobsState {
  jobs: DownloadJob[]
  /** False when the SQLite store isn't writable. Downloads still work, just untracked. */
  trackingEnabled: boolean
  /** Derived transfer rates by job id. Absent means "not measurable yet", not "zero". */
  speeds: Map<number, number>
  activeCount: number
  finishedCount: number
  /** Set when the last poll failed. Polling continues regardless. */
  error: string | null
  /**
   * Jobs whose cancel has been asked for but not yet confirmed by the server.
   *
   * Rendered as "cancelling…" so the click has a visible consequence immediately. Cancelling
   * costs two sequential round-trips - one to jimbrainz and on to slskd, then a poll to see
   * the result - and until this existed the row was identical for both of them.
   */
  cancelling: ReadonlySet<number>
  refresh: () => void
  cancel: (jobId: number) => Promise<void>
  clearFinished: () => Promise<void>
}

/**
 * How long an unconfirmed optimistic state is allowed to stand.
 *
 * The reconcile in the poll below clears these as soon as the server agrees, which is the
 * normal path. This is the safety valve for when it never does: an optimistic state that
 * outlives the request stops being a prediction and becomes a lie, and a row that says
 * "cancelling…" forever while the file is still downloading is worse than one that never
 * said it.
 */
const OPTIMISTIC_TTL_MS = 15000

/**
 * Poll /download/jobs and derive everything the panel renders.
 *
 * Polling deliberately continues in the background while work is outstanding so the badge
 * stays truthful, and always runs while the panel is open even when idle so a download
 * started in another tab appears without a reload. When nothing is moving and nobody is
 * looking, it stops completely.
 */
export function useDownloadJobs(open: boolean): DownloadJobsState {
  const [jobs, setJobs] = useState<DownloadJob[]>([])
  const [trackingEnabled, setTrackingEnabled] = useState(true)
  const [speeds, setSpeeds] = useState<Map<number, number>>(() => new Map())
  const [error, setError] = useState<string | null>(null)

  // a rolling measurement rather than UI state, so it lives in a ref and never triggers a
  // render on its own
  const samplesRef = useRef<SpeedSamples>(new Map())

  // bumping this re-runs the effect, which is how an external event (a download was just
  // enqueued, a job was cancelled) forces an immediate poll instead of waiting out the timer
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  /*
   * Optimistic overlays, applied on top of whatever the last poll returned.
   *
   * Both actions in this panel used to await a round-trip to jimbrainz - which itself calls
   * slskd - and THEN a further poll before anything on screen moved. That is the latency:
   * not that the app was slow, but that it showed nothing at all until the server had
   * finished agreeing. These make the click land immediately and let the poll confirm it.
   *
   * They are overlays rather than edits to `jobs` so the polled data stays authoritative -
   * nothing here can corrupt it, and the reconcile below simply stops overlaying once the
   * server's own answer says the same thing.
   */
  const [overlays, setOverlays] = useState<Overlays>(() => ({
    cancelling: new Set<number>(),
    cleared: new Set<number>(),
  }))

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async (): Promise<void> => {
      let hasActive = false

      try {
        const response = await api.listJobs()
        if (cancelled) return

        hasActive = response.jobs.some(isActive)
        setSpeeds(sampleSpeeds(samplesRef.current, response.jobs))
        setJobs(response.jobs)

        //? Drop any overlay the freshly polled data now agrees with. Returns the same
        //? object when nothing changed, so this cannot cause a pointless re-render.
        setOverlays((current) => reconcile(response.jobs, current))

        setTrackingEnabled(response.tracking_enabled)
        setError(null)
      } catch (caught) {
        if (cancelled) return
        // keep trying rather than dying silently on one bad response
        setError(caught instanceof Error ? caught.message : 'failed to fetch download jobs')
      }

      if (cancelled) return
      if (!hasActive && !open) return

      timer = setTimeout(() => void tick(), open ? POLL_OPEN_MS : POLL_BACKGROUND_MS)
    }

    void tick()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [open, nonce])

  /** Stop overlaying ids the server never confirmed. See OPTIMISTIC_TTL_MS. */
  const expire = useCallback((key: keyof Overlays, ids: number[]) => {
    setTimeout(() => {
      setOverlays((current) => ({ ...current, [key]: withRemoved(current[key], ids) }))
    }, OPTIMISTIC_TTL_MS)
  }, [])

  const cancel = useCallback(
    async (jobId: number) => {
      //? Set BEFORE the request goes out. That ordering is the entire fix.
      setOverlays((current) => ({ ...current, cancelling: withAdded(current.cancelling, [jobId]) }))
      expire('cancelling', [jobId])

      try {
        await api.cancelJob(jobId)
        refresh()
      } catch (caught) {
        //? Roll back, so the row stops claiming something that did not happen.
        setOverlays((current) => ({
          ...current,
          cancelling: withRemoved(current.cancelling, [jobId]),
        }))
        throw caught
      }
    },
    [refresh, expire],
  )

  const clearFinished = useCallback(async () => {
    const ids = finishedIds(jobs)
    if (!ids.length) return

    setOverlays((current) => ({ ...current, cleared: withAdded(current.cleared, ids) }))
    expire('cleared', ids)

    try {
      await api.clearJobs()
      samplesRef.current.clear()
      refresh()
    } catch (caught) {
      setOverlays((current) => ({ ...current, cleared: withRemoved(current.cleared, ids) }))
      throw caught
    }
  }, [jobs, refresh, expire])

  //? What the panel renders: the polled jobs with the overlays applied.
  const shown = useMemo(() => visibleJobs(jobs, overlays), [jobs, overlays])
  const active = useMemo(() => countActive(shown, overlays), [shown, overlays])

  return {
    jobs: shown,
    trackingEnabled,
    speeds,
    activeCount: active,
    finishedCount: shown.length - active,
    error,
    cancelling: overlays.cancelling,
    refresh,
    cancel,
    clearFinished,
  }
}
