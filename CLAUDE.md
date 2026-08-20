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
  routes/          search_musicbrainz, download, monitor_slskd, interface_logs, library,
                   settings (READ-ONLY by nature - see the decision below)
interface/         vanilla JS/CSS. Still the served page; main.js is shrinking as panels
                   are ported. main.css styles BOTH halves - see below.
  styles/theme.css THE TOKEN LAYER. Every colour, size, space, radius, shadow, duration and
                   easing in the application. Because both halves consume it, editing a
                   value here restyles the vanilla and Preact sides together. Raw values in
                   main.css or in a component are a bug. NOTE it is @import-ed, so it caches
                   separately - hard-refresh when verifying a palette change.
  dist/            BUILT from ui/, gitignored. Not present in a fresh checkout.
ui/                Preact + Vite + TypeScript. New work goes here — see below.
tests/             305 tests, all Python, all fixture-driven
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
- **The search type filter narrows the QUERY, not the results.** That distinction is the whole
  point: MusicBrainz spends the `limit` on whatever matches, so for a prolific artist it goes
  almost entirely on things nobody wanted. Measured — `releasegroup:"Metallica" AND
  artist:"Metallica"` returns 25 groups of which **15 are Live, 6 Compilation, 1 Interview and
  exactly 2 are the studio album**. Filtering the returned list would leave 2 results out of 25;
  filtering the query spends all 25 on studio albums.
  `primarytype` and `secondarytype` are MusicBrainz's own documented release-group fields.
  "Studio only" excludes secondary types **by name** rather than asking for "no secondary type
  at all" — a bare `-secondarytype:*` relies on how the index treats a wildcard against an
  absent field, and negating specific terms is ordinary Lucene that behaves the same anywhere.
  **The original query is parenthesised before the filter is ANDed on.** A title-only search is
  bare free text, and without brackets the `AND` binds to the last term alone — quietly turning
  `dark side of the moon` into something the user did not type.
  The active filter is shown in the button, in the results summary, and as a tooltip carrying
  the exact clauses sent, because a search that silently returns less than it could is a search
  you stop trusting.
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
- **Getting a cover must not require applying a release.** `/library/art/fetch` writes one
  file and touches nothing else — no tags, no rename, no companions. Applying a release is a
  lot to agree to when the only thing missing is the picture, and an album whose tags are
  already right shouldn't have to be re-tagged to gain a sleeve.
  **It chooses nothing**, which is what makes it safe to fire with no preview: the release id
  comes from the album's own tags, so it asks the Archive for art belonging to the release the
  album already claims to be. An untagged album is told to match a release first rather than
  guessed at, and an existing cover is never replaced unless asked.
  The `get art` button appears only on albums that have a release id and no art — exactly the
  set it can help — which also keeps it off the already-tight mobile rows.
  **Replacing art lives in the editor, not on the row.** Overwriting a sleeve you chose
  yourself is not recoverable, and the editor is where you are looking at both covers as you
  decide — that comparison is the point. The cheap, additive direction gets the one-click
  button out in the list; the destructive one sits behind a preview. The editor also sends an
  explicit `release_mbid`, since it is showing you that release's cover at the time; the plain
  path sends none and uses the album's own tags, which is what makes it need no decision.
  **The bulk run is driven from the client, one album at a time**, so you can watch it, stop
  it, and have every album go through the identical tested route a single click does. A
  server-side loop would be one long opaque request that either finishes or doesn't. It is
  scoped to what is on screen, so the facets compose with it, and it reports "no cover on the
  Archive" separately from "the request failed" — the first is a fact about the release and
  nothing can be done, the second is worth trying again.
- **There are now THREE writers to the user's filesystem**, and both use the same plan/execute
  split: `organizer.py` files downloads in, `retag.py` corrects albums already there, and
  `save_cover_art()` writes a single cover (narrow enough not to need a plan/execute split, but
  it re-checks containment at the write rather than trusting the plan, for the same reason the
  retag endpoint recomputes its own). A
  preview that disagrees with the write it previews is worse than no preview, so both derive
  the tags from one shared `organizer.tag_values()` rather than computing them twice. The
  apply endpoint **recomputes the plan** rather than accepting the previewed one back — a
  plan is a list of file operations, and taking one over the wire would let a caller name
  arbitrary paths to write to.
