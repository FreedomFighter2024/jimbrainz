import { render, type VNode } from 'preact'

import { DownloadsPanel } from './components/DownloadsPanel'
import { LibraryView } from './components/LibraryView'
import { SettingsView } from './components/SettingsView'
import { Tabs, type TabId } from './components/Tabs'
import { useNewImports } from './hooks/useNewImports'

/**
 * The tab bar, plus the count of albums waiting to be looked at.
 *
 * A component rather than a call inside renderShell because the count comes from a hook, and
 * hooks need somewhere to live across renders. Re-rendering the shell diffs into the same host
 * rather than remounting, so the poll survives switching tabs.
 *
 * The count is deliberately not derived from the library scan: the library isn't read until
 * you open its tab, so a badge that waited for that would be missing at exactly the moment it
 * has something to say. It comes from the rows the poller writes as it files each download.
 */
function TabBar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  const { count } = useNewImports()
  return <Tabs active={active} onChange={onChange} badges={{ library: count }} />
}

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

  mount('tabs-root', <TabBar active={active} onChange={renderShell} />)
  mount('library-root', <LibraryView active={active === 'library'} onNavigate={renderShell} />)
  mount('settings-root', <SettingsView active={active === 'settings'} />)
}

mount('downloads-root', <DownloadsPanel />)
renderShell('search')
