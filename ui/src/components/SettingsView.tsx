import { useEffect, useState } from 'preact/hooks'

import { getServerSettings, type ServerSetting, type ServerSettings } from '../api/settings'
import type { FormatPreference } from '../api/types'
import { LoadingPanel } from './Loading'
import { useDownloadDefaults, usePreferences } from '../state/persisted'

/**
 * The settings tab.
 *
 * It has TWO halves with genuinely different natures, and the whole design follows from
 * keeping them apart rather than blending them into one list of controls:
 *
 *   PREFERENCES are yours, live in localStorage, and are editable here. They save on change -
 *   there is no save button, because there is nothing to fail and nothing to lose.
 *
 *   SERVER CONFIGURATION arrives as environment variables read once at container start. It is
 *   READ-ONLY and can only be read-only: nothing this app writes could change a variable the
 *   process already booted with. Rendering it as disabled inputs would imply otherwise, so it
 *   renders as a diagnostic report instead - the value received, which file supplied it, and
 *   what is wrong with it if anything.
 *
 * That second half is the reason this tab is worth having at all. "The path is set, looks
 * right, and points somewhere the container can't see" is the most common first-run failure
 * in this project, and it is invisible from the value alone.
 *
 * This replaces the old "download profile" dropdown in the top bar, which held a format
 * radio, an auto-grab checkbox and a read-only library path.
 */

const FORMAT_PREFERENCES: { id: FormatPreference; name: string; note: string }[] = [
  { id: 'any', name: 'Any format', note: 'rank on everything else; format is not considered' },
  { id: 'prefer_lossless', name: 'Prefer lossless', note: 'FLAC scores higher, MP3 still eligible' },
  { id: 'lossless_only', name: 'Lossless only', note: 'lossy candidates are excluded outright' },
]

/* ============================================================================
 * Small shared pieces
 * ==========================================================================*/

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: preact.ComponentChildren
}) {
  return (
    <section class="settings-section">
      <h3 class="settings-section-title">{title}</h3>
      {note ? <p class="settings-section-note">{note}</p> : null}
      <div class="settings-section-body">{children}</div>
    </section>
  )
}

/** A labelled preference row. The label is the hit target, so the whole row is clickable. */
function Row({
  label,
  hint,
  control,
  htmlFor,
}: {
  label: string
  hint?: string
  control: preact.ComponentChildren
  htmlFor?: string
}) {
  return (
    <div class="settings-row">
      <div class="settings-row-text">
        <label class="settings-row-label" for={htmlFor}>
          {label}
        </label>
        {hint ? <span class="settings-row-hint">{hint}</span> : null}
      </div>
      <div class="settings-row-control">{control}</div>
    </div>
  )
}

function Toggle({
  id,
  checked,
  onChange,
}: {
  id: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <input
      id={id}
      type="checkbox"
      class="settings-toggle"
      checked={checked}
      onChange={(e) => onChange((e.currentTarget as HTMLInputElement).checked)}
    />
  )
}

/* ============================================================================
 * Server configuration - the diagnostic half
 * ==========================================================================*/

function SettingRow({ setting }: { setting: ServerSetting }) {
  /*
   * An unset OPTIONAL setting is not a problem and must not look like one. Only `error` gets
   * a colour - if every row is decorated, the one that actually needs attention doesn't
   * stand out, which is the entire job of this list.
   */
  const shown =
    setting.value === null
      ? setting.required
        ? 'not set'
        : 'not set (optional)'
      : setting.secret
        ? '•••••••• (set)'
        : setting.value

  return (
    <div class={`settings-env settings-env-${setting.status}`}>
      <div class="settings-env-head">
        <code class="settings-env-key">{setting.key}</code>
        {setting.source ? (
          <span class="settings-env-source" title="which file supplied this value">
            from {setting.source}
          </span>
        ) : null}
        {setting.status === 'error' ? <span class="settings-env-badge">needs attention</span> : null}
      </div>

      <div class="settings-env-value">{shown}</div>
      <div class="settings-env-effect">{setting.effect}</div>

      {setting.detail ? <div class="settings-env-detail">{setting.detail}</div> : null}
    </div>
  )
}

