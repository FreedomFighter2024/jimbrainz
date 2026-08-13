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
| `main` | the stable Lidarr-based line, v0.2.1. Untouched by the rewrite. |
| `experimental/slskdn-no-lidarr` | **all the work below.** slskd-direct, no Lidarr. |

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
  store.py         SQLite job store + transfer reconciliation helpers.
  poller.py        background task: slskd transfers -> job status transitions.
  organizer.py     the ONLY code that writes to the user's filesystem.
  api/             musicbrainz_endpoint.py, slskd_endpoint.py, app.py
  routes/          search_musicbrainz, download, monitor_slskd, interface_logs
interface/         vanilla JS/CSS (being migrated to Preact+Vite+TS — see below)
tests/             96 tests, all Python, all fixture-driven
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
- **Errors degrade rather than crash.** Unwritable DB → downloads still work, untracked.
  Unreachable slskd → stored jobs still listed, no live progress.

## Gotchas discovered the hard way

Each of these cost real time. Don't rediscover them.

- **`theme.css` is `@import`ed from `main.css`, so it caches independently.** Editing the
  palette and reloading shows the OLD colours. Bust it explicitly when verifying, and
  hard-refresh after deploying.
- **Text colour classes are element-scoped** (`h4.default`, `h5.white`…). A `<span>` carrying
  `class="text default"` matches *nothing* and renders black on black. `span.*` rules were
  added to cover this; if new colours appear, add the span variant too.
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

## Frontend migration (decided, in progress)

**Chosen: Preact + Vite + TypeScript.** Adopt incrementally, starting with the new library
window; migrate existing panels opportunistically.

**→ Full plan, API surface to type, port order and traps: [docs/FRONTEND-MIGRATION.md](docs/FRONTEND-MIGRATION.md).
Start there.** Nothing has been scaffolded yet; the next session begins with the toolchain.

Why, from measurements of the current code:

| hand-rolled machinery | count |
| --- | --- |
| render/refresh/notify functions | 12 |
| call sites that must remember to call one | **29** |
| `innerHTML` assignments | 43 |
| separate mutable state objects | 7 |
| `buildReleasesGrid` (unreusable table) | 312 lines |
| hand-written keyed reconciliation | 81 lines |

Those 29 call sites *are* the "things not updating" complaint. The 81 lines of
`data-job-id` lookup + `insertBefore` + `seen` set is a worse virtual DOM.

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
- Image tags: `:experimental` = this branch (rebuilt on every push); `:latest` = stable
  Lidarr line. `:latest` only ever moves for a real release, never a branch or prerelease.

## Local development

```bash
.venv/bin/python -m src.main          # needs .env; DB_PATH=.devdata/jimbrainz.db
.venv/bin/python -m pytest tests/ -q  # 96 tests
```

`.env`, `.devdata/`, `run_dev.sh`, `.claude/` are gitignored dev scaffolding.

## What the tests cannot tell you

All 96 tests are fixture-driven. **Nothing has ever talked to a real slskd.** The parts most
likely to break on deployment are exactly the parts tests can't reach:

- slskd transfer `state` strings (matching assumes `"Completed, Succeeded"`, `"Errored"`,
  `"Cancelled"`). If downloads finish but jobs never leave `downloading`, this is why.
- slskd's on-disk download layout — `find_local_file()` searches by basename rather than
  reconstructing paths, precisely because the layout isn't guaranteed.
- Whether `SLSKD_DOWNLOAD_PATH` actually resolves to the same files slskd writes. This is the
  most likely first-run failure, and the app now says so explicitly instead of pretending.

A green suite here means the logic is sound, not that it works against real infrastructure.

## Next up

1. **Scaffold Preact + Vite + TypeScript** — nothing exists yet. Follow
   [docs/FRONTEND-MIGRATION.md](docs/FRONTEND-MIGRATION.md).
2. **A library window showing what's already on disk** — the user's next feature request, and
   the migration's first workload. Needs a backend endpoint too: scan `LIBRARY_PATH` and read
   tags (mutagen is already a dependency). No such endpoint exists yet.
3. Fix the two performance bugs — do this as part of the port, not after.
4. A settings pane (naming templates, organization, quality profiles) — explicitly deferred by
   the user until the library window is done.
5. A design pass on the CSS. The "cobbled-together" complaint is not addressed by the
   migration and needs its own deliberate effort.
