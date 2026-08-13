/**
 * Display formatting. Behaviour matches the vanilla helpers in interface/scripts/main.js
 * exactly - these render into the same panels, and a unit that changes mid-migration reads
 * as a bug.
 */

/** Bytes per second. Returns 'unknown' for 0/falsy, same as the vanilla helper. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond) return 'unknown'

  const kb = bytesPerSecond / 1024
  if (kb < 1024) return `${Math.round(kb)} KB/s`
  return `${(kb / 1024).toFixed(1)} MB/s`
}

/** Returns '' for 0/falsy so it can be dropped into a joined list without a gap. */
export function formatSize(bytes: number | null | undefined): string {
  if (!bytes) return ''

  const mb = bytes / (1024 * 1024)
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}
