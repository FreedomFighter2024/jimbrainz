/**
 * The loading indicator.
 *
 * Deliberately not a spinning arc: the interface is built out of ░▒▓ and terminal glyphs, so
 * a smooth rotating circle would read as borrowed from somewhere else. The animation itself
 * lives in main.css (`.loading-blocks` / `.loading-panel`) alongside everything else that
 * owns the look — see the note there about why `content` is animated on steps.
 */

/** Inline, next to a label: "searching ▒█▒". Use when there's already something on screen. */
export function Loading({ label }: { label?: string }) {
  return (
    <span class="loading-blocks text default-muted" role="status" aria-live="polite">
      {label ? <span>{label}</span> : null}
    </span>
  )
}

/**
 * Centred in an otherwise empty panel.
 *
 * Takes a label because "loading" on its own tells you nothing about why you're waiting -
 * a first library scan reads tags off every file and can genuinely take a while, and that's
 * much easier to sit through when the screen says so.
 */
export function LoadingPanel({ label }: { label: string }) {
  return (
    <div class="loading-panel" role="status" aria-live="polite">
      <span>{label}</span>
    </div>
  )
}
