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
  library.py       scans LIBRARY_PATH with mutagen, cached per folder on mtime.
  store.py         SQLite job store + transfer reconciliation helpers.
  poller.py        background task: slskd transfers -> job status transitions.
  organizer.py     the ONLY code that writes to the user's filesystem.
  api/             musicbrainz_endpoint.py, slskd_endpoint.py, app.py
  routes/          search_musicbrainz, download, monitor_slskd, interface_logs, library
interface/         vanilla JS/CSS. Still the served page; shrinking as panels are ported.
  dist/            BUILT from ui/, gitignored. Not present in a fresh checkout.
ui/                Preact + Vite + TypeScript. New work goes here — see below.
tests/             126 tests, all Python, all fixture-driven
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
- **Errors degrade rather than crash.** Unwritable DB → downloads still work, untracked.
  Unreachable slskd → stored jobs still listed, no live progress.

## Gotchas discovered the hard way

Each of these cost real time. Don't rediscover them.

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
- **slskd's `averageSpeed` is cumulative** (total bytes ÷ total elapsed), so it only ever
  creeps upward and never shows the current rate. Real speed is derived from `bytesTransferred`
  deltas between polls. Don't "simplify" back to `averageSpeed`.
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
- **A Preact `useEffect` that writes to a DOM node outside its own tree is unreliable.** The
  tab bar set `data-tab` on `#main-container` from an effect; when the tab was changed by a
  click originating in the *library* tree, the effect didn't fire and the button highlighted
  while the panes never swapped. Cross-tree DOM writes belong in the shell (`main.tsx`),
  done synchronously. Symptom to recognise: the component looks right, the page doesn't.
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
- **npm silently skips native binaries when Node is too old.** Vite 8 needs Node
  `^20.19.0 || >=22.12.0`; on 20.12.2 `npm install` merely *warns*, drops the unsupported
  optional `@rolldown/binding-*` package, and the failure only appears at build time as
  "Cannot find module './rolldown-binding.darwin-arm64.node'". The lockfile still records
  every platform, so Docker's node:22 stage is unaffected — this is a local-only trap.
- **The browser preview pane serves stale composites.** It has shown a panel as transparent
  and shown pre-fix state after a reload, more than once. **Verify against computed styles /
  DOM state, not screenshots.**
- **MusicBrainz is frequently unreachable from dev machines.** Two consecutive runs gave
  opposite results and looked like case-sensitivity. It is *not* case-sensitive — verified all
  four casings of "The Slow Rush"/"Tame Impala" return identical results.

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

## Frontend migration (in progress — toolchain and Downloads panel done)

**Preact + Vite + TypeScript, in `ui/`.** Adopted incrementally: the vanilla app still serves
the page, and ported panels are mounted into it by one extra module script.

**→ Full plan, API surface, port order and traps: [docs/FRONTEND-MIGRATION.md](docs/FRONTEND-MIGRATION.md).**

**Done:** toolchain, the typed API layer for every endpoint, localStorage compatibility, and
the **Downloads panel** (port order #2, taken before the library window because it needed no
new backend and so could be proven against real data immediately).

**How the two halves coexist:**

- `interface/index.html` provides empty mount points (`#downloads-root`, `display: contents`
  so the flex layout is untouched) and loads `dist/jimbrainz-ui.js` after `main.js`.
- Ported components reuse the **existing class names and IDs verbatim**, so `main.css` applies
  unchanged. A visual difference means a porting mistake, not a restyle.
- Both files are ES modules and can't call each other, so the handful of cross-boundary calls
  meet on `window.jimbrainz` (`ui/src/bridge.ts`). Two entries today:
  `refreshDownloads` and `closeOtherDropdowns`. **An empty bridge means the migration is done.**

Why, from measurements of the current code (the Downloads row is now realised):

| hand-rolled machinery | count |
| --- | --- |
| render/refresh/notify functions | 12 |
| call sites that must remember to call one | **29** |
| `innerHTML` assignments | 43 |
| separate mutable state objects | 7 |
| `buildReleasesGrid` (unreusable table) | 312 lines |
| hand-written keyed reconciliation | 81 lines → **deleted**, replaced by `key={job.id}` |