- **MusicBrainz responses are cached in memory, successes only.** One bounded TTL cache for the
  process (`ResponseCache`), shared like the rate limiter and for the same reason: both are
  about what this application asks of MusicBrainz as a whole. It is what makes the review queue
  usable — stepping back to an album you already looked at costs nothing — and it turns a
  guaranteed duplicate into a hit, since `fully_search` fetches the first group's releases as
  `best-match-releases` and the editor then asks for that same group again. Bounded because a
  release list with recordings is a large payload. **Never cache the failure path** — see below.
- **Ask MusicBrainz for the least that answers the question.** Two flags, both defaulting to
  the expensive-but-correct behaviour so that a caller who does nothing cannot lose data:
  `fully_search(include_releases=False)` skips the eager best-match-releases walk, and
  `get_releases(with_tracks=False)` drops `inc=recordings` from a listing. Together they took
  opening the editor from ten requests to four, and one group's releases from five requests and
  1.4 MB to one and 101 KB — see the measurements below. `get_release()` is the other half:
  the tracklist of the pressing actually chosen. **Never make trackless the default** — the
  download flow matches Soulseek folders against a real tracklist, and losing it would weaken
  the matching silently instead of failing loudly.
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
- **The tab badge and the queue must never count different things.** They did, and it produced
  a notification that named no album: the badge counts albums jimbrainz *filed and you haven't
  looked at*, the queue counts albums with *outstanding issues*, and a freshly imported album
  with perfect tags is the first without being the second. It appeared in no facet, carried no
  chip, and the whole metadata section was hidden when nothing else was wrong — and it could
  never be cleared either, because there was nothing to apply, nothing to ignore, and it wasn't
  in the walkthrough. `queueAlbums()` now includes new imports whatever their state, there is a
  `newly added` facet and a `new` row chip, and **stepping past one is what marks it seen**.
  A notification you cannot act on is worse than no notification.
- **Prune review rows for albums that are gone.** A row is keyed on the album's path, so a
  folder renamed or deleted outside jimbrainz orphans it — and an orphaned *import* row is
  counted by the badge while being in no scan, so it can be neither named nor cleared. The scan
  drops them, but **only after a scan that actually found albums**: an empty library is far more
  often an unmounted volume than a deleted collection, and wiping every ignore the moment a
  mount goes missing would be a rotten trade.
- **The new-import prompt is recorded at import time, not derived from a scan.** The library is
  deliberately not read until its tab is opened, so a badge that had to diff two scans would
  need a scan to exist — absent at exactly the moment it has something to say. The poller writes
  one row as it files each download, and `/queue/new_imports` is a single indexed count that
  touches no filesystem. This is the only reason the import source is recorded at all.
- **Cancelling a download can remove its partial file, but only if you asked for it.**
  slskd keeps partials *deliberately*: it writes them to
  `<incomplete>/<username>/<remote path>/<file>` and, with `retry.partial` set to `Resume`,
  starts the next attempt at the partial's length instead of at zero. So a leftover is a
  feature for a transfer that failed and junk only for one you meant to abandon — which is why
  `remove_incomplete_downloads()` runs on cancel alone, and does nothing at all until
  `SLSKD_INCOMPLETE_PATH` points at that folder. Setting it *is* the opt-in.
  It matches by basename under the root rather than rebuilding slskd's path (slskd sanitizes
  the remote path into the on-disk name — `C:` becomes `C_` — and that mapping is its
  business), but it is **stricter than `find_local_file`**: that one guesses because a wrong
  guess misfiles a track, whereas here a wrong guess deletes somebody else's download. An
  ambiguous basename, or one whose parent folder isn't this job's, is skipped and reported.
  Every other guard mirrors `delete_album()`.