/* ============================================================================
 * The tab
 * ==========================================================================*/

export function SettingsView({ active }: { active: boolean }) {
  const [defaults, saveDefaults] = useDownloadDefaults()
  const [prefs, savePrefs, resetPrefs] = usePreferences()

  const [server, setServer] = useState<ServerSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  /*
   * Fetched when the tab is first opened, not on mount. The settings tab is the least-visited
   * of the three and this walks the filesystem to check every configured path - no reason to
   * pay for that on every page load. Refetched on each open so a fixed volume mapping shows
   * as fixed without a reload.
   */
  useEffect(() => {
    if (!active) return

    let cancelled = false
    setLoading(true)

    getServerSettings()
      .then((data) => {
        if (!cancelled) {
          setServer(data)
          setError(null)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'could not read settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [active])

  if (!active) return null

  return (
    <div id="settings-content">
      <div class="settings-scroll scrollable">
        {/* ===== preferences: yours, editable, saved as you change them ===== */}

        <Section
          title="Downloads"
          note="Applied when jimbrainz ranks Soulseek candidates and when you grab one."
        >
          <div class="settings-radio-group" role="radiogroup" aria-label="format preference">
            {FORMAT_PREFERENCES.map((format) => (
              <label
                key={format.id}
                class={`settings-radio${defaults.formatPreference === format.id ? ' active' : ''}`}
              >
                <input
                  type="radio"
                  name="format-preference"
                  value={format.id}
                  checked={defaults.formatPreference === format.id}
                  onChange={() => saveDefaults({ formatPreference: format.id })}
                />
                <span class="settings-radio-name">{format.name}</span>
                <span class="settings-radio-note">{format.note}</span>
              </label>
            ))}
          </div>

          <Row
            label="Auto-grab best match"
            hint="queue the top-ranked candidate immediately instead of opening the panel to choose"
            htmlFor="pref-auto-grab"
            control={
              <Toggle
                id="pref-auto-grab"
                checked={defaults.autoGrab}
                onChange={(autoGrab) => saveDefaults({ autoGrab })}
              />
            }
          />

          <Row
            label="Confirm before cancelling"
            hint="ask first when cancelling a transfer that's already running"
            htmlFor="pref-confirm-cancel"
            control={
              <Toggle
                id="pref-confirm-cancel"
                checked={prefs.confirmCancel}
                onChange={(confirmCancel) => savePrefs({ confirmCancel })}
              />
            }
          />
        </Section>

        <Section
          title="Search"
          note="Starting values for a new search. Both can still be changed per-search without changing the default."
        >
          <Row
            label="Results per search"
            hint="how many release groups MusicBrainz is asked for. It caps a page at 100."
            htmlFor="pref-search-limit"
            control={
              <div class="settings-number">
                <input
                  id="pref-search-limit"
                  type="number"
                  min={1}
                  max={100}
                  value={prefs.searchLimit}
                  onChange={(e) =>
                    savePrefs({ searchLimit: Number((e.currentTarget as HTMLInputElement).value) })
                  }
                />
              </div>
            }
          />

          <Row
            label="Studio albums only, by default"
            hint="excludes live albums, compilations, interviews and demos from the QUERY - which is what makes it worth doing, since MusicBrainz spends the limit on whatever matches"
            htmlFor="pref-studio-only"
            control={
              <Toggle
                id="pref-studio-only"
                checked={prefs.searchStudioOnly}
                onChange={(searchStudioOnly) => savePrefs({ searchStudioOnly })}
              />
            }
          />
        </Section>

        <Section
          title="Soulseek candidates"
          note="Where the filters in the candidates panel start. Changing them there is temporary; changing them here is the default."
        >
          <Row
            label="Minimum score"
            hint="hide candidates ranking below this, 0 shows everything"
            htmlFor="pref-min-score"
            control={
              <div class="settings-slider">
                <input
                  id="pref-min-score"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={prefs.candidateMinScore}
                  onInput={(e) =>
                    savePrefs({
                      candidateMinScore: Number((e.currentTarget as HTMLInputElement).value),
                    })
                  }
                />
                <span class="settings-slider-value">{prefs.candidateMinScore}</span>
              </div>
            }
          />

          <Row
            label="Free slot only"
            hint="only peers who can start sending now, rather than queueing you"
            htmlFor="pref-free-slot"
            control={
              <Toggle
                id="pref-free-slot"
                checked={prefs.candidateFreeSlotOnly}
                onChange={(candidateFreeSlotOnly) => savePrefs({ candidateFreeSlotOnly })}
              />
            }
          />

          <Row
            label="Complete albums only"
            hint="candidates holding at least as many tracks as the release you picked"
            htmlFor="pref-complete-only"
            control={
              <Toggle
                id="pref-complete-only"
                checked={prefs.candidateCompleteOnly}
                onChange={(candidateCompleteOnly) => savePrefs({ candidateCompleteOnly })}
              />
            }
          />
        </Section>

        <Section title="Interface">
          <Row
            label="Open the log on start"
            hint="useful while you're still confirming a new install is behaving"
            htmlFor="pref-log-open"
            control={
              <Toggle
                id="pref-log-open"
                checked={prefs.logOpenOnStart}
                onChange={(logOpenOnStart) => savePrefs({ logOpenOnStart })}
              />
            }
          />

          <Row
            label="Reset preferences"
            hint="puts everything above back to its default. Does not touch server configuration."
            control={
              <button type="button" class="settings-reset-button" onClick={resetPrefs}>
                reset
              </button>
            }
          />
        </Section>

        {/* ===== server configuration: read-only, diagnostic ===== */}

        <div class="settings-divider">
          <h3 class="settings-section-title">Server configuration</h3>
          <p class="settings-section-note">
            Set by environment variables, read once when the container started — so these are
            read-only here, and editing them means editing your compose file or{' '}
            <code>.env</code> and restarting. What this shows is the value the container{' '}
            <em>actually received</em>, and which of those two files supplied it.
          </p>
        </div>

        {loading && !server ? <LoadingPanel label="reading configuration" /> : null}

        {error ? (
          <div class="settings-error">
            <h4 class="text red">could not read the server configuration</h4>
            <p class="text default-muted">{error}</p>
          </div>
        ) : null}

        {server ? (
          <>
            {/*
              The organizing verdict goes FIRST and is stated as a single sentence, because
              "why did nothing get filed" has four possible causes spread across two groups
              below. Answering it once beats making someone infer it from four rows.
            */}
            <div
              class={`settings-verdict${server.organizing.enabled ? ' ok' : ''}`}
              role="status"
            >
              <span class="settings-verdict-title">
                {server.organizing.enabled
                  ? 'Organizing is active — finished downloads will be tagged and filed.'
                  : 'Organizing will not file anything right now.'}
              </span>

              {server.organizing.blockers.length ? (
                <ul class="settings-verdict-list">
                  {server.organizing.blockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              ) : null}
            </div>

            {server.groups.map((group) => (
              <Section key={group.id} title={group.label} note={group.note}>
                <div class="settings-env-list">
                  {group.settings.map((setting) => (
                    <SettingRow key={setting.key} setting={setting} />
                  ))}
                </div>
              </Section>
            ))}

            <Section
              title="Organize modes"
              note="What ORGANIZE_MODE can be set to, least to most destructive."
            >
              <div class="settings-env-list">
                {Object.entries(server.organize_modes).map(([mode, description]) => (
                  <div key={mode} class="settings-mode">
                    <code class="settings-mode-name">{mode}</code>
                    <span class="settings-mode-note">{description}</span>
                  </div>
                ))}
              </div>
            </Section>
          </>
        ) : null}
      </div>
    </div>
  )
}
