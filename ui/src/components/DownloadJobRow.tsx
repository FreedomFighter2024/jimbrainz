import { useState } from 'preact/hooks'

import { readPreferences } from '../state/persisted'

import type { DownloadJob } from '../api/types'
import { JOB_STATUS_CLASS, isActive, jobDetailClass, jobDetailText } from '../lib/jobs'

interface Props {
  job: DownloadJob
  /** Derived rate from the byte deltas, or null when it isn't measurable yet. */
  liveSpeed: number | null
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
export function DownloadJobRow({ job, liveSpeed, onCancel }: Props) {
  const [cancelling, setCancelling] = useState(false)

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

    setCancelling(true)

    try {
      await onCancel(job.id)
    } catch (error) {
      console.error(`Cancel error: ${error instanceof Error ? error.message : error}`)
      setCancelling(false)
    }
    // on success the job leaves the active set and this row stops rendering the button, so
    // there is nothing to re-enable
  }

  return (
    <div class="download-job">
      <div class="download-job-head">
        <h4 class="text white download-job-title">
          {job.artist || 'unknown'} — {job.album || 'unknown'}
        </h4>

        <span class={`download-job-status ${statusClass}`}>{job.status}</span>

        {/* cancelling only means anything while something is still moving */}
        {isActive(job) && (
          <button
            type="button"
            class="download-cancel-button"
            title="cancel this download"
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