Those 29 call sites *are* the "things not updating" complaint. The 81 lines of
`data-job-id` lookup + `insertBefore` + `seen` set was a worse virtual DOM, and `key={job.id}`
replaced all of it.

**Don't expect the port to shrink the codebase — it doesn't.** Downloads went from 260 lines
of `main.js` to 507 across six files in `ui/`. Roughly half of that is comments and type
declarations, and the reusable parts (`lib/format.ts`, `lib/jobs.ts`) get spent again by the
candidates panel. The return is the deleted reconciler, compile-time checking, and rows that
can't silently stop updating — not fewer lines.

Preact over React: same API, ~4 KB vs ~45 KB, `preact/compat` keeps the React ecosystem
(TanStack Table etc.) available. TypeScript would have caught the real
`releaseGroupContext is not defined` bug at compile time.

**Not fixed by the migration:** the cobbled-together *look* (2,245 lines of accreted CSS —
the original author's own comment calls it "a whole mess") and the lag above.

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
.venv/bin/python -m pytest tests/ -q  # 126 tests
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

All 126 tests are fixture-driven. **Nothing has ever talked to a real slskd.** The parts most
likely to break on deployment are exactly the parts tests can't reach:

- slskd transfer `state` strings (matching assumes `"Completed, Succeeded"`, `"Errored"`,
  `"Cancelled"`). If downloads finish but jobs never leave `downloading`, this is why.
- slskd's on-disk download layout — `find_local_file()` searches by basename rather than
  reconstructing paths, precisely because the layout isn't guaranteed.
- Whether `SLSKD_DOWNLOAD_PATH` actually resolves to the same files slskd writes. This is the
  most likely first-run failure, and the app now says so explicitly instead of pretending.

A green suite here means the logic is sound, not that it works against real infrastructure.

## Next up

0. **Verify the Downloads port against a running backend.** It typechecks and the markup
   matches the old renderer class-for-class, but it has never rendered a real job — that
   needs Node ≥20.19, `npm run build`, and a live slskd. Watch specifically: the live speed
   figure (byte deltas, not `job.speed`), the queue position line, and cancel.
1. **A metadata manager** — the user's stated next want, Picard-shaped: pick which edition an
   album actually is and correct its tags. The groundwork is deliberately in place:
   `release.edition_label` already overrides every derived source, and `library.py` surfaces
   `mixed_tags` for folders whose files disagree. Needs a write path (retag + re-file an
   existing album), which nothing has yet — the organizer only ever writes tags on the way in.
2. Continue the port in the order in [docs/FRONTEND-MIGRATION.md](docs/FRONTEND-MIGRATION.md):
   candidates panel, filter column, releases grid, top bar. Downloads and the library are done.
3. **A Settings tab.** The shell is built for it — add a `#settings-root` pane, an entry in
   `TABS` in `ui/src/components/Tabs.tsx`, and a `[data-tab="settings"]` rule. No structural
   change needed.
4. Fix the two performance bugs — do this as part of the port, not after. The library view
   already avoids #1 (`{expanded && <Tracks/>}`); the search view still has both.
5. A design pass on the CSS. The "cobbled-together" complaint is not addressed by the
   migration and needs its own deliberate effort. A first pass fixed the *systemic* faults —
   no inherited baseline, colour-by-element-matrix, a duplicated button rule that made the
   log button 6px taller than its neighbours. **What's left is a type scale.** Measured:
   ~15 hand-picked `em` values with no relationship to each other, 10 distinct button
   heights and 10 distinct paddings. Because every value is `em` relative to the 16px
   browser base, this can't be fixed by setting a base size on `body` — the headings would
   all shrink. It needs a real scale defined once and applied, which is a visual decision,
   not a mechanical one. Un-sized `<span>`/`<div>` still land at 16px against neighbours at
   14.4px; `#results-summary` and the grid expand column are patched individually for now.