- **Errors degrade rather than crash.** Unwritable DB → downloads still work, untracked.
  Unreachable slskd → stored jobs still listed, no live progress. Unwritable DB → the metadata
  queue still works, it just stops remembering what you ignored.

### The library view's editions

- **An album's editions are ALWAYS visible; only their track lists are behind a toggle.**
  They used to sit behind the album's own disclosure triangle, which hid the single fact
  this view exists to show — that you are holding three pressings of this record — behind a
  click, on a row that looked identical to every single-edition album until you opened it.
  Holding multiple versions is the feature, so it is shown, not disclosed.
  **This is not an oversight to "fix" by making them collapsible again.**
- **The 711ms rule still holds, because an edition HEADER is not a track list.** What must
  stay deferred is `<TrackList>`, and every one of them still is — one toggle per edition.
  Verified: with a three-edition album on screen, `.library-tracks` in the document is **0**
  until an edition is opened, and opening one blocks for 0.3ms. If you ever render editions
  and their tracks together, this view will hit the search view's freeze harder, because a
  library holds far more albums than one search returns.
- **A single-edition album keeps its own toggle, and it opens the tracks directly.** The
  album row IS the release row in that case, so nesting it under a lone "Standard" row would
  be a click that buys nothing. The resulting rule is simple and worth preserving: **one
  disclosure per release, and it is always for tracks.**
- **The multi-edition album head renders a hidden spacer where the toggle would be**
  (`.library-expand-spacer`). It has nothing to disclose, but its artwork and titles still
  have to line up with the single-edition rows directly above and below it in the same list;
  without the spacer every multi-edition album steps out of alignment with its neighbours.
  `visibility: hidden` keeps the glyph's width — which is where the alignment comes from —
  while taking it out of the accessibility tree and out of hit testing.

### The settings tab

- **The server half is READ-ONLY, and that is a property of the deployment, not a shortcut.**
  Every server setting arrives as an environment variable, read once at process start, from a
  compose `environment:` block or `.env`. Nothing this app could write would change them:
  editing `.env` from inside the container would not affect the running process, and would be
  discarded on the next `docker compose up` for anyone configuring through compose — which is
  most people and all Unraid users. **Do not add a save button to that half.** A save button
  that needs a restart to take effect, and sometimes does nothing even then, is worse than a
  clearly read-only report. If a writable server setting is ever wanted (naming templates are
  the obvious candidate), it needs a real persistence story first — a settings table in the
  sqlite DB, with env vars as the fallback — not a form bolted onto this endpoint.
- **So the endpoint's job is DIAGNOSIS.** It answers the three questions someone actually
  has: what value did the container receive, which file do I edit to change it, and what is
  wrong with it. The middle one is the one that is genuinely hard from outside — once
  `load_dotenv()` has run, a compose value and a .env value are indistinguishable in
  `os.environ`. `config.py` captures that at import time and `setting_source()` reports it.
- **Paths are RESOLVED, not echoed.** `_describe_path()` stats every configured path and
  checks readability, and writability where it matters. A path that exists on the host but
  not inside the container is the most common first-run failure in this project and it is
  completely invisible from the string — which looks correct, because it is correct, just
  not from in here.
- **The API key never reaches the browser.** The row reports `set` or nothing. This payload
  renders on a page people screenshot into bug reports. A test asserts the key's value does
  not appear anywhere in the payload.
- **Only `error` is decorated.** An unset OPTIONAL setting renders plain. When every row
  carries a colour, the row that needs attention stops standing out, which is the list's
  whole job.
- **The organizing verdict is derived server-side and stated once**, with every blocker
  listed at the same time. "Why did nothing get filed" has four possible causes across two
  groups; discovering them one at a time is how people conclude the feature is broken rather
  than misconfigured.
- **Client preferences are a separate storage key (`jimbrainz-preferences`), not more fields
  on `jimbrainz-download-defaults`.** That older blob is read and rewritten wholesale by
  `main.js` too, so any field it did not know about would survive only until the next time it
  saved. New key, one writer.
