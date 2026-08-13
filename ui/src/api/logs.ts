import { url } from './http'
import type { LogEvent } from './types'

/**
 * Subscribe to the backend log stream.
 *
 * This is Server-Sent Events, not fetch - the endpoint is a StreamingResponse that stays
 * open and emits `:\n\n` keepalives every 15s when idle. EventSource skips comment frames
 * on its own, so keepalives never reach `onEvent`.
 *
 * EventSource also reconnects by itself after a dropped connection, which is why there is no
 * retry logic here. Returns an unsubscribe function; call it on unmount or the server keeps
 * a queue alive for a client that's gone.
 */
export function subscribeToLogs(
  onEvent: (event: LogEvent) => void,
  onError?: (error: Event) => void,
): () => void {
  const source = new EventSource(url('/interface_logs/interface_logs'))

  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data) as LogEvent)
    } catch {
      // a malformed frame shouldn't tear down the stream - the next one is probably fine
    }
  }

  if (onError) source.onerror = onError

  return () => source.close()
}
