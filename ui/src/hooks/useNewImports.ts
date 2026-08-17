import { useCallback, useEffect, useState } from 'preact/hooks'

import * as api from '../api/library'
import { bridge } from '../bridge'
import type { NewImportsResponse } from '../api/types'

/**
 * How many albums jimbrainz has filed that you haven't looked at yet.
 *
 * This is the "prompt me when a release gets added" half of the metadata queue, and it exists
 * as its own tiny hook because of one constraint: the library is deliberately not scanned until
 * its tab is opened (a first scan reads tags off every file), so anything that wanted to badge
 * the tab from the scan would either be absent exactly when it mattered or would tax every page
 * load. The poller records each album as it files it, so this is one indexed table read and can
 * safely run on mount.
 *
 * Polled slowly rather than pushed. The only thing that changes the count without the user
 * doing anything is a download finishing, which happens on the order of minutes; a live channel
 * for that would be a lot of machinery for a number next to a word. Acting on the queue calls
 * `refreshNewImports` through the bridge instead, so the badge reacts immediately to anything
 * *you* did — the library view lives in a different render tree and can't reach this state any
 * other way (see bridge.ts).
 */
const POLL_INTERVAL_MS = 60_000

export function useNewImports(): NewImportsResponse & { refresh: () => void } {
  const [state, setState] = useState<NewImportsResponse>({
    count: 0, albums: [], tracking_enabled: true,
  })

  const refresh = useCallback(() => {
    void api.newImports()
      .then(setState)
      //? a failure here must be silent. This drives a badge; the library view is where a real
      //? problem with the library gets reported, loudly.
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    refresh()

    const timer = setInterval(refresh, POLL_INTERVAL_MS)

    //? Set rather than called: this is the entry the OTHER tree uses to say "I just reviewed
    //? something, recount". Registered here so it's always the live copy.
    bridge().refreshNewImports = refresh

    return () => {
      clearInterval(timer)
      if (bridge().refreshNewImports === refresh) delete bridge().refreshNewImports
    }
  }, [refresh])

  return { ...state, refresh }
}
