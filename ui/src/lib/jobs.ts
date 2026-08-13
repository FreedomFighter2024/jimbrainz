import type { DownloadJob, JobStatus } from '../api/types'
import { formatSpeed } from './format'

/**
 * Statuses that mean work is outstanding.
 *
 * `organizing` is included even though the server's OPEN_STATUSES (src/store.py) excludes
 * it: the server uses that set to decide whether to ask slskd for transfers, which is
 * pointless once downloading is done, whereas the UI needs to keep polling through the
 * filing step or the panel goes quiet before the job actually finishes.
 */
export const ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set<JobStatus>([
  'queued',
  'downloading',
  'organizing',
])

export function isActive(job: DownloadJob): boolean {
  return ACTIVE_STATUSES.has(job.status)
}

/** Maps a status onto the existing good/mid/bad colour classes in interface/styles/main.css. */
export const JOB_STATUS_CLASS: Readonly<Record<JobStatus, string>> = {
  queued: 'mid',
  downloading: 'mid',
  complete: 'good',
  organizing: 'mid',
  organized: 'good',
  failed: 'bad',
  cancelled: 'bad',
}

/**
 * The second line of a job row.
 *
 * `liveSpeed` is the derived rate from ../lib/speed.ts, never job.speed - that field is
 * slskd's cumulative average and only ever creeps upward.
 */
export function jobDetailText(job: DownloadJob, liveSpeed: number | null): string {
  if (job.error) return job.error

  const parts = [`${job.files_done}/${job.files_total} files`]

  // where we are in the peer's upload queue - the difference between "stuck" and "waiting
  // my turn behind 40 people", which is otherwise invisible
  if (job.queue_position !== null && job.queue_position !== undefined) {
    parts.push(`queue #${job.queue_position}`)
  }

  if (liveSpeed) parts.push(formatSpeed(liveSpeed))

  return parts.join(' · ')
}

/** Colour class for that second line: a hard failure reads red, a recovered note yellow. */
export function jobDetailClass(job: DownloadJob): string {
  if (job.status === 'failed') return 'red'
  if (job.error) return 'yellow'
  return 'default-secondary'
}
