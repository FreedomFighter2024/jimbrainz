import { useCallback, useState } from 'preact/hooks'

import type { FormatPreference } from '../api/types'

/**
 * localStorage-backed state.
 *
 * These keys are already set in users' browsers by the vanilla app. Changing a key name or a
 * value shape silently resets everyone's preferences, so treat them as a compatibility
 * surface: read defensively, keep the serialization identical, and reconcile unknown values
 * rather than discarding the whole blob.
 */
export const STORAGE_KEYS = {
  downloadDefaults: 'jimbrainz-download-defaults',
  releaseColumns: 'jimbrainz-release-columns',
  logOpen: 'jimbrainz-log-open',
} as const

/*
 * Every access is guarded. localStorage throws rather than returning null in private
 * browsing and when the quota is exceeded, and losing a preference is not a reason to take
 * the panel down with it.
 */

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable - skip persisting, don't fail the interaction
  }
}

function readJson<T>(key: string): T | null {
  const raw = readRaw(key)
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : null
  } catch {
    return null
  }
}

/* ===== jimbrainz-download-defaults ===== */

export interface DownloadDefaults {
  formatPreference: FormatPreference
  autoGrab: boolean
}

const DOWNLOAD_DEFAULTS_FALLBACK: DownloadDefaults = {
  formatPreference: 'prefer_lossless',
  autoGrab: false,
}

/**
 * Merged over the fallback rather than replacing it: the vanilla app persists whatever
 * partial object it happens to hold, so a stored blob may be missing either field.
 */
export function useDownloadDefaults(): [
  DownloadDefaults,
  (partial: Partial<DownloadDefaults>) => void,
] {
  const [value, setValue] = useState<DownloadDefaults>(() => ({
    ...DOWNLOAD_DEFAULTS_FALLBACK,
    ...(readJson<Partial<DownloadDefaults>>(STORAGE_KEYS.downloadDefaults) ?? {}),
  }))

  const update = useCallback((partial: Partial<DownloadDefaults>) => {
    setValue((current) => {
      const next = { ...current, ...partial }
      writeRaw(STORAGE_KEYS.downloadDefaults, JSON.stringify(next))
      return next
    })
  }, [])

  return [value, update]
}

/* ===== jimbrainz-log-open ===== */

/**
 * Stored as the literal string '1' or '0', NOT as JSON. The vanilla app compares
 * `getItem(...) === '1'`, so writing `true` here would read back as closed for anyone who
 * still lands on the un-ported page.
 */
export function useLogOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readRaw(STORAGE_KEYS.logOpen) === '1')

  const update = useCallback((next: boolean) => {
    writeRaw(STORAGE_KEYS.logOpen, next ? '1' : '0')
    setOpen(next)
  }, [])

  return [open, update]
}

/* ===== jimbrainz-release-columns ===== */

export interface ReleaseColumnState {
  order: string[]
  visible: Record<string, boolean>
  widths: Record<string, number>
}

/**
 * Read the stored column layout, or null when there isn't a usable one.
 *
 * Deliberately returns the raw stored shape without reconciling it. The vanilla loader
 * filters the saved order against the current column set and backfills anything new, which
 * is what stops a version that adds a column from hiding it forever - but that needs the
 * column definitions, which land with the releases-grid port (step 5 in
 * docs/FRONTEND-MIGRATION.md). Do the reconciliation there; don't drop it.
 */
export function readReleaseColumnState(): ReleaseColumnState | null {
  const saved = readJson<Partial<ReleaseColumnState>>(STORAGE_KEYS.releaseColumns)

  if (!saved || !Array.isArray(saved.order) || typeof saved.visible !== 'object') return null

  return {
    order: saved.order,
    visible: saved.visible ?? {},
    widths: saved.widths ?? {},
  }
}

export function writeReleaseColumnState(state: ReleaseColumnState): void {
  writeRaw(STORAGE_KEYS.releaseColumns, JSON.stringify(state))
}
