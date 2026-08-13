import { get } from './http'
import type { PingResponse, ServerConfig } from './types'

/**
 * Server-side settings the interface needs to render. Paths are env-configured and not
 * editable from the UI.
 *
 * `slskd_url_problem` is the useful field: when configuration doesn't survive the trip into
 * the container there is otherwise no way to see what actually arrived, and the failure
 * surfaces as an opaque URL error. Show it when it's set.
 */
export function getConfig(): Promise<ServerConfig> {
  return get<ServerConfig>('/monitor_slskd/config')
}

export function ping(): Promise<PingResponse> {
  return get<PingResponse>('/monitor_slskd/ping')
}
