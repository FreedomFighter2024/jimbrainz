import { readPreferences } from '../state/persisted'

import type { DownloadJob } from '../api/types'
import { JOB_STATUS_CLASS, isActive, jobDetailClass, jobDetailText } from '../lib/jobs'

interface Props {
  job: DownloadJob
  /** Derived rate from the byte deltas, or null when it isn't measurable yet. */
  liveSpeed: number | null
  /**
   * This job's cancel has been asked for and the server hasn't confirmed it yet.
   *
   * Owned by useDownloadJobs rather than by local state here, so one fact drives the row,
   * the toolbar summary and the toggle badge together. As local state it moved the button
   * and nothing else, which is why cancelling used to look like nothing had happened.
   */
  cancelling: boolean
  onCancel: (jobId: number) => Promise<void>
}

/**
 * One download.
 *
 * Markup and class names match the vanilla renderer exactly - the 2,245 lines of CSS in
 * interface/styles/main.css are unchanged by this migration on purpose, so that a visual
 * difference means a porting mistake rather than a restyle. Restyling is a separate pass.
 *
 * One thing deliberately NOT carried over: the vanilla renderer toggled a `queued` class on
 * this element when the job was organized. Nothing styles `.download-job.queued` - the only
 * rule is `.candidate-box.queued` - so it was dead.
 */
export function DownloadJobRow({ job, liveSpeed, cancelling, onCancel }: Props) {
  const statusClass = JOB_STATUS_CLASS[job.status] ?? ''
  const percent = Math.round(job.progress || 0)

  const cancel = async (event: MouseEvent) => {
    event.stopPropagation()

    /*
     * Cancelling is not quite reversible: with SLSKD_INCOMPLETE_PATH configured it also
     * deletes the partial file, and either way you lose your place in that peer's queue,
     * which on Soulseek can be the expensive part. Off by default would be the wrong
     * default, so this asks unless you have turned it off in settings.
     *
     * Read at click time, not at render: the preference can change in another tab while a
     * transfer is running, and the value that matters is the one in force when you click.
     */
    if (readPreferences().confirmCancel) {
      const label = [job.artist, job.album].filter(Boolean).join(' — ') || 'this download'
      if (!confirm(`Cancel ${label}?\n\nYou'll lose your place in this peer's queue.`)) return
    }

    try {
      //? The optimistic state is set inside this call, before the request goes out, so the
      //? row changes on the click rather than on the response. Rollback lives there too.
      await onCancel(job.id)
    } catch (error) {
      console.error(`Cancel error: ${error instanceof Error ? error.message : error}`)
    }
  }

  return (
    <div class={`download-job${cancelling ? ' is-cancelling' : ''}`}>
      <div class="download-job-head">
        <h4 class="text white download-job-title">
          {job.artist || 'unknown'} — {job.album || 'unknown'}
        </h4>

        {/*
          While a cancel is in flight the row says so instead of continuing to report the
          status it is in the middle of leaving. Showing "downloading" for the two round-trips
          a cancel takes is what made the button feel like it did nothing.
        */}
        <span class={`download-job-status ${cancelling ? 'mid' : statusClass}`}>
          {cancelling ? 'cancelling…' : job.status}
        </span>

        {/* cancelling only means anything while something is still moving */}
        {isActive(job) && (
          <button
            type="button"
            class="download-cancel-button"
            title="Cancel this download"
            disabled={cancelling}
            onClick={cancel}
          >
            ✕
          </button>
        )}
      </div>

      <div class="download-job-meta">
        <span class="text default-secondary download-job-user">{job.username}</span>
        <span class="text default-muted">·</span>
        <span class={`download-job-detail text ${jobDetailClass(job)}`}>
          {jobDetailText(job, liveSpeed)}
        </span>
      </div>

      <div class="download-progress-track">
        <div
          class={`download-progress-fill ${statusClass}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
