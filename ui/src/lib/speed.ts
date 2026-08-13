import type { DownloadJob } from '../api/types'
import { isActive } from './jobs'

/**
 * Deriving a real transfer rate from byte counts.
 *
 * slskd's own `averageSpeed` is cumulative - total bytes moved divided by total elapsed - so
 * it only ever creeps upward and never reflects what is happening right now. The backend
 * passes it through as `job.speed` untouched and expects the caller to do this instead. Do
 * not "simplify" the panel back to rendering `job.speed`; it looks plausible and is wrong.
 *
 * The samples are a rolling measurement, not UI state - keep the Map in a ref.
 */
export interface ByteSample {
  bytes: number
  at: number
}

export type SpeedSamples = Map<number, ByteSample>

/**
 * Fold a fresh /jobs payload into the sample map and return the rates it supports.
 *
 * Jobs missing from the result simply have no measurable rate yet: the first poll for a job
 * has nothing to diff against, and inactive jobs are dropped from the map entirely so a
 * requeued job starts clean rather than diffing against a stale reading.
 */
export function sampleSpeeds(
  samples: SpeedSamples,
  jobs: readonly DownloadJob[],
  now: number = performance.now(),
): Map<number, number> {
  const speeds = new Map<number, number>()
  const live = new Set<number>()

  for (const job of jobs) {
    if (!isActive(job)) {
      samples.delete(job.id)
      continue
    }

    live.add(job.id)

    const bytes = job.bytes_transferred || 0
    const previous = samples.get(job.id)
    samples.set(job.id, { bytes, at: now })

    if (!previous) continue

    const seconds = (now - previous.at) / 1000
    const delta = bytes - previous.bytes

    // a negative delta means slskd restarted or requeued the transfer; report nothing
    // rather than a nonsense number
    if (seconds <= 0 || delta < 0) continue

    speeds.set(job.id, delta / seconds)
  }

  // jobs that vanished from the payload entirely (cleared, deleted) would otherwise leak
  for (const id of samples.keys()) {
    if (!live.has(id)) samples.delete(id)
  }

  return speeds
}
