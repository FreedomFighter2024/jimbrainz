# jimbrainz

<p align="center">
  <img src="interface/assets/icon.svg" width="128" height="128">
</p>

<p align="center">
  <a href="https://github.com/real-lizardwizard/jimbrainz/releases"><img src="https://img.shields.io/github/v/release/real-lizardwizard/jimbrainz" alt="GitHub Release"></a>
  <a href="https://github.com/real-lizardwizard/jimbrainz/pkgs/container/jimbrainz"><img src="https://img.shields.io/badge/ghcr.io-real--lizardwizard%2Fjimbrainz-blue" alt="Container image"></a>
</p>

A one-page interface for finding music on MusicBrainz and pulling it down through slskd. Search is centered on specific Releases and **Release Groups** rather than artists, i.e. albums, singles, mixtapes — because most of the time you want one particular pressing of one album, not an artist's entire discography.

Pick the release you actually want, and jimbrainz searches Soulseek, ranks what comes back against that release's real tracklist, and shows you why each candidate scored what it did. One click queues it; when it finishes it gets tagged from the MusicBrainz data and filed into your library.

![Alt text](assets/videos/demo_1.gif)

_Please note; this is a silly and fun container i made for my own server, its probably kinda shitty, the code is a mess, and theres certainly better alternatives out there. buuut if you like it thats awesome :)_<3

