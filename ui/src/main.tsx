import { render, type ComponentType } from 'preact'

import { DownloadsPanel } from './components/DownloadsPanel'

/**
 * Entry point for the ported interface.
 *
 * During the migration this bundle is loaded by the vanilla `interface/index.html` as one
 * extra module script, and mounts into placeholders that page provides. Anything not yet
 * ported keeps being rendered by interface/scripts/main.js as before.
 *
 * Each mount is looked up independently and skipped when missing, so the dev harness in
 * ui/index.html can render a single panel in isolation without stubbing the rest of the page.
 */
const MOUNTS: ReadonlyArray<[id: string, component: ComponentType]> = [
  ['downloads-root', DownloadsPanel],
]

for (const [id, Component] of MOUNTS) {
  const host = document.getElementById(id)

  if (!host) {
    console.warn(`jimbrainz-ui: no #${id} in the page, skipping that mount`)
    continue
  }

  render(<Component />, host)
}
