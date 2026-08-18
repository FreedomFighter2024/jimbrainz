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
  /** When that rate was measured, so it can be aged out in seconds rather than in polls. */
  rateAt: number
}

/**
 * How long to keep reporting the last measured rate once the byte counter goes quiet.
 *
 * We poll faster than slskd updates its byte counters, so a zero delta usually means "no news
 * since last time" rather than "the transfer stopped" - and reporting nothing on those polls
 * makes the speed flicker between a number and nothing at all while the transfer is in fact
 * moving at a perfectly steady rate.
 *
 * WALL TIME, not a number of polls, and that distinction is the whole point. This was four
 * polls, which the comment described as "~2s at the open cadence" - true only at that cadence.
 * The panel polls every 500ms open and every 5s in the background, and browsers throttle
 * background tabs further still, so the same constant meant 2 seconds in one situation and 20+
 * in another: flickering when watched, and confidently reporting a long-dead rate when not.
 * Measured against a steady 1 MB/s transfer, a slskd counter refreshing every 5s left the speed
 * blank on 54% of polls, in gaps of up to 5 seconds.
 *
 * Six seconds covers the slowest counter refresh observed with margin, and is short enough that
 * a genuinely stalled transfer stops claiming a speed promptly rather than lying for 20s.
 */
const STALE_RATE_MS = 6000

/**
 * The shortest window a rate is measured over, and therefore how often the figure changes.
 *
 * Those are deliberately the same number rather than a measurement plus a display throttle.
 * Publishing a new figure twice a second gives you one that is hard to read AND noisier than
 * it needs to be: a short window quantises badly against slskd's own counter, so the value
 * jumps around far more than the transfer actually does. Measuring across a full second costs
 * nothing, steadies the number, and updates it at a rate a person can actually follow.
 *
 * The panel keeps polling at its own faster cadence - progress and status stay responsive, and
 * the bytes arriving in between are not discarded, they accumulate into the next window.
 *
 * A slower poll cadence than this (the 5s background one) simply publishes on every poll; you
 * cannot measure more often than you look.
 */
const SPEED_UPDATE_MS = 1000

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
      samples.set(job.id, { bytes, at: now, rate: null, rateAt: now })
      continue
    }

    const elapsed = now - previous.at
    const delta = bytes - previous.bytes

    // a negative delta means slskd restarted or requeued the transfer; drop everything
    // known about it rather than reporting a nonsense number
    if (elapsed <= 0 || delta < 0) {
      samples.set(job.id, { bytes, at: now, rate: null, rateAt: now })
      continue
    }

    /*
     * Nothing new to publish yet - either the window isn't a full second old, or the byte
     * count hasn't moved since it opened.
     *
     * Both cases deliberately KEEP the existing anchor rather than moving it to `now`. The
     * bytes that arrive next accumulated over the whole window, so measuring them against
     * only the final poll would overstate the rate badly - and that is also what lets a
     * faster poll cadence feed a one-second measurement instead of fighting it.
     */
    if (elapsed < SPEED_UPDATE_MS || delta === 0) {
      samples.set(job.id, previous)

      if (previous.rate !== null && now - previous.rateAt <= STALE_RATE_MS) {
        speeds.set(job.id, previous.rate)
      }
      continue
    }

    const rate = delta / (elapsed / 1000)
    samples.set(job.id, { bytes, at: now, rate, rateAt: now })
    speeds.set(job.id, rate)
  }

  // jobs that vanished from the payload entirely (cleared, deleted) would otherwise leak
  for (const id of samples.keys()) {
    if (!live.has(id)) samples.delete(id)
  }

  return speeds
}