- **Every preference is genuinely wired to behaviour**, and the vanilla half reads them at
  the point of use rather than caching at load — so a change in the settings tab applies to
  the next action without a reload. `PREFERENCE_FALLBACK` is duplicated in `main.js` because
  the two files are separate ES modules that cannot import each other; **keep the two copies
  in step** until the search view is ported and the duplicate goes away.
- **"Studio only" as a default still shows in the button label.** A filter that is silently
  on is a search that quietly returns less than you asked for, which is the exact failure the
  visible label exists to prevent — see the search-type-filter decision above.

### The v0.5 design system

The brief was "snappy, and modernise the dated aesthetic". The direction chosen was **modern
foundation, keep the signature**: the ASCII wordmark, the purple accent and monospace data
stay; the CRT overlay, the text-glow and the ░▒▓ chrome go.

- **`theme.css` is the token layer and the only place raw values belong.** Colours, type
  sizes, spacing, radii, shadows, durations and easings are all defined there once. This is
  load-bearing *because the migration is unfinished*: `main.css` styles the vanilla half and
  the Preact half, so one token edit restyles both together and the two can't drift apart
  while they coexist. A hex code or a px size typed into a rule defeats that.
- **The type scale is REM, and that is the whole point.** The old sheet was ~15 unrelated
  `em` sizes, which COMPOUND through nesting — the same `<h4>` rendered at different sizes
  depending on where it sat, and each value had been hand-picked to look right after
  whatever compounding applied at that spot. That is also why it could never be fixed by
  setting a base size on `body`: the headings scaled with it. rem resolves against the root,
  so a step means one thing everywhere and the interface can be rescaled from one line.
- **The glow tokens still exist and resolve to `transparent`.** ~23 `text-shadow` rules
  reference them. Neutralising the tokens switched every one of those off without editing
  them, which makes the CRT bloom one edit to restore and one edit to remove. That is why
  they weren't deleted — resist tidying them away.
- **The bundled scene font is unreferenced, not deleted.** All 30 `@font-face` rules went and
  the UI uses the platform's own stacks; the `.otf` files are still on disk and in git. This
  app is self-hosted and often runs with no internet at all, so a webfont CDN was never an
  option — local stacks are the only honest choice, and they cost nothing to load.
- **The wordmark is figlet-style ASCII art and therefore needs `--font-mono`.** It used to
  inherit a *proportional* face, which is why the letterforms never quite lined up.
- **The foundation layer at the top of `main.css` is written with `:where()`, so it carries
  ZERO specificity.** The ~3,500 legacy lines below beat it on any property they actually
  set, and it only fills in what they never mention. That is what made it safe to add a
  baseline to a stylesheet whose own header calls it an abomination: it cannot take anything
  away. Keep new baseline rules inside `:where()`.
- **Overlays animate via `@starting-style` + `transition-behavior: allow-discrete`.** Every
  dropdown here is toggled by swapping `display`, which is a discrete property — the panel
  simply existed on one frame and not the one before, and that hard cut was most of why the
  app read as abrupt despite never being slow. Browsers without support ignore both and get
  the instant show/hide it always had, so there is no fallback to write.
- **`prefers-reduced-motion` is handled once, in `theme.css`, by collapsing the duration
  tokens** rather than by redefining animations. One block therefore covers every transition
  in both halves — including ones written after it.
- **Accent is spent, not sprinkled.** Solid purple fills appear on exactly two controls:
  Search, and the metadata editor's Apply. Apply writes tags to disk and renames a folder
  with no undo, so it must not look like the Cancel button beside it. Everything purple used
  to be purple — three accent-coloured boxes sat in the top bar — and when everything is
  accented the accent marks nothing.

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
- **Right-align the library toolbar from the SUMMARY, not from each button.** Every trailing
  control used to carry its own `margin-left: auto` plus a rule cancelling the one before it,
  so adding a third button meant adding another override — and two live auto margins split the
  free space instead of pooling it, putting a gap in the middle of the group. `#library-summary`
  takes the slack with `margin-right: auto` and any number of controls after it stay together.
