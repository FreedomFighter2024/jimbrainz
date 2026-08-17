/**
 * The seam between the ported components and the vanilla app.
 *
 * `interface/scripts/main.js` is an ES module, so its top-level functions are module-scoped
 * and this bundle cannot call them directly. Rather than making main.js export things - it
 * has no exports and is loaded for side effects - both sides hang the few calls that cross
 * the boundary on one shared object.
 *
 * Keep this small and keep it shrinking. Every entry is a piece of the old app the new one
 * still depends on, so an empty bridge is the signal that the migration is done.
 */
export interface JimbrainzBridge {
  /**
   * Closes the profile and log dropdowns. Set by main.js, called here when the downloads
   * panel opens - only one of the three should ever be open at a time.
   */
  closeOtherDropdowns?: () => void

  /**
   * Forces an immediate downloads poll. Set here, called by main.js after enqueueing a
   * download so the new job appears at once instead of on the next timer tick.
   */
  refreshDownloads?: () => void

  /**
   * Runs a MusicBrainz search on the vanilla side. Set by main.js, called from the library
   * view when an artist or album name is clicked — the search UI hasn't been ported yet, so
   * "take me to this artist" has to hand off rather than re-implement it.
   */
  runSearch?: (query: { artist?: string; album?: string }) => void

  /**
   * Recounts the albums awaiting review. Set by the tab bar's badge, called from the library
   * view after ignoring or reviewing something.
   *
   * Here for the same reason the active tab lives in main.tsx: the tab bar and the library are
   * two separate render trees mounted into distant parts of the vanilla page, so no context or
   * shared hook can span them. This goes away with the rest of the bridge once the search view
   * is ported and there is one root.
   */
  refreshNewImports?: () => void
}

declare global {
  interface Window {
    jimbrainz?: JimbrainzBridge
  }
}

/**
 * Both bundles are modules and load independently, so neither can assume the other has run.
 * Every call through the bridge is user-initiated and therefore long after load, but the
 * object itself has to be safe to touch first.
 */
export function bridge(): JimbrainzBridge {
  window.jimbrainz ??= {}
  return window.jimbrainz
}