> **Heads up:** this is a fork of [LidBrainz](https://github.com/dual-shock/lidbrainz) that has diverged a long way. LidBrainz sends things to Lidarr; jimbrainz cut Lidarr out entirely and talks to slskd directly. If you want the Lidarr version, go use the original — it's good.

## Why not Lidarr?

Because of one specific thing that couldn't be fixed from the outside.

When you pick a *particular* release — the 2011 remaster, the deluxe edition — and hand it to Lidarr, all of that detail dies at the API boundary. Lidarr's search command only takes an album id, so the plugin doing the actual Soulseek search rebuilds a generic query from scratch and grabs whatever comes back. Tubifarry's own maintainer [confirms Custom Formats can't target the release variant you selected](https://github.com/TypNull/Tubifarry/discussions/138).

jimbrainz already knows everything about the release you clicked: its MBID, full tracklist with durations, edition tags, year, label. So it does the searching and the matching itself, and all of that context is actually used.

A caveat worth setting expectations on: this won't magically always find the exact remaster. Soulseek folder names are typed by strangers and frequently omit edition text entirely. What it does is *rank* candidates against your real tracklist and show its reasoning, so you can pick with actual information instead of hoping. Edition matching is a weighted signal, never a hard filter — filtering on it would hide perfectly good results.

## Installation

_Note: if you're an **UnRaid** user like me, ive added a template that can be manually added and used, instructions are [below](https://github.com/real-lizardwizard/jimbrainz/tree/main?tab=readme-ov-file#installation-unraid)_

### Prerequisites:
1. a running [slskd](https://slskd.org) instance reachable from this container, with an API key
2. some public url/email u can put in the MusicBrainz user agent
3. docker

### Environment:
1. either clone the repo: ```git clone https://github.com/real-lizardwizard/jimbrainz.git``` <br> or just grab the ```docker-compose.example.yml``` file
2. fill in the ```.env.example``` file, and rename it to just ```.env```, if you're unsure about how to format your MusicBrainz user agent see [here](https://MusicBrainz.org/doc/MusicBrainz_API/Rate_Limiting) <br> fill in the ```docker-compose.example.yml``` and rename it to just ```docker-compose.yml``` (here you can change the exposed port and docker network)

**The one that trips everyone up:** `SLSKD_DOWNLOAD_PATH` has to point at the *same files* slskd writes its finished downloads to, as seen from inside this container. If the two containers disagree about that path, organizing quietly finds nothing. It's the most likely first-run problem by a mile.

### Running
run docker compose from the same folder as your cloned repo / docker-compose file:<br><br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`docker-compose up -d`<br><br>this by default starts the container on localhost:8080, or whatever port you configured it to.

Organizing starts in **`dry_run`** mode on purpose — it logs what it *would* do and touches nothing. Watch the event log, confirm it's finding your files and building sane paths, then switch `ORGANIZE_MODE` to `copy` or `move`.

## Features (and sorta how they work)

### Release centered querying
<details>
<summary style="font-style:italic">Everything is a release group, not an artist</summary>
Most tools use Artist objects as the "main" form of adding and storing data, i didnt like this as 99% of the time i dont want ALL the releases of an artist, i usually just want 1-2 albums. jimbrainz searches release groups, then lets you drill into the exact pressing you want.
</details>

### Ranked Soulseek candidates
<details>
<summary style="font-style:italic">Scored against the release you actually picked, with the reasoning shown</summary>
Each peer's files get grouped into (user, folder) candidates and scored on track count, fuzzy title match against the real tracklist, track durations, format/bitrate, peer health, and edition/year. You see a score breakdown per candidate so it's obvious *why* one ranked above another — and can filter by free slot, complete albums only, format, or minimum score.
</details>

### Browsing releases like it's MusicBrainz itself
<details>
<summary style="font-style:italic">A proper data grid for digging through every pressing of an album</summary>
Releases show as a table with label, catalog number, barcode, quality, language/script and disambiguation on top of format/tracks/status/country/date. Columns reorder, resize and hide. The filter column derives its checkboxes from whatever is actually on screen, and each one is tri-state — click once to require it, again to exclude it, so "any pressing except the deluxe edition" is one click.
</details>

### Downloads that remember what they're for
<details>
<summary style="font-style:italic">slskd only knows "bob is sending you 12 files"</summary>
jimbrainz keeps the link between a download and the MusicBrainz release that started it, in a small sqlite database. That's what makes tagging possible later, and it's why the downloads panel can tell you what an in-flight transfer actually is.
</details>

### Tagging and filing
<details>
<summary style="font-style:italic">Finished downloads get tagged and filed automatically</summary>
Files land as <code>{artist}/{album} ({year})/{NN} - {title}.{ext}</code>, tagged from the MusicBrainz release — including MusicBrainz IDs, so the library stays readable by Picard and beets instead of being a jimbrainz-only artifact. Track numbers and titles come from the matched tracklist, so they're right even when the peer named everything "Track 04.mp3". It never overwrites an existing file.
</details>

## (more importantly) Non-features (and how they dont work)

Being lightweight and fast (and working _just enough_) was and is the only focus, so authentication (as in a login page), mobile styling, recommendations, and batch adding artist discographies are not present.

### Adding whole artist discographies at a time
<details>
<summary style="font-style:italic">jimbrainz only uses release groups, not artists</summary>
Theres no native feature to add entire discographies quickly (unless you type really fast). There are much better alternatives for that out there.
</details>

### Making use of any more metadata than what MusicBrainz has to offer
<details>
<summary style="font-style:italic">If anything is not on MusicBrainz jimbrainz cant reach it</summary>
jimbrainz _only uses MusicBrainz_, if you need to add anything thats not on MusicBrainz it cant help you.
</details>

### Recommendations
<details>
<summary style="font-style:italic">jimbrainz can only be used for searching stuff and downloading it</summary>
Theres no tracking of what you download or listen to, and no extra metadata other than MusicBrainz, so theres no cool recommendations.
</details>

### Mobile ui
<details>
<summary style="font-style:italic">Theres no mobile ui</summary>
I scraped together this ui with my high school html and css knowledge, and it works for most desktops! but i have not even begun to look at making it mobile friendly lol
</details>

## Installation (UnRaid)
since i made this for myself, and i use UnRaid, ive included an unraid template that'll let you manually add a template to run this container like any of your other UnRaid docker containers!

_Note: given this container was just made for myself, i havent published it to the Community Applications plugin, i might in the future though. Images are built and published to ghcr.io automatically on tagged releases, but this still doesnt adhere to the same quality control as the CA containers, again, i made this for myself so use at your own discretion_

### how to manually add the template
1. move/copy `my-jimbrainz.xml` to `/boot/config/plugins/dockerMan/templates-user/`
2. in the docker tab on unraid, click "add container"
3. the jimbrainz template should show up in the template dropdown, select it

### how to set up the container
1. pick a webui port thats not in use by any of your other containers
2. to access slskd through its hostname, select the same docker network as your slskd instance
3. fill in the required fields, see the .env.example configuration if youre unsure what to put there
4. point the `/downloads` mapping at the same folder slskd writes finished downloads to

it should now run just like any other UnRaid docker container, and you can automatically pull eventual updates through the docker tab.

## who is this for?

Most of the music i listen to is on MusicBrainz, so this app uses MusicBrainz to find things and slskd to fetch them.

i didnt like using the MusicBrainz website as a search engine and then switching tabs to kick off a download, so i put it all into one ui. and i got tired of asking for a specific remaster and getting whatever turned up. if you feel the same, this could be for you.

## who is this NOT for
basically anyone who wants more functionality than whats mentioned above. if you want a full library manager with its own metadata pipeline, use Lidarr — genuinely.

## probable issues
- **Organizing finds nothing:** almost always `SLSKD_DOWNLOAD_PATH` not pointing at the same files slskd writes. jimbrainz says so explicitly when this happens rather than pretending it worked.
- **Rate limiting:** if you've improperly formatted your MusicBrainz user agent, youll automatically get rate limited. Info on this is in the MusicBrainz docs. Note that jimbrainz has a built-in rate limiter so if you are getting rate limited more than youd expect its likely because of improper config.
- **A search returns nothing:** Soulseek search is a substring match over filenames people happened to type. Try the editable query box in the candidates panel — trimming it down often helps more than adding detail.
- the ui has many problems, i just wanted it to look pretty cause i like pretty things
