# jimbrainz — working context

Read this before doing anything. It records decisions and hard-won gotchas that aren't
recoverable from the code, so you don't re-litigate settled questions or re-discover
problems the expensive way.

## What this is

A fork of [LidBrainz](https://github.com/dual-shock/lidbrainz) that has diverged a long way.
Upstream sends releases to Lidarr. **This fork removed Lidarr entirely and talks to slskd
directly.**

Repo: `real-lizardwizard/jimbrainz` · owner is James Barnett (jamesambarnett@gmail.com).

### Branches

| branch | what |
| --- | --- |
| `main` | the old Lidarr-based line, v0.2.1. Untouched by the rewrite, and now behind it. |
| `experimental/slskdn-no-lidarr` | **all the work below.** slskd-direct, no Lidarr. Releases are tagged from here — v0.3.0 onward. |

### Why Lidarr was dropped

Not preference — a specific failure. Pick a *particular* release (the 2011 remaster, the
deluxe edition) and every distinguishing detail dies at Lidarr's API boundary:
`POST /command {name:"AlbumSearch", albumIds:[N]}` carries no tracklist, no edition, no year.
The plugin doing the actual Soulseek search rebuilds a generic query and grabs whatever
returns. Tubifarry's own maintainer
[confirms Custom Formats can't target a selected release variant](https://github.com/TypNull/Tubifarry/discussions/138).

jimbrainz already knows all of it, so it owns the search and the matching itself.

**Honest limitation, stated in the README and worth preserving:** this does not reliably
auto-detect remasters. Soulseek folder names are typed by strangers and often omit edition
text. Edition is a *weighted signal, never a hard filter* — filtering on it hides real
results. The promise is ranked candidates with visible reasoning, not magic.

## Architecture

Python 3.12+ / FastAPI backend, static frontend, SQLite for job state.

```
src/
  config.py        env + validation. describe_slskd_url() explains WHY a URL is unusable.
  matching.py      PURE candidate scoring. No I/O. The heart of the project.
  editions.py      PURE. Which edition a release is, in words. See below — it's why the
                   library can hold the deluxe and the standard press at the same time.
  metadata_health.py  PURE. What's WRONG with an album on disk, as issue codes. Backs the
                   metadata queue. Derived on every request, never stored — see below.
  library.py       scans LIBRARY_PATH with mutagen, cached per folder on mtime. Also
                   finds cover art (file beside the tracks, else embedded in the audio).
  store.py         SQLite job store + transfer reconciliation helpers.
  poller.py        background task: slskd transfers -> job status transitions.
  organizer.py     writes downloads into the library. Plan/execute split, dry_run default.
  retag.py         the metadata manager's write half - applies a chosen release to an album
                   already on disk. Same plan/execute split, for the same reasons.
  api/             musicbrainz_endpoint.py, slskd_endpoint.py, coverart_endpoint.py, app.py
  routes/          search_musicbrainz, download, monitor_slskd, interface_logs, library
interface/         vanilla JS/CSS. Still the served page; main.js is shrinking as panels
                   are ported. main.css (~3,500 lines) styles BOTH halves - see below.
  dist/            BUILT from ui/, gitignored. Not present in a fresh checkout.
ui/                Preact + Vite + TypeScript. New work goes here — see below.
tests/             257 tests, all Python, all fixture-driven
```

API routes are prefixed **`/jimbrainz/`** (renamed from `/lidbrainz/`).

### The flow

MusicBrainz search → pick a release → slskd search → rank candidates against that release's
real tracklist → enqueue → poller watches transfers → organizer tags and files the result.

## Decisions that should not be re-opened

- **Matching is pure.** `matching.py` does no I/O so it's testable without slskd. Keep it that way.
- **Plan/execute split in the organizer.** `plan_organization()` is pure; `execute_plan()` acts.
  This is what makes dry-run trustworthy — it runs the *identical* plan and declines to execute.
- **The release is stored denormalized** in the job row, not as a bare MBID. MusicBrainz goes
  down often (it did, repeatedly, during development); organizing a finished download must not
  depend on it being reachable.
- **Progress is never persisted.** slskd owns it, it changes every second. Derived on read,
  divided by files *wanted* rather than files slskd currently reports.
- **`ORGANIZE_MODE` defaults to `dry_run`.** Organizing is the only thing that writes to the
  user's filesystem. A fresh install reports what it *would* do.
- **Edition matching is a weighted signal, never a filter.** See above.
- **The folder is named after the album's year, not the pressing's.** A 2011 remaster of a
  1975 record files under `Wish You Were Here (1975) [Remastered]`. The year identifies the
  album and the edition identifies the pressing; using the reissue year would file the same
  record under two different decades depending on which copy you got. It comes from
  MusicBrainz's release-GROUP `first-release-date` (`original_year` on the payload, written
  to the `originaldate` tag); the `date` tag still records this pressing's own year. Absent
  `original_year` the behaviour is exactly as before, so nothing already filed moves.
- **The metadata editor searches with a FIELDED query**, like the search view, built from its
  artist and album fields. Free text matched a one-track 2013 release group for "Pink Floyd
  Wish You Were Here" — the song, not the album — and since the folder year comes from the
  group, matching the wrong group dated the folder wrong. Fielded found 127 releases where
  free text found 4. It falls back to free text when the fielded query returns nothing.
- **An album's folder carries its edition, and identity lives in the tags.**
  `{artist}/{album} ({year}) [{edition}]`, with the suffix omitted for ordinary
  single-edition albums so the common case stays clean. The label is resolved by
  `editions.py` from MusicBrainz's own `disambiguation` first, then detected edition tags,
  then format/country — and a collision with a *different* release escalates to the
  catalogue number and finally the release id. `release.edition_label` overrides all of it
  and is the hook for the planned metadata manager: choosing an edition by hand should mean
  writing that field, not changing how editions are resolved.
  **An untagged folder is never treated as a different release** — libraries predating
  jimbrainz have no MBIDs, and forking every one of those albums would be far worse than
  sharing a folder.
- **Deleting an album is the only thing here that removes data the user did not just
  download, and it has no undo**, so `delete_album()` carries every guard: inside
  LIBRARY_PATH, never the root itself, and **audio must sit DIRECTLY in the folder**. That
  last one is not cosmetic — a recursive check happily accepts an artist folder and takes
  the whole discography, which a test caught. The confirmation is a real dialog rather than
  `confirm()` because it names the track count, the size and any non-audio files, which
  might be the only copy of a rip log or cue sheet.
- **There are now TWO writers to the user's filesystem**, and both use the same plan/execute
  split: `organizer.py` files downloads in, `retag.py` corrects albums already there. A
  preview that disagrees with the write it previews is worse than no preview, so both derive
  the tags from one shared `organizer.tag_values()` rather than computing them twice. The
  apply endpoint **recomputes the plan** rather than accepting the previewed one back — a
  plan is a list of file operations, and taking one over the wire would let a caller name
  arbitrary paths to write to.
- **The metadata queue stores only what you IGNORED.** What is *wrong* with an album is
  derived from the scan on every request by the pure `metadata_health.py`, never written down.
  A "needs attention" flag that is stored is a flag that goes stale the moment something fixes
  the album without clearing it; deriving it means a fixed album leaves the queue on its own.
  The `album_review` table therefore holds four things and no verdicts: when an album was first
  seen, whether jimbrainz filed it or merely found it, whether you've looked at it, and which
  issue codes you've accepted.
  **Ignores are per issue, not per album** — accepting that a bootleg will never be in
  MusicBrainz must not also silence the day its cover art goes missing.
  **`album_review` is keyed on the album's path**, not the scan's `key`: that key is the
  release MBID when there is one, and two folders holding the same release deliberately share
  it, so ignoring one would silently ignore the other. The cost is that a rename orphans the
  row, which is why `mark_album_reviewed()` takes a destination and the retag endpoint passes
  it.
- **The new-import prompt is recorded at import time, not derived from a scan.** The library is
  deliberately not read until its tab is opened, so a badge that had to diff two scans would
  need a scan to exist — absent at exactly the moment it has something to say. The poller writes
  one row as it files each download, and `/queue/new_imports` is a single indexed count that
  touches no filesystem. This is the only reason the import source is recorded at all.
- **Errors degrade rather than crash.** Unwritable DB → downloads still work, untracked.
  Unreachable slskd → stored jobs still listed, no live progress. Unwritable DB → the metadata
  queue still works, it just stops remembering what you ignored.

## Gotchas discovered the hard way

Each of these cost real time. Don't rediscover them.

### Interface and CSS

- **`theme.css` is `@import`ed from `main.css`, so it caches independently.** Editing the
  palette and reloading shows the OLD colours. Bust it explicitly when verifying, and
  hard-refresh after deploying.
- ~~Text colour classes are element-scoped~~ **Fixed at the root.** Colour was an element ×
  colour matrix (`h4.default`, `h5.white`, `span.white-secondary`…), so every unforeseen
  pairing inherited instead — `<div class="text white-secondary">` had no rule and rendered
  black on black. There are now element-agnostic `.white`, `.default-secondary` etc. at lower
  specificity than the legacy rules, so old pairings are untouched and new ones just work.
  **`body` also sets `font-family` and `color`**, so a missed element now degrades to looking
  ordinary rather than disappearing. Prefer the generic classes for new markup.
- **Nothing had set a font on `body`**, so any element without its own rule fell back to
  Times at 16px. That is how the releases-grid `▷` arrows and `#results-summary` shipped in
  a serif face. Fixed by the `body` baseline above.
- **A Preact `useEffect` that writes to a DOM node outside its own tree is unreliable.** The
  tab bar set `data-tab` on `#main-container` from an effect; when the tab was changed by a
  click originating in the *library* tree, the effect didn't fire and the button highlighted
  while the panes never swapped. Cross-tree DOM writes belong in the shell (`main.tsx`),
  done synchronously. Symptom to recognise: the component looks right, the page doesn't.
- **The layout had no media queries at all until v0.3.x.** On a 375px phone it produced
  1131px of content — 756px unreachable off the right edge, with the entire top-bar actions
  row off-screen. Three causes: `#top-bar` was a nowrap flex row of `flex-shrink: 0`
  children, `#main-content` put a fixed 220px filter column beside the content leaving 155px,
  and the dropdown panels were 440–460px wide. **Anything new with a fixed px width needs a
  mobile rule**, and the responsive block at the bottom of `main.css` is where it goes.
- **The filter columns collapse on mobile and the class is inert on desktop.** Both the
  vanilla and Preact columns always carry `collapsed`; only the `max-width: 768px` block acts
  on it. Don't "tidy" that by removing the class on desktop — it's what keeps one code path.
- **The loading indicator animates `content`**, swapping ░▒▓█ on `steps(1)` — see
  `.loading-blocks` in main.css. A rotating arc would have looked borrowed from another
  application; these are the same glyphs the filter headings use, so they are known to render
  in the bundled font. Verified by sampling the computed `::before` content over time, since
  animating `content` is the part that could silently do nothing.
- **Decorated headings wrap if you let them.** `░ ▒ ▓ filters ▓ ▒ ░` measured 138px in a
  190px header that also holds a "clear" button, so a lone `░` wrapped onto a second line and
  the whole column read as broken. Tightened to `░▒▓ filters ▓▒░` and pinned `nowrap`. Any
  new decorated heading in a fixed-width column needs the same treatment.
- **`hidden` did nothing to any badge.** `.log-unread-badge` and `.signals-badge` both set
  `display`, which beats the browser's `[hidden] { display: none }` — so all three badges sat
  on screen showing `0` while their JS believed it had hidden them. Found by checking
  `getBoundingClientRect()` after `el.hidden` read back `true`; it is invisible to any check
  that trusts the property. `main.css` now forces `[hidden]` to win. **`hidden` reading
  `true` is not evidence an element is hidden — measure it.**
- **The downloads panel vanishes if `ui/` hasn't been built.** `interface/index.html` loads
  `dist/jimbrainz-ui.js`, which is gitignored and generated. Running from source without
  `npm run build` leaves it 404ing and that panel simply absent. Check this first.
- **Don't derive an overlay's subject from a list that a write reloads.** The metadata editor
  originally resolved its album by looking `review.paths[index]` up in `albums` on every
  render. Applying a release renames the folder, so the reloaded library and the queue's record
  of where the album now lives land in *two separate state commits* — and for the render
  between them **neither the old path nor the new one resolves**, so the editor unmounted
  mid-queue every time a rename was applied. It now holds the album itself and is updated once,
  explicitly, from the array `reload()` resolves with (never from `albums`, which the caller's
  own `await` has not necessarily committed yet). One value updated once cannot disagree with
  itself.
- **The editor is keyed on a step counter, and that is load-bearing in both directions.** It
  must NOT reset when its album prop changes — that happens after an apply, where the release
  list on screen is still right and re-searching MusicBrainz would be waste. It MUST reset when
  the queue moves to a different album, since nothing about the previous one applies. A `key`
  that changes only on navigation is what buys both; keying on `album.path` or `album.key`
  would break the first, because an apply changes them.
- **New chips in the album rows do not shrink, and the row is a nowrap flex.** Adding the issue
  chips pushed the edit and delete buttons to 399px and 428px on a 375px screen — unreachable,
  with no horizontal scroll to go find them. It also took "Selected Ambient Works 85-92" from
  84px to **9px**, because the chips carry `flex-shrink: 0` and the titles don't. Both are
  fixed in the responsive block (`.library-album-head` wraps, `.library-album-titles` claims
  60%). **Anything else added to those rows needs measuring at 375px**, not eyeballing.

### Backend and data

- **slskd's `averageSpeed` is cumulative** (total bytes ÷ total elapsed), so it only ever
  creeps upward and never shows the current rate. Real speed is derived from `bytesTransferred`
  deltas between polls. Don't "simplify" back to `averageSpeed`.
- **An unrecognised slskd transfer substate is a permanently stuck job.** This was predicted in
  "What the tests cannot tell you" below and then happened: `summarize_transfers` knew about
  `"Completed, Succeeded"`, `"Errored"` and `"Cancelled"`, so **`"Completed, Rejected"` counted
  as neither done nor failed**. A refused download sat at `queued` forever — the interface
  renders that as "hasn't started yet" — and because slskd *was* reporting the transfers, the
  unmatched-transfer grace period never applied either. Nothing could clear it but hand-editing
  the DB. Every terminal substate now lives in `TRANSFER_FAILURE_REASONS` in `store.py` with the
  sentence shown to the user. **If slskd grows another substate, add it there.**
- **Never take a word apart to build a search query.** `build_search_query` used to strip all
  punctuation to spaces, so Metallica's **`S&M2` was searched for as `S M2`** — and found
  nothing. If Soulseek tokenizes on non-alphanumerics (which is what the failure looks like),
  the folder `Metallica - S&M2 (2020)` holds `metallica/s/m/2` and there is **no `m2` token in
  it**, so we asked for a term that exists on neither side. The album name silently vanished
  from its own search.
  The rule now: **punctuation between two alphanumerics is part of the word and stays**
  (`S&M2`, `R&B`, `AC/DC`, `Jay-Z`, `That's`); punctuation standing on its own is dropped
  (`Simon & Garfunkel`, `(Deluxe)`, `Guns N'`). Whatever Soulseek does to `S&M2` in the query it
  does to `S&M2` in the folder name, and that is a far better bet than guessing on its behalf —
  splitting it ourselves is the one option that is wrong under *both* readings of how it
  matches.
  **A first attempt got this wrong in an instructive way**: it kept the splitting and dropped
  the one-character debris instead, which fixed nothing here (`S M2` → `M2`, still no match) and
  quietly turned `Vol. 2` into `Vol`. Length is not the signal — position is.
- **`request_with_retries` returns an error dict rather than raising.** Reaching straight for
  `["release-groups"]` produced a `KeyError` that surfaced as *"Error searching MusicBrainz:
  'release-groups'"* — which reads like a bad query, so an outage looked like user error.
  `MusicBrainzUnavailable` now distinguishes them.
- **docker-compose: never declare a var in both `env_file` and `environment:`.** `environment:`
  wins and re-interpolates `${VAR}` from compose's own env; when that comes back empty it
  silently overwrites the good value from `.env`. This produced an unusable empty `SLSKD_URL`.
- **`.env` values must not have trailing `# comments`.** Compose and python-dotenv disagree
  about inline comments. Examples go on their own lines.
- **Two editions of one album used to silently not arrive.** `{album} ({year})` gave the
  standard and deluxe press identical paths; `execute_plan` correctly refused to overwrite,
  so every track was *skipped* — and the poller only reported a problem when
  `organized == 0 AND skipped == 0`, so an all-skipped job fell through to status
  `organized`. Green tick, album missing. Fixed in both places, and both are covered by
  tests. **This was the exact Lidarr complaint that motivated the fork**, reproduced here.
- **Cover art is fetched on apply, never on preview.** Previewing runs on every click in the
  release list, so downloading an image to describe it would be slow and rude to the Archive.
  `plan_art()` decides what *would* happen with no network call; the route fetches the bytes
  and hands them to `execute_retag`, which keeps `retag.py` free of network dependencies and
  testable without one.
- **Retagging a file does NOT change its directory's mtime** — only adding, removing or
  renaming entries does. Measured, not assumed. The library cache keys on directory mtime,
  so an in-place retag is invisible to the scanner and the edit looks like it silently
  failed. `forget_cached_album()` exists for exactly this, and the retag endpoint calls it
  for both the old and new locations.
- **Embedded pictures have a TYPE, and files usually hold several.** Type 3 is
  `COVER_FRONT`, type 6 is `MEDIA` — a scan of the disc itself. EAC and dBpoweramp rips
  routinely embed both, in no guaranteed order, so `pictures[0]` showed albums illustrated
  with a picture of a CD. Selection goes through `PICTURE_TYPE_PREFERENCE`, never by order.
  The same trap applies to ID3 `APIC` frames (there can be several, keyed by description)
  and to loose files — a lone `disc.jpg` is not the cover.
- **`/library/art` is the only endpoint that turns user input into a filesystem read.** It
  takes a path relative to LIBRARY_PATH, so `is_within()` containment is load-bearing, not
  decoration — without it `?album=../../..` reads anything the container user can. It
  answers 404 identically for "outside the library" and "no such album" so a probe learns
  nothing. Covered by tests including a symlink pointing out of the library. **If you add
  another endpoint taking a path, copy this pattern.**

### Tooling and environment

- **The browser preview pane is not a reliable witness.** Two distinct failure modes, both
  of which read as product bugs:
  - **It doesn't paint when it isn't fronted.** `loading="lazy"` images never start loading,
    so `img.complete` is false and `currentSrc` empty even though the bytes serve fine —
    cover art looked broken twice this session and wasn't. `useEffect` also flushes late, so
    a mount effect can land *after* a synthetic input and clobber it. **Take a screenshot to
    force a paint before measuring either.** (That second one is why the metadata editor's
    re-seed effect skips its mount run — which made it genuinely robust, not just testable.)
  - **It serves stale composites.** It has shown a panel as transparent, and shown pre-fix
    state after a reload, more than once.

  So: **verify against computed styles and DOM state rather than screenshots** — except when
  the thing you are checking needs a paint, where you need the screenshot first and the
  measurement second.
- **MusicBrainz and the Cover Art Archive go unreachable for minutes at a time**, repeatedly,
  from dev machines. A failing search is far more often that than a bug — retry before
  concluding anything; the 503 path is deliberate and says which it is. It also produced a
  memorable false lead once: two consecutive runs gave opposite results and looked like
  case-sensitivity. It is *not* case-sensitive — all four casings of "The Slow
  Rush"/"Tame Impala" were verified to return identical results.
- **npm silently skips native binaries when Node is too old.** Vite 8 needs Node
  `^20.19.0 || >=22.12.0`; on 20.12.2 `npm install` merely *warns*, drops the unsupported
  optional `@rolldown/binding-*` package, and the failure only appears at build time as
  "Cannot find module './rolldown-binding.darwin-arm64.node'". The lockfile still records
  every platform, so Docker's node:22 stage is unaffected — this is a local-only trap.
- **On 20.12.2 the build now fails before it starts, and the error names none of this.** It
  dies as `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'format' must be one of: ...
  Received [ 'underline', 'gray' ]` from `node:util`. `styleText()` only learned to take an
  ARRAY of formats in a later Node, rolldown calls it at module scope, so vite cannot even be
  imported — it is not a code error and no flag (`NO_COLOR`, `--logLevel`) avoids it, because
  it happens at import. **`npm run typecheck` still works and still checks everything**;
  `npm run build` needs the Node upgrade. The one thing to not do is go looking for the bug in
  `ui/`.

## Known performance problems (profiled, not guessed)

Measured with 148 releases × 12 tracks:

| finding | measurement |
| --- | --- |
| Expanding one release group | **711 ms** freeze |
| DOM nodes, two groups expanded | 22,905 |
| Track `<div>`s built while `display:none` | 2,832 |
| `scrollHeight` read after a DOM change | 23 ms → **962 ms** worst case |
| Filter keystroke | 9–62 ms (fine) |

**Two causes, both still unfixed:**

1. `renderBody` (~`main.js:1803`) eagerly builds the full track list for every release even
   though it's hidden until clicked — roughly half the entire DOM is invisible.
2. `checkScrollability()` reads `scrollHeight`/`clientHeight`, forcing synchronous full-document
   layout. Called from **6** places including every expand toggle.

**Neither is a framework problem.** Both are reintroducible in Preact/React verbatim. Fix them
regardless of stack — it's ~30 lines.

## Frontend migration (in progress)

**Preact + Vite + TypeScript, in `ui/`.** Adopted incrementally: the vanilla app still serves
the page, and ported panels mount into it via one extra module script.

**→ Full plan, API surface, port order and traps: [docs/FRONTEND-MIGRATION.md](docs/FRONTEND-MIGRATION.md).**

| ported | still vanilla |
| --- | --- |
| Downloads panel, tab shell, library view, metadata editor, metadata queue, delete dialog | search bar, releases grid, filter column, candidates panel, log, profile |

**How the two halves coexist:**

- `interface/index.html` provides empty mount points (`#downloads-root`, `#tabs-root`,
  `#library-root`) and loads `dist/jimbrainz-ui.js` after `main.js`. The mount points are
  `display: contents` where they sit inside a flex row, so the layout is untouched.
- Ported components reuse the **existing class names and IDs verbatim**, so `main.css` applies
  unchanged. A visual difference means a porting mistake, not a restyle.
- Both files are ES modules and can't call each other, so cross-boundary calls meet on
  `window.jimbrainz` (`ui/src/bridge.ts`). Four entries today: `refreshDownloads`,
  `closeOtherDropdowns`, `runSearch`, `refreshNewImports`. **An empty bridge means the
  migration is done.**

Why, from measurements of the original code:

| hand-rolled machinery | count |
| --- | --- |
| render/refresh/notify functions | 12 |
| call sites that must remember to call one | **29** |
| `innerHTML` assignments | 43 |
| separate mutable state objects | 7 |
| `buildReleasesGrid` (unreusable table) | 312 lines |
| hand-written keyed reconciliation | 81 lines → **deleted**, replaced by `key={job.id}` |

Those 29 call sites *are* the "things not updating" complaint.

**Don't expect the port to shrink the codebase — it doesn't.** Downloads went from 260 lines
of `main.js` to 507 across six files. Roughly half is comments and types, and the reusable
parts get spent again by later panels. The return is the deleted reconciler, compile-time
checking, and rows that can't silently stop updating — not fewer lines.

Preact over React: same API, ~4 KB vs ~45 KB, `preact/compat` keeps the React ecosystem
available. TypeScript would have caught the real `releaseGroupContext is not defined` bug at
compile time.

## Conventions

- **Commits must set the author explicitly**, git defaults to a local placeholder here:
  `GIT_AUTHOR_NAME="James Barnett" GIT_AUTHOR_EMAIL="jamesambarnett@gmail.com" git commit …`
- Commit messages explain *why*, and name what was verified vs assumed.
- Versions: `v0.x` tags. **1.0.0 is reserved for when this is genuinely polished** — a
  deliberate choice, don't jump to it.
- Image tags: `:experimental` = this branch (rebuilt on every push); `:latest` = the newest
  real release. `:latest` only ever moves for a real release, never a branch or prerelease —
  the workflow enforces this by skipping `:latest` for any version containing a hyphen.
  **As of v0.3.0 `:latest` is the slskd-direct line, not the Lidarr one.** It was tagged from
  `experimental/slskdn-no-lidarr`, so `main` still holds v0.2.1 and anyone visiting the repo's
  default branch sees the old Lidarr README. Merging this branch to `main` is still owed.

## Local development

```bash
.venv/bin/python -m src.main          # needs .env; DB_PATH=.devdata/jimbrainz.db
.venv/bin/python -m pytest tests/ -q  # 257 tests
```

Frontend, from `ui/`. **Needs Node `^20.19.0 || >=22.12.0`** — see the npm gotcha above:

```bash
npm install
npm run build      # tsc --noEmit && vite build -> interface/dist/, required to see downloads
npm run typecheck  # tsc alone; runs on older Node when the build won't
npm run dev        # harness on :5173, proxies /jimbrainz + /styles to :8080 (start the backend first)
```

`npm run dev` serves `ui/index.html`, a harness for working on one component in isolation with
HMR — **not** the real page. The real page is still `interface/index.html` served by FastAPI on
8080, and it only picks up frontend changes after `npm run build`.

`.env`, `.devdata/`, `run_dev.sh`, `.claude/`, `node_modules/`, `interface/dist/` are gitignored.

## What the tests cannot tell you

All 257 tests are fixture-driven. **Nothing has ever talked to a real slskd.** The parts most
likely to break on deployment are exactly the parts tests can't reach:

- slskd transfer `state` strings. **This one already came true**: `"Completed, Rejected"` was
  not in the recognised set, so a refused download sat at `queued` indefinitely — see the
  gotcha above. `TRANSFER_FAILURE_REASONS` in `store.py` now holds every terminal substate, and
  is the first place to look if a job never leaves `queued` or `downloading`.
- slskd's on-disk download layout — `find_local_file()` searches by basename rather than
  reconstructing paths, precisely because the layout isn't guaranteed.
- Whether `SLSKD_DOWNLOAD_PATH` actually resolves to the same files slskd writes. This is the
  most likely first-run failure, and the app now says so explicitly instead of pretending.

A green suite here means the logic is sound, not that it works against real infrastructure.

## Next up

1. **Run it against real infrastructure.** Everything below the interface is fixture-tested
   and has never met a live slskd. Watch specifically: the derived download speed (byte
   deltas, not `job.speed`), queue position, cancel, and whether `SLSKD_DOWNLOAD_PATH`
   resolves to the same files slskd writes.
2. **Merge to `main`.** It still holds v0.2.1, so the repo's default branch shows the old
   Lidarr README to anyone who visits, while `:latest` has been the slskd line since v0.3.0.
3. Continue the port in the order in [docs/FRONTEND-MIGRATION.md](docs/FRONTEND-MIGRATION.md):
   candidates panel, filter column, releases grid, top bar.
4. **A Settings tab.** The shell is built for it — add a `#settings-root` pane, an entry in
   `TABS` in `ui/src/components/Tabs.tsx`, and a `[data-tab="settings"]` rule. Nothing
   structural. The natural first contents are the env-only settings (`ORGANIZE_MODE`, paths)
   and naming templates.
5. Fix the two performance bugs — as part of the port, not after. The library view already
   avoids #1 (`{expanded && <Tracks/>}`); the search view still has both.
6. **A type scale.** The one systemic CSS fault left. Measured: ~15 hand-picked `em` values
   with no relationship to each other, 10 distinct button heights, 10 distinct paddings.
   Because every value is `em` relative to the 16px browser base, it can't be fixed by setting
   a base size on `body` — the headings would all shrink. It needs a scale defined once and
   applied, which is a visual decision, not a mechanical one. Un-sized `<span>`/`<div>` still
   land at 16px against neighbours at 14.4px; `#results-summary` and the grid expand column
   are patched individually for now.

### Deliberately not built

Worth knowing before someone "fixes" one of these:

- **Per-track editing.** The metadata editor takes a release's tracklist wholesale. Files the
  tracklist doesn't reach keep their own title and number rather than being renumbered.
- **Embedding art into the audio.** Only a cover file is written; it's what `find_cover_file()`
  prefers and it's one write instead of one per track.
- **Undo.** For retag or delete. The preview is the safety net for the first, and the
  confirmation dialog for the second — so keep both honest.
- **Persisting the scan cache.** It's in memory, so a restart rescans. Was started and backed
  out as out of scope; the per-folder mtime cache makes the rescan cheap.
- **Bulk apply in the metadata queue.** Considered and deliberately declined for the first cut.
  Auto-matching releases across many albums at once would write tags to albums nobody looked
  at, and **there is no undo** — the preview is the safety net, and a bulk action is precisely
  the case where nobody reads it. The queue makes reviewing *fast* (facets narrow it, the
  editor steps through it with its search already running) rather than making it automatic.
  The bulk operation that would be genuinely safe is folder renames to match the convention,
  since those are fully determined by the tags and need no MusicBrainz guess: `misfiled` is
  already its own facet, so that is where it would hang.
- **Retrying a rejected download.** The job now reaches `failed` and says the peer refused it,
  but picking a different peer is still a manual re-search. The candidates are not kept after
  enqueueing, so "try the next one" would mean storing them with the job.
