import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks'

import * as api from '../api/download'
import type { DownloadJob } from '../api/types'
import { isActive } from '../lib/jobs'
import { sampleSpeeds, type SpeedSamples } from '../lib/speed'

// fast while you're watching, slow in the background just to keep the badge honest
const POLL_OPEN_MS = 1000
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
  refresh: () => void
  cancel: (jobId: number) => Promise<void>
  clearFinished: () => Promise<void>
}

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

  const cancel = useCallback(
    async (jobId: number) => {
      await api.cancelJob(jobId)
      refresh()
    },
    [refresh],
  )

  const clearFinished = useCallback(async () => {
    await api.clearJobs()
    samplesRef.current.clear()
    refresh()
  }, [refresh])

  const activeCount = useMemo(() => jobs.filter(isActive).length, [jobs])

  return {
    jobs,
    trackingEnabled,
    speeds,
    activeCount,
    finishedCount: jobs.length - activeCount,
    error,
    refresh,
    cancel,
    clearFinished,
  }
}
