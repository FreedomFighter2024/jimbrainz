export type TabId = 'search' | 'library'

interface Tab {
  id: TabId
  label: string
}

/*
 * Settings is the third tab this shell exists for - the deferred settings pane goes here
 * with no structural change, just another entry and another pane. Adding it means adding a
 * `#settings-root` beside the other panes and a rule in main.css.
 */
const TABS: readonly Tab[] = [
  { id: 'search', label: 'search' },
  { id: 'library', label: 'library' },
]

interface Props {
  active: TabId
  onChange: (tab: TabId) => void
  /** Per-tab counts. Only rendered when non-zero — see the badge below. */
  badges?: Partial<Record<TabId, number>>
}

/**
 * The top-level view switcher. Purely presentational.
 *
 * Which pane is actually visible is driven by a `data-tab` attribute on #main-container,
 * written by the shell in main.tsx rather than by an effect in here. That was a real bug:
 * as an effect it silently didn't fire when the shell re-rendered from another tree's event
 * handler, leaving the tab button highlighted while the panes never swapped. A DOM write
 * against an element outside this component's tree isn't this component's job.
 */
export function Tabs({ active, onChange, badges }: Props) {
  return (
    <div id="view-tabs" role="tablist">
      {TABS.map((tab) => {
        const badge = badges?.[tab.id] ?? 0

        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            class={`view-tab${active === tab.id ? ' active' : ''}`}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {/*
              Rendered only when there is something to say. A badge sitting on 0 is how the
              other three badges in this interface ended up invisible to everyone including the
              code that thought it had hidden them - see the `hidden` note in CLAUDE.md.
            */}
            {badge > 0 && (
              <span
                class="view-tab-badge"
                title={`${badge} newly added album(s) you haven't looked at`}
              >
                {badge}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
