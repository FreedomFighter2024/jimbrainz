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
  /** Last rate actually measured for this job, carried across ticks that saw no movement. */
  rate: number | null
  /** Consecutive polls with no byte movement. Resets on any real change. */
  idle: number
}

/**
 * How many consecutive no-movement polls to keep reporting the last rate for.
 *
 * We poll faster than slskd updates its byte counters, so a zero delta usually means "no
 * news since last time", not "the transfer stopped" - reporting nothing on those ticks makes
 * the speed flicker between a number and "unknown". Four ticks is ~2s at the open cadence,
 * after which a job really has stalled and claiming a speed would be a lie.
 */
const MAX_IDLE_TICKS = 4

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

    if (!previous) {
      samples.set(job.id, { bytes, at: now, rate: null, idle: 0 })
      continue
    }

    const seconds = (now - previous.at) / 1000
    const delta = bytes - previous.bytes

    // a negative delta means slskd restarted or requeued the transfer; drop everything
    // known about it rather than reporting a nonsense number
    if (seconds <= 0 || delta < 0) {
      samples.set(job.id, { bytes, at: now, rate: null, idle: 0 })
      continue
    }

    if (delta === 0) {
      const idle = previous.idle + 1
      // deliberately keeps the previous anchor rather than moving it to `now`: the bytes
      // that arrive next accumulated over the whole quiet stretch, so measuring them
      // against only the final tick would overstate the rate badly
      samples.set(job.id, { ...previous, idle })

      if (previous.rate !== null && idle <= MAX_IDLE_TICKS) speeds.set(job.id, previous.rate)
      continue
    }

    const rate = delta / seconds
    samples.set(job.id, { bytes, at: now, rate, idle: 0 })
    speeds.set(job.id, rate)
  }

  // jobs that vanished from the payload entirely (cleared, deleted) would otherwise leak
  for (const id of samples.keys()) {
    if (!live.has(id)) samples.delete(id)
  }

  return speeds
}
