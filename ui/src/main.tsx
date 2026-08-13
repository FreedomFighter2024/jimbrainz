import { render, type VNode } from 'preact'

import { DownloadsPanel } from './components/DownloadsPanel'
import { LibraryView } from './components/LibraryView'
import { Tabs, type TabId } from './components/Tabs'

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
function mount(id: string, node: VNode): void {
  const host = document.getElementById(id)

  if (!host) {
    console.warn(`jimbrainz-ui: no #${id} in the page, skipping that mount`)
    return
  }

  render(node, host)
}

/**
 * The tab bar and the library are two separate mounts in two distant parts of the vanilla
 * page, but they share one piece of state. A context can't span separate render trees, so
 * the active tab lives here and both trees are re-rendered when it changes.
 *
 * Cheap, because it's two small trees and the library's data lives in a hook that survives
 * the re-render rather than being refetched. When the search view is eventually ported this
 * collapses into one root and this function goes away.
 */
function renderShell(active: TabId): void {
  /*
   * Written here, synchronously, rather than from an effect inside <Tabs>. One of the panes
   * this switches between is the vanilla search UI, so the attribute has to land whether or
   * not Preact has got round to flushing effects - and it demonstrably had not when the
   * switch came from a click inside the library tree, which left the tab highlighted with
   * both panes unchanged.
   */
  const container = document.getElementById('main-container')
  if (container) container.dataset['tab'] = active

  mount('tabs-root', <Tabs active={active} onChange={renderShell} />)
  mount('library-root', <LibraryView active={active === 'library'} onNavigate={renderShell} />)
}

mount('downloads-root', <DownloadsPanel />)
renderShell('search')