- **The filter columns collapse on mobile and the class is inert on desktop.** Both the
  vanilla and Preact columns always carry `collapsed`; only the `max-width: 768px` block acts
  on it. Don't "tidy" that by removing the class on desktop — it's what keeps one code path.
- ~~The loading indicator animates `content`~~ **Replaced in v0.5.** It swapped ░▒▓█ on
  `steps(1)`, justified as using "the same glyphs the filter headings use". Those headings
  are plain words now, so that justification expired with them — and animating `content`
  replaces a text node twelve times a second, each swap a layout and a paint. It is a
  gradient sweep over a 2px bar instead. Still deliberately not a rotating arc: a horizontal
  sweep suits an interface built out of rows and tables.
- ~~Decorated headings wrap if you let them~~ **Moot in v0.5 — the ░▒▓ chrome is gone.**
  Worth knowing why it was ever a rule: `░ ▒ ▓ filters ▓ ▒ ░` measured 138px in a 190px
  header that also holds a "clear" button, so a lone `░` wrapped to a second line and the
  column read as broken. The general lesson survives the decoration: **anything in a
  fixed-width column needs measuring at that width**, not eyeballing.
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
- **`uploadSpeed` is BYTES per second, not bits.** Two comments claimed bits, which would invite
  someone to "fix" the display by a factor of eight. slskd's own web UI renders the same field
  as `formatBytes(response.uploadSpeed)/s`, and `score_peer()`'s thresholds only make sense read
  as bytes — 1 MB/s for a fast peer, 100 KB/s for a decent one; as bits those would be 125 and
  **12.5** KB/s. The display was always right; only the comments were wrong.
