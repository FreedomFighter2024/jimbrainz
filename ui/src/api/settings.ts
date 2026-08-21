import { get, put } from './http'

/**
 * The server's configuration, as this process actually received it.
 *
 * Read-only on purpose, and the tab says so - see the long note at the top of
 * src/routes/settings.py. Everything here comes from environment variables read once at
 * startup, so there is nothing the app could write that would change them.
 */

/**
 * `ok` - set and usable.
 * `unset` - not set, and that's allowed (optional setting).
 * `error` - set but unusable, or required and missing. The only one worth a colour.
 */
export type SettingStatus = 'ok' | 'unset' | 'error'

export interface ServerSetting {
  /** The environment variable name, shown verbatim - it's what you go and edit. */
  key: string
  /** The received value, or null. Always null for secrets - see `secret`. */
  value: string | null
  /** "the container environment" | ".env" | null. Which file to go and edit. */
  source: string | null
  status: SettingStatus
  /** What is wrong, in words, when something is. */
  detail: string | null
  /** What this setting actually controls. */
  effect: string
  required: boolean
  /**
   * The API key. Its value never leaves the server; `value` is the literal string 'set' or
   * null, which is enough to diagnose "downloads don't work" without putting a credential
   * into a screenshot somebody pastes into an issue.
   */
  secret: boolean
  /** Whether this can be changed here at all. False for DB_PATH - see `locked_reason`. */
  editable: boolean
  /**
   * Why it can't be, in words, when it can't. Rendered verbatim: a disabled control with no
   * explanation reads as a bug rather than as a decision.
   */
  locked_reason: string | null
  /**
   * True when this value came from the settings tab rather than from the environment. A
   * stored override WINS over the environment, which is the only honest precedence - the
   * alternative is edits silently reverting on restart. But an override nobody can see is
   * invisible state, so the tab says so and offers to revert.
   */
  overridden: boolean
  /** What reverting would restore. Always null for secrets. */
  env_value: string | null
}

export interface SettingGroup {
  id: string
  label: string
  note: string
  settings: ServerSetting[]
}

export interface ServerSettings {
  /** The running jimbrainz version, from src/__init__.py. Rendered in the tab's footer. */
  version: string
  /** Always false today. Present so the tab states it rather than implying it. */
  editable: boolean
  groups: SettingGroup[]
  organize_modes: Record<string, string>
  /**
   * Whether organizing can actually happen, and every reason it can't.
   *
   * Derived server-side and deliberately reported as a list: "why did nothing get filed" has
   * four separate possible causes, and checking them one at a time is how people conclude
   * the feature is broken.
   */
  organizing: { enabled: boolean; blockers: string[] }
}

export function getServerSettings(): Promise<ServerSettings> {
  return get<ServerSettings>('/settings')
}

/** One setting to change. A null value means "revert to the environment's value". */
export interface SettingUpdate {
  key: string
  value: string | null
}

/**
 * Save a batch of settings and get the re-read state back.
 *
 * A batch, not one call per setting, because the tab saves with one button and a
 * half-applied save is the worst outcome available - some settings changed, some not, and no
 * way to tell which by looking. The server validates the whole batch before writing any of
 * it, and answers with the full settings payload so the tab renders what actually landed
 * rather than what it hoped for.
 */
export function saveServerSettings(updates: SettingUpdate[]): Promise<ServerSettings> {
  return put<ServerSettings>('/settings', updates)
}
