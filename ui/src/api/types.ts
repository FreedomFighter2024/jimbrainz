/**
 * The jimbrainz backend, in types.
 *
 * Derived from the server's own definitions, NOT from the current JS - the vanilla frontend
 * reads some fields loosely and omits others entirely, so copying it would enshrine its
 * guesses. Canonical sources:
 *
 *   src/routes/download.py     pydantic request models + the /jobs response assembly
 *   src/matching.py            score_candidate() - the candidate shape and its signals
 *   src/store.py               job statuses, summarize_transfers()
 *   src/routes/monitor_slskd.py, src/routes/search_musicbrainz.py
 *
 * If you change one of those, change this. Nothing enforces the correspondence.
 */

/* ===== download ===== */

/**
 * Statuses a job can hold. `complete` means downloaded; `organized` means filed into the
 * library. The split matters because organizing is the only step that writes to the user's
 * filesystem and can be off (ORGANIZE_MODE=dry_run) while downloads still succeed.
 */
export type JobStatus =
  | 'queued'
  | 'downloading'
  | 'complete'
  | 'organizing'
  | 'organized'
  | 'failed'
  | 'cancelled'

/** src/store.py OPEN_STATUSES, plus organizing - see ACTIVE_STATUSES in ../lib/jobs.ts */
export type ClearableStatus = Extract<
  JobStatus,
  'complete' | 'organized' | 'failed' | 'cancelled'
>

export interface Track {
  position: number | null
  title: string
  length_ms: number | null
}

/**
 * One row of GET /download/jobs: the stored job merged with live progress from slskd.
 *
 * Progress fields are derived per request rather than persisted (slskd owns them and they
 * change every second), so they are present but meaningless once a job reaches a terminal
 * status.
 */
export interface DownloadJob {
  id: number
  artist: string
  album: string
  year: string | null
  username: string
  directory: string
  status: JobStatus
  error: string | null
  created_at: string

  /** Position in the peer's upload queue. Only ever set for `queued` jobs slskd knows about. */
  queue_position: number | null

  /** 0-100, averaged over the files we asked for rather than the ones slskd reports. */
  progress: number
  /** slskd's raw transfer state string, e.g. "Completed, Succeeded". null when unmatched. */
  state: string | null
  /**
   * slskd's cumulative averageSpeed, summed. This is total bytes over total elapsed, so it
   * only ever creeps upward and never shows the current rate - do NOT render it as a speed.
   * Real speed comes from bytes_transferred deltas between polls (see ../lib/speed.ts).
   */
  speed: number
  bytes_transferred: number
  files_done: number
  files_total: number
  /** Absent unless slskd matched transfers for this job. */
  files_failed?: number
  /** Whether slskd currently knows about any of this job's files. */
  matched: boolean
}

export interface JobsResponse {
  jobs: DownloadJob[]
  /**
   * False when the SQLite store could not be opened. Downloads still work - they're just
   * untracked - so this is a banner, not an error state.
   */
  tracking_enabled: boolean
}

export type FormatPreference = 'prefer_lossless' | 'lossless_only' | 'any'

/** Weighted signals from src/matching.py WEIGHTS. null means "no opinion", not zero. */
export interface CandidateSignals {
  title_match: number | null
  track_count: number | null
  duration_match: number | null
  edition: number | null
  format: number | null
  peer: number | null
}

export type SignalName = keyof CandidateSignals

export interface CandidateFile {
  filename: string
  size: number
}

/** POST /download/find_candidates, after _serialize_candidate() trims it. */
export interface Candidate {
  username: string
  directory: string
  directory_name: string
  score: number
  signals: CandidateSignals
  matched_tracks: number
  expected_tracks: number
  audio_file_count: number
  detected_edition_tags: string[]
  formats: string[]
  /** The peer's upload speed = our download speed, in bits/sec per slskd. */
  upload_speed: number
  queue_length: number
  has_free_slot: boolean
  total_size: number
  bitrates: number[]
  files: CandidateFile[]
}

export interface FindCandidatesRequest {
  artist: string
  album: string
  year?: string | null
  release_mbid?: string | null
  edition_tags?: string[]
  tracks?: Track[]
  format_preference?: FormatPreference
  /** Lets the UI re-run a tweaked query when the generated one finds nothing. */
  query_override?: string | null
}

export interface FindCandidatesResponse {
  query: string
  response_count: number
  candidates: Candidate[]
}

export interface EnqueueRequest {
  username: string
  files: CandidateFile[]
  directory?: string
  /** Persisted denormalized with the job so organizing later needs no MusicBrainz call. */
  release?: {
    artist?: string
    album?: string
    year?: string | null
    release_mbid?: string | null
    edition_tags?: string[]
    tracks?: Track[]
  }
}

export interface EnqueueResponse {
  status: string
  queued: number
  job_id: number
}

export interface CancelJobResponse {
  status: string
  cancelled: number
}

