import type { DownloadJob } from '../api/types'
import { isActive } from './jobs'

/**
 * Optimistic overlays for the downloads panel.
 *
 * WHAT PROBLEM THIS SOLVES
 *
 * Both actions in that panel cost two sequential round-trips before anything could change on
 * screen: one to jimbrainz - which itself calls on to slskd - and then a poll to see the
 * result. Until both landed, the row was pixel-identical to how it looked before the click.
 * That is the "latency": not that the app was slow, but that it showed nothing at all while
 * it waited for the server to agree.
 *
 * An overlay is a prediction laid over the polled data. The polled data stays authoritative
 * and is never edited, which is what makes this safe - the worst case is a prediction that
 * turns out wrong, and both of the functions below exist to make that case end quickly.
 *
 * Pure, and separate from the hook, for the reason everything else in lib/ is: this is the
 * part with the interesting edge cases, and it can be exercised without a browser or a
 * server. See ui/test/downloads.sim.cjs.
 */

export interface Overlays {
  /** Cancels asked for but not yet confirmed by the server. */
  cancelling: ReadonlySet<number>
  /** Finished jobs optimistically removed by "clear finished". */
  cleared: ReadonlySet<number>
}

export const NO_OVERLAYS: Overlays = { cancelling: new Set(), cleared: new Set() }

/**
 * The jobs the panel should render, with the overlays applied.
 *
 * Cleared rows disappear outright. A cancelling row STAYS - the transfer really is still
 * running until slskd stops it, and removing it would claim something that hasn't happened -
 * but it stops counting as active, so the toolbar summary and the toggle badge both drop on
 * the click rather than a poll later.
 */
export function visibleJobs(jobs: readonly DownloadJob[], overlays: Overlays): DownloadJob[] {
  return overlays.cleared.size ? jobs.filter((job) => !overlays.cleared.has(job.id)) : [...jobs]
}

export function activeCount(jobs: readonly DownloadJob[], overlays: Overlays): number {
  return jobs.filter((job) => isActive(job) && !overlays.cancelling.has(job.id)).length
}

/**
 * Drop any overlay the freshly polled data now agrees with.
 *
 * Reconciled against the DATA rather than against the request completing, and the difference
 * matters: a cancel request returns before the job's status has necessarily changed, so
 * clearing the overlay on completion would flip the row back to "downloading" for one poll
 * before it finally read "cancelled". Waiting for the server's own answer to match removes
 * that flicker entirely.
 *
 * Returns the SAME set objects when nothing changed, so callers can use identity to skip a
 * re-render.
 */
export function reconcile(jobs: readonly DownloadJob[], overlays: Overlays): Overlays {
  const byId = new Map(jobs.map((job) => [job.id, job]))

  let cancelling = overlays.cancelling
  if (cancelling.size) {
    const next = new Set(cancelling)
    for (const id of cancelling) {
      const job = byId.get(id)
      //? Confirmed when the job stops being active, or disappears entirely.
      if (!job || !isActive(job)) next.delete(id)
    }
    if (next.size !== cancelling.size) cancelling = next
  }

  let cleared = overlays.cleared
  if (cleared.size) {
    const next = new Set(cleared)
    //? Confirmed when the job is gone from the server's list.
    for (const id of cleared) if (!byId.has(id)) next.delete(id)
    if (next.size !== cleared.size) cleared = next
  }

  return cancelling === overlays.cancelling && cleared === overlays.cleared
    ? overlays
    : { cancelling, cleared }
}

/** The finished jobs "clear finished" would remove. */
export function finishedIds(jobs: readonly DownloadJob[]): number[] {
  return jobs.filter((job) => !isActive(job)).map((job) => job.id)
}

export function withAdded(set: ReadonlySet<number>, ids: readonly number[]): Set<number> {
  const next = new Set(set)
  for (const id of ids) next.add(id)
  return next
}

export function withRemoved(set: ReadonlySet<number>, ids: readonly number[]): Set<number> {
  const next = new Set(set)
  for (const id of ids) next.delete(id)
  return next
}