- **Hold a stale rate for a duration, never for a number of polls.** `speed.ts` kept the last
  measured rate across quiet polls (a zero delta usually means "slskd hasn't refreshed its
  counter", not "the transfer stopped") — but it counted four *polls*, and the poll cadence is
  not fixed: 500ms with the panel open, 5s in the background, and browsers throttle background
  tabs further. So the same constant meant ~2s when watched and 20s+ when not. Measured against
  a steady 1 MB/s transfer with slskd's counter refreshing every 5s, **the speed read blank on
  54% of polls**, in gaps of up to 5 seconds — a transfer moving at a perfectly constant rate,
  flickering between a number and nothing. It ages out on wall time now (`STALE_RATE_MS`), which
  put that back to 92% and bounded the lie at ~6s whatever the cadence.
- **The speed is measured over a one-second window, which is also how often it changes.** One
  constant (`SPEED_UPDATE_MS`), not a measurement plus a display throttle — a short window
  quantises badly against slskd's own counter, so publishing twice a second gave a figure that
  was both hard to read and noisier than the transfer really was. Measured on a transfer
  deliberately wobbling ±30%: 120 distinct figures a minute became 60, and the scatter fell
  (std dev 0.212 → 0.187 MB/s) while still tracking the real swing. **The poll cadence is
  independent of this** — the extra polls drive progress and status, and their bytes accumulate
  into the next window rather than being discarded, so changing `POLL_OPEN_MS` does not change
  how often the speed updates.
- **`ui/test/speed.sim.cjs` is the only frontend test in the repo, and it is a script.** There is
  no JS test runner here (adding one needs a newer Node than this repo builds on), and the
  sampler is the piece of frontend logic whose failure is *silent* — a wrong rate looks entirely
  plausible, and "no speed at all, intermittently" is invisible to any assertion about a single
  poll. It compiles `speed.ts` itself, simulates polling against a known true rate, and exits
  non-zero. Run it with `node ui/test/speed.sim.cjs`; it fails on the pre-fix code.
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
- **A failed releases fetch used to be indistinguishable from an album with no releases.**
  `get_releases()` read `data.get("releases", [])` straight off whatever `request_with_retries`
  returned — and that answers with an *error dict* rather than raising, so a MusicBrainz blip
  came back as `{"release-count": 0, "releases": []}`. The interface believed it. The top search
  result rendered with nothing to expand, and since the filter facets are built from whatever
  release grids are mounted, **an entire search came up with no filters at all**. It now returns
  a `problem` alongside, and says so in the event log.
- **`renderFacets()` has to be called by hand, and one call site didn't.** Fetching a release
  group's releases mounted a grid without telling the facets, so expanding a group left the
  filter column still reading "expand a release group to see filters" — and with the bug above,
  that was the *only* way to mount a grid, so the filters never appeared at all. This is exactly
  the hand-rolled render bookkeeping counted below (29 call sites that must remember). It goes
  away with the port, not before; until then, **anything that mounts or unmounts a release grid
  must call `renderFacets()` and `updateResultsSummary()`**.
- **A non-total branch in `createReleaseGroupElement` produced a dead card.** It tested
  `if (releases && releases.length)` then `else if (releases === null)`, so an empty array
  matched neither and the group rendered with no grid *and* no fetch button — unexpandable, with
  no way back. `processSearchResults` now passes `null` for an empty list and the second arm is
  a plain `else`. Watch for this shape: `[]` is neither truthy-with-length nor `null`.
- **A 400 from MusicBrainz is a rejected QUERY, and retrying it is pointless.** It used to fall
  through to the generic branch and go round the retry loop ten times, with rate-limit pacing
  between each, before reporting "MusicBrainz is unreachable" — about thirty seconds spent
  arriving at the same deterministic answer, and then blaming the network for a bad search. It
  breaks out immediately now and says the query was rejected. This matters more since the
  search view began composing type-filter clauses: a syntax mistake there has to be legible as
  a syntax mistake.
- **`request_with_retries` returns an error dict rather than raising.** Reaching straight for
  `["release-groups"]` produced a `KeyError` that surfaced as *"Error searching MusicBrainz:
  'release-groups'"* — which reads like a bad query, so an outage looked like user error.
  `MusicBrainzUnavailable` now distinguishes them. **This is also why the response cache stores
  only the success path** — caching that error dict would pin a transient outage in place for
  the whole TTL, turning a bad minute into a bad hour with no remedy but a restart.
- **MusicBrainz's own result order cannot pick the album for you.** Searching
  `releasegroup:"Metallica" AND artist:"Metallica"` returns 25 groups of which the **first five
  all score exactly 100** — two live albums, an interview disc, a compilation, and only then the
  1991 album. The editor took `slice(0, 3)`, so it spent three requests on the wrong groups and
  **never fetched the right one**; no amount of ranking the releases underneath could have
  helped, because they were never retrieved. `scoreReleaseGroupMatch` now ranks groups first, on
  group-level signals only (year is worth 100, exact title 40, studio-album-ness 30, an unlikely
  secondary type −30, MB's score ÷10 as a weak tiebreak). Weighted, not filtered — tag the 1996
  live album as 1996 and it still wins, which was verified along with the two Black Album cases.
- **The "rate limit hit" warning was ours, not MusicBrainz's.** `RateLimit.wait()` logged a
  *frontend* warning every time it paced a request, which during any normal burst is constantly —
  so the app spent its time telling the user that its own politeness was a fault. It is at debug
  now. A real 429 from the server is still reported.
- **docker-compose: `environment:` beats `env_file`, and that is now a supported way to
  configure jimbrainz — but only with LITERAL values.** Both sources work and may be mixed
  (`load_dotenv()` does not override existing variables, so the environment wins; there is a
  subprocess test pinning that, because flipping it to `override=True` would invert the
  precedence with nothing to show for it).
  The trap is `SLSKD_URL=${SLSKD_URL}`: compose re-interpolates that from its *own* env, and an
  empty result **still counts as set**, so it beats `.env` and leaves the setting blank beside a
  `.env` line that looks perfectly correct. That produced an unusable empty `SLSKD_URL` once
  already. `shadowed_by_empty_env()` now detects exactly this and names it in the log, and
  `setting_source()` reports which source supplied each setting on startup — "check your .env"
  is useless advice to someone who configured everything in compose.
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
- **Cover art is served with a five-minute cache, so its URL has to carry a version.** Without
  one, replacing a cover showed the old image for five minutes — precisely when you are looking
  at it, since you had just changed it. The version is the **art file's own mtime**, and the
  distinction matters: replacing `cover.jpg` in place does not touch the *directory's* mtime, so
  `album.modified_at` sits perfectly still through the one operation that must be noticed
  (measured: dir mtime unchanged, file mtime moved). `albumArtUrl()` is the only place that
  builds this URL — keep it that way.
  Note the corollary: the scan cache also keys on directory mtime, so an in-place cover
  replacement is invisible to it too. `forget_cached_album()` on the retag path is what makes
  the new art appear; a cover changed by anything else needs a rescan.
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
- **A transient upstream failure must never latch into a permanent dead end.** The `get art`
  button first disabled itself after a failed fetch, on the reasoning that the Archive simply
  has no cover for that release. That is usually true and sometimes badly wrong: the Archive
  goes away for minutes at a time exactly like MusicBrainz, and the two are indistinguishable
  from a single 404. It now says `retry art` and stays clickable. Same shape as the rejected
  download and the empty release list — **when an upstream answer could mean "never" or "not
  right now", leave the user a way to ask again.**
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

**Opening the metadata editor, measured against the live API and now FIXED.** It cost ten
MusicBrainz requests for one album; it costs four. Three things were wrong, and the middle one
was the expensive one:

| | before | after |
| --- | --- | --- |
| requests to open the editor on Metallica's *Metallica* | 10 | **4** |
| requests for one release group's releases | 5 | **1** |
| payload for that group | 1446 KB | **101 KB** |

1. `fully_search` eagerly walked the best group's whole release list as `best-match-releases`.
   The editor never reads that field — it ranks the groups itself — so those requests bought a
   payload that was dropped on the floor. `?releases=false` turns it off; the search view, which
   does render them, still gets them by default.
2. `inc=…+recordings` carried every track of every pressing purely so a list could show a count
   that `media[].track-count` already gives. That is what made MusicBrainz return 36, then 4,
   then 5, then 11 releases for a `limit=100` — it was capping on size, not count. Without it
   the same 58 releases arrive in **one** request. `?tracks=false` opts in, and the tracklist of
   the release you actually pick is fetched on its own.
3. Both defaults are unchanged, because the download flow matches Soulseek folders against a
   release's real tracklist. Losing that would gut the matching quietly rather than break it
   loudly — so the saving is opt-in and the caller that needs correctness gets it by doing
   nothing.

**The trap this creates, which is worth stating plainly:** a release fetched for the *list* has
no tracklist, and building a retag payload from one applies no titles and no track numbers —
writing nothing, and reading exactly like the edit silently failed. The editor therefore keeps
`selectedId` (what you clicked, drives the highlight and the cover art) apart from `selected`
(that release *with* its tracks, the only thing a payload is ever built from), refuses to plan
while the tracklist is in flight, and clears the selection outright if the fetch fails. Do not
collapse those two pieces of state back together.

**Both interface causes are now FIXED.** Measured in the running app, not estimated:

| | before | after |
| --- | --- | --- |
| expanding a release row | 711 ms freeze | **1.2 ms** |
| track `<div>`s built while `display:none` | 2,832 | **0** |
| forced synchronous layouts per expand | 1 (up to 962 ms) | **0** |
| font bytes fetched on load | 1.6 MB / 30 faces | **0** |

1. **`renderBody` builds a release's track list on FIRST EXPAND, not up front.** It used to
   build every track of every release eagerly into a container that is `display:none` until
   clicked — roughly half of every node in the document, for markup nobody had asked to see.
   A `tracksBuilt` flag makes it once-only and a DocumentFragment makes it one insertion.
   **Keep it lazy.** This is the single largest interaction win in the app and it is one
   `if` away from being undone.

2. **`checkScrollability()` is gone entirely**, along with its resize listener and all six
   call sites. It read `scrollHeight`/`clientHeight` on two containers — forcing a
   synchronous full-document layout, on every expand toggle — to toggle a class whose whole
   effect was **ten pixels of right padding** to clear the scrollbar. `scrollbar-gutter:
   stable` on `.scrollable` does that in CSS, always, for nothing. It also removed the
   layout shift the probe caused, where content jumped sideways the instant it grew past the
   fold. **Do not reintroduce a JS scrollbar probe** — reserve the space in CSS.

**Neither was a framework problem**, and both are reintroducible in Preact verbatim. When the
releases grid is finally ported, port the laziness with it.

**Three more came out of the design overhaul**, all of them things that cost nothing to keep
fixed:

- **The 30 bundled OTF faces are no longer referenced.** Only 7 ever loaded and `main-font-semi`
  (10 faces) was referenced by nothing at all. The interface uses the platform's own UI and
  monospace stacks now, so the page fetches **no font files whatsoever** — verified in the
  network log. The `.otf` files are still on disk and in git; only the `@font-face` rules went.
- **The loading indicator no longer animates the `content` property.** Swapping `content`
  twelve times a second replaces a text node, and each swap is a layout plus a paint. It is a
  gradient sweep now, over a 2px-tall element.
- **The full-viewport fractal-noise overlay is gone.** It was a repeated SVG the compositor
  repainted on scroll, for an effect set to 5.5% opacity.

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
.venv/bin/python -m pytest tests/ -q  # 305 tests
```

Frontend, from `ui/`. **Needs Node `^20.19.0 || >=22.12.0`** — see the npm gotcha above:

```bash
npm install
npm run build      # tsc --noEmit && vite build -> interface/dist/, required to see downloads
npm run typecheck  # tsc alone; runs on older Node when the build won't
npm run dev        # harness on :5173, proxies /jimbrainz + /styles to :8080 (start the backend first)
```

```bash
node ui/test/speed.sim.cjs   # the derived download rate, simulated against a known truth
node ui/test/queue.sim.cjs   # the tab badge and the review queue agreeing on what's outstanding
```

`npm run dev` serves `ui/index.html`, a harness for working on one component in isolation with
HMR — **not** the real page. The real page is still `interface/index.html` served by FastAPI on
8080, and it only picks up frontend changes after `npm run build`.

`.env`, `.devdata/`, `run_dev.sh`, `.claude/`, `node_modules/`, `interface/dist/` are gitignored.

## What the tests cannot tell you

All 305 tests are fixture-driven. **Nothing has ever talked to a real slskd.** The parts most
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
4. ~~A Settings tab~~ **Done in v0.5.** It landed exactly as this entry predicted — one
   `TABS` entry, a `#settings-root` pane, one `[data-tab]` rule, no structural change. It
   also replaced the "download profile" dropdown, which is gone from the top bar.
   Naming templates are still not in it: they'd be the first *writable* server setting and
   there is nowhere to persist one yet (see the decision below).
5. ~~Fix the two performance bugs~~ **Done in v0.5** — see the performance section above.
   When the releases grid is ported, carry the laziness across with it.
6. ~~A type scale~~ **Done in v0.5.** The scale, and the spacing/radius/shadow/motion scales
   beside it, live in `theme.css`. What is NOT done is applying it exhaustively: the
   foundation and every surface touched in the overhaul are on it, but `main.css` still holds
   legacy `em` sizes in corners nothing has revisited. Convert them as you touch them —
   a mechanical sweep of 3,800 lines would be a large untestable diff for little gain.
7. **The candidates panel is the one surface the overhaul could not verify.** It needs a live
   slskd, and there has never been one (see "What the tests cannot tell you"). Its chrome was
   restyled with everything else and it uses the same shared classes, so it should be right —
   but it has not been *seen*. Look at it the first time slskd is connected.

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