export interface ClearJobsResponse {
  status: string
  removed: number
}

/* ===== monitor_slskd ===== */

export interface ServerConfig {
  library_path: string
  download_path: string
  organizing_enabled: boolean
  organize_mode: string
  /** Reported back deliberately - a LAN address, not a secret. The API key never is. */
  slskd_url: string
  /** Human-readable explanation of why the URL is unusable, or null when it's fine. */
  slskd_url_problem: string | null
  slskd_apikey_set: boolean
}

export interface PingResponse {
  status: string
  code: number
}

/* ===== search_musicbrainz ===== */

/**
 * MusicBrainz shapes are passed through untouched, so these cover the fields the interface
 * actually reads rather than the full schema. The index signature is the escape hatch for
 * everything else - keep new reads typed by adding them here instead of casting.
 */
export interface ArtistCredit {
  name?: string
  artist?: { id?: string; name?: string }
}

export interface Medium {
  'track-count'?: number
  format?: string
}

export interface ReleaseEvent {
  date?: string
  area?: { 'iso-3166-1-codes'?: string[] }
}

export interface LabelInfo {
  'catalog-number'?: string
  label?: { name?: string }
}

export interface Release {
  id: string
  title?: string
  date?: string
  country?: string
  status?: string
  packaging?: string
  disambiguation?: string
  'artist-credit'?: ArtistCredit[]
  media?: Medium[]
  'label-info'?: LabelInfo[]
  'release-events'?: ReleaseEvent[]
  'text-representation'?: { language?: string; script?: string }
  [key: string]: unknown
}

export interface ReleaseGroup {
  id: string
  title?: string
  'first-release-date'?: string
  'primary-type'?: string
  'secondary-types'?: string[]
  'artist-credit'?: ArtistCredit[]
  [key: string]: unknown
}

/**
 * GET /search_musicbrainz/fully_search.
 *
 * Both keys are absent when the query genuinely matched nothing - the endpoint returns `{}`.
 * That is NOT the same as MusicBrainz being unreachable, which is a 503 and arrives as a
 * MusicBrainzUnavailable error. Conflating the two is what made outages look like bad
 * searches; keep them apart.
 */
export interface FullySearchResponse {
  'release-groups'?: ReleaseGroup[]
  'best-match-releases'?: Release[]
}

export interface ReleasesResponse {
  id: string
  releases: Release[]
}

/* ===== library ===== */

export interface LibraryTrack {
  filename: string
  title: string
  /** null when the file carries no readable track number. Sorts last rather than as 0. */
  position: number | null
  /** seconds */
  length: number
  size: number
  format: string
  artist: string
  album: string
  albumartist: string
  date: string
  release_mbid: string
}

export interface LibraryAlbum {
  /**
   * Stable identity. The MusicBrainz release id when the files carry one, otherwise
   * `path:<relative dir>`. Two folders sharing an MBID are the same edition however they're
   * named; a folder without one can only ever be itself.
   */
  key: string
  artist: string
  album: string
  year: string
  /** Human label ("Deluxe edition"). '' for a single-edition album, 'Standard' when it has siblings. */
  edition: string
  release_mbid: string
  /** Relative to LIBRARY_PATH. */
  path: string
  track_count: number
  total_size: number
  /** seconds */
  duration: number
  formats: string[]
  tracks: LibraryTrack[]
  modified_at: number
  /** The folder's files disagree about the album name — usually a real tagging problem. */
  mixed_tags: boolean
  /** How many versions of this (artist, album) are on disk. 1 is the ordinary case. */
  edition_count: number
}

export interface LibraryArtist {
  artist: string
  album_count: number
  track_count: number
  total_size: number
}

export interface LibraryResponse {
  albums: LibraryAlbum[]
  artists: LibraryArtist[]
  library_path: string
  /** Set when the library can't be read at all (unset or missing LIBRARY_PATH). Not an error. */
  problem: string | null
  scanned_at: number
  album_count: number
  artist_count: number
  scan_seconds: number
  /** How many folders came from cache rather than being re-read. */
  cached: number
}

/* ===== interface_logs ===== */

export type LogSource = 'musicbrainz' | 'slskd' | 'jimbrainz' | (string & {})

/** Python levelnames - src/logger.py sends record.levelname straight through. */
export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL' | (string & {})

/**
 * One SSE frame from GET /interface_logs/interface_logs.
 *
 * Note this differs from the table in docs/FRONTEND-MIGRATION.md, which was written from the
 * endpoint signature rather than the emitter: SSEHandler.emit() in src/logger.py also sends
 * `event_time`, and only attaches `src` when the log record carried one. Frames without a
 * `src` are real and must render.
 */
export interface LogEvent {
  /** Pre-formatted "HH:MM:SS" from the server. Not a parseable timestamp. */
  event_time: string
  event_type: LogLevel
  event_content: string
  src?: LogSource
}
