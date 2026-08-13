# Frontend migration: vanilla → Preact + Vite + TypeScript

Everything a fresh session needs to start. The decision is settled (see CLAUDE.md); this is
the how.

## Ground rules

1. **Incremental, not big-bang.** There are zero frontend tests. A full rewrite has no safety
   net, so port panel by panel and keep the app working at every commit.
2. **The library window is the first workload.** It's new, so there's nothing to break — build
   it in Preact and let it prove the setup before touching working panels.
3. **Do not carry the two performance bugs across** (details below). They're the actual cause
   of the "lag" complaint, and they're just as reproducible in Preact.
4. **The CSS survives as-is initially.** 2,245 lines of accreted styling own the CRT aesthetic.
   Port markup to components first, restyle later as a separate deliberate pass. Changing both
   at once means you can't tell which broke it.

## Toolchain setup

```
ui/                      # new — Vite root
  index.html
  src/
    main.tsx
    api/                 # typed fetch wrappers, one per backend module
    components/
    state/
  tsconfig.json
  vite.config.ts
  package.json
interface/               # existing vanilla app — stays until fully replaced
```

`vite.config.ts` essentials:

```ts
export default defineConfig({
  plugins: [preact()],
  build: { outDir: '../interface/dist', emptyOutDir: true },
  server: { proxy: { '/jimbrainz': 'http://127.0.0.1:8080' } },  // dev against the real API
})
```

The proxy matters: it lets `npm run dev` hit the real FastAPI backend without CORS work.

### Dockerfile

Becomes multi-stage. Current build is `pip install` only, so this is the real cost of the
decision:

```dockerfile
FROM node:22-alpine AS ui
WORKDIR /ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build          # emits into interface/dist

FROM python:3.14-slim
# ... existing gosu + pip layers unchanged ...
COPY --from=ui /interface/dist ./interface/dist
```

**Check `src/api/app.py` when you do this.** The `revalidate_interface_assets` middleware
matches `/scripts/`, `/styles/`, `/assets/` — Vite emits hashed filenames under a different
path. Hashed assets are immutable and *should* be cached hard; only `index.html` needs
`no-cache`. Update the middleware or you'll reintroduce the "I upgraded and nothing changed"
problem the middleware exists to prevent.

## API surface to type

Write `ui/src/api/types.ts` from these. All prefixed `/jimbrainz/`.

| endpoint | method | notes |
| --- | --- | --- |
| `search_musicbrainz/fully_search?query=&limit=` | GET | returns `{release-groups, best-match-releases}`. **503 = MusicBrainz unreachable**, distinct from empty results — surface it as such. |
| `search_musicbrainz/releases?release_group_mbid=` | GET | `{id, releases}` |
| `search_musicbrainz/ping` | GET | `{status, code}` |
| `monitor_slskd/ping` | GET | `{status, code}` |
| `monitor_slskd/config` | GET | `{library_path, download_path, organizing_enabled, organize_mode, slskd_url, slskd_url_problem, slskd_apikey_set}` |
| `download/find_candidates` | POST | body: `{artist, album, year, release_mbid, edition_tags, tracks[], format_preference, query_override}` → `{query, response_count, candidates[]}` |
| `download/enqueue` | POST | body: `{username, files[], directory, release}` → `{status, queued, job_id}` |
| `download/jobs` | GET | `{jobs[], tracking_enabled}` |
| `download/jobs/{id}/cancel` | POST | |
| `download/jobs/clear` | POST | |
| `interface_logs/interface_logs` | GET | **SSE stream**, not fetch. `{event_type, event_content, src}` |

Canonical shapes are in `src/routes/download.py` (pydantic models) and
`src/matching.py::score_candidate` (candidate shape). Derive the TS types from those rather
than from the current JS.

### localStorage keys to preserve

Users have these set; don't orphan them.

- `jimbrainz-download-defaults` — `{formatPreference, autoGrab}`
- `jimbrainz-release-columns` — `{order, visible, widths}`
- `jimbrainz-log-open` — `'1'|'0'`

## What to port, in order

| # | component | source | notes |
| --- | --- | --- | --- |
| 1 | **Library window** | *new* | the point of the exercise; nothing to break |
| 2 | Downloads panel | `renderDownloads` + 81 lines of manual reconciliation | biggest immediate win — `key={job.id}` deletes all of it |
| 3 | Candidates panel | `renderCandidates`, filters, signal sliders | self-contained |
| 4 | Filter column | `renderFacets`, tri-state facets | |
| 5 | Releases grid | `buildReleasesGrid` (312 lines) | hardest. Consider TanStack Table via `preact/compat` — it replaces the column resize/reorder/visibility code wholesale, and TanStack Virtual fixes the DOM-size problem structurally |
| 6 | Top bar, log, profile | `init.js` + dropdowns | |

## State model

Seven module-level mutable objects become explicit state. They're small enough that Preact
signals or a couple of contexts will do — no Redux.

| current | becomes |
| --- | --- |
| `columnState` (persisted) | table config state + localStorage effect |
| `globalFilterState` (text + tri-state facets) | filter state |
| `candidateFilterState` (incl. `minSignals`) | candidates-panel local state |
| `downloadDefaults` (persisted) | settings state |
| `lastCandidateResult` | query result |
| `jobSpeedSamples` | keep as a plain `Map` in a ref — it's a rolling sample, not UI state |
| `mountedReleaseGrids` | **delete entirely** — a hand-rolled subscription system that props replace |

## Two bugs that must not survive the port

Profiled, with numbers, in CLAUDE.md. Both are trivially reintroducible in Preact.

1. **Eager hidden DOM.** `renderBody` builds every release's full track list up front even
   though it's hidden until clicked — ~half the entire DOM. In Preact write
   `{expanded && <Tracks/>}`. Do not render collapsed content.
2. **Forced synchronous layout.** `checkScrollability()` reads `scrollHeight`/`clientHeight`,
   forcing a full-document re-layout — measured up to **962 ms**. Called from 6 places
   including every expand toggle. Replace with CSS (`overflow: auto` handles scrollbars
   without measuring) or `ResizeObserver`. **Never read layout properties in a render path.**

## Verification while working

- `.venv/bin/python -m pytest tests/ -q` — 96 tests, all backend. Unaffected by this work;
  if they break, something is wrong beyond the frontend.
- **Verify UI against computed styles and DOM state, not screenshots.** The preview pane has
  repeatedly served stale composites — it once showed a panel as transparent when computed
  styles proved it opaque.
- When checking colours, remember `theme.css` is `@import`ed and caches independently of
  `main.css`. Bust it explicitly.

## Definition of done for the migration

`interface/scripts/` and `interface/index.html` are gone, `interface/dist/` is the only
served frontend, and the Dockerfile's `ui` stage builds it. Until then both coexist — that's
expected, not a mess to clean up prematurely.
