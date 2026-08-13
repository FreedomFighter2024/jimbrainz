"""
Working out *which edition* of an album a release is, in words a human can read.

This exists because the library could not hold two editions of the same album. The organizer
filed everything as `{artist}/{album} ({year})/`, so the standard and deluxe "The Slow Rush
(2020)" resolved to byte-identical paths - and since execute_plan refuses to overwrite, the
second one you downloaded was skipped file by file and never arrived. That is the same
complaint that made Lidarr unusable here, so it is worth solving properly rather than by
appending a counter.

Two ideas keep it honest:

  resolve_edition_label()  - the human-readable name of this edition, from whatever the
                             release actually told us. Deliberately allowed to be empty:
                             most albums have exactly one edition and should just be
                             `Album (Year)` with no noise bolted on.
  edition_discriminator()  - the tiebreaker used ONLY when two genuinely different releases
                             would still collide. Ugly but unique, and never reached for
                             unless it is needed.

Both are pure functions over the release dict that is already stored with each job, so the
folder a release maps to is stable forever and can be recomputed without a network call.

`edition_label` on the release is an explicit override that wins over everything else. It is
the hook for the metadata manager: once you can pick which edition an album really is, that
choice is written there and everything downstream follows it without this module changing.
"""

import re

#? Formats worth naming in a folder. CD is the unmarked default - writing "[CD]" on almost
#? every album would be noise, and the point of the label is to tell editions APART.
NOTABLE_FORMATS = {
    "vinyl", "12\" vinyl", "7\" vinyl", "10\" vinyl", "lp",
    "cassette", "sacd", "dvd-audio", "dvd", "blu-ray", "minidisc", "digital media",
}

#? Digital is only worth mentioning when it distinguishes something, and it usually doesn't -
#? most of what people download is nominally "Digital Media".
UNMARKED_FORMATS = {"cd", "digital media", "", None}

MAX_LABEL_LENGTH = 60


def _tidy(text: str | None) -> str:
    """Collapse whitespace and trim. Returns '' for anything falsy."""
    if not text:
        return ""
    return re.sub(r"\s+", " ", str(text)).strip()


def _sentence_case(text: str) -> str:
    """
    Capitalise the first letter and otherwise leave the string alone.

    Deliberately not .title(): MusicBrainz disambiguations are human-written and often
    already carry meaningful capitalisation ("US promo", "CD/DVD reissue", "iTunes
    exclusive"). Title-casing mangles all three, and a wrong-looking folder name is worse
    than a slightly informal one.
    """
    if not text:
        return ""
    return text[0].upper() + text[1:]


def _from_edition_tags(tags: list[str] | None) -> str:
    """
    The UI's detected tags (DELUXE, SUPER DELUXE, BOX SET, REMASTER...) as readable text.

    These are the vocabulary shared with matching.py::EDITION_PATTERNS, so they arrive
    upper-cased and can be title-cased safely - they contain no acronyms.
    """
    if not tags:
        return ""

    #? sorted for stability: the same release must always produce the same folder, and the
    #? UI builds this list in detection order rather than a guaranteed one
    return ", ".join(tag.title() for tag in sorted({_tidy(t) for t in tags if _tidy(t)}))


def resolve_edition_label(release: dict) -> str:
    """
    A short human-readable name for this edition, or '' when there is nothing to say.

    Order matters. Each source is tried only when the ones above it gave nothing:

      1. `edition_label`    an explicit choice. The metadata-manager hook; always wins.
      2. `disambiguation`   MusicBrainz's own edition descriptor, and by far the best source -
                            it is literally the field editors use to tell releases apart
                            ("deluxe edition", "2011 remaster", "Japanese edition").
      3. `edition_tags`     detected from the title/disambiguation by the UI. Coarser, but
                            present for releases whose disambiguation is empty.
      4. format            only when it is not a plain CD/digital - a vinyl pressing beside a
                            CD is a real distinction worth seeing.
      5. country           regional pressings, when nothing above distinguished them.

    Returns '' for an ordinary single-edition album, which is the common case and should not
    grow a suffix.
    """
    override = _tidy(release.get("edition_label"))
    if override:
        return override[:MAX_LABEL_LENGTH]

    disambiguation = _tidy(release.get("disambiguation"))
    if disambiguation:
        return _sentence_case(disambiguation)[:MAX_LABEL_LENGTH]

    from_tags = _from_edition_tags(release.get("edition_tags"))
    if from_tags:
        return from_tags[:MAX_LABEL_LENGTH]

    media_format = _tidy(release.get("media_format"))
    if media_format and media_format.lower() not in UNMARKED_FORMATS:
        return _sentence_case(media_format)[:MAX_LABEL_LENGTH]

    country = _tidy(release.get("country"))
    #? XW is MusicBrainz for "worldwide", which distinguishes nothing
    if country and country.upper() not in {"XW", "XE"}:
        return country.upper()[:MAX_LABEL_LENGTH]

    return ""


def edition_discriminator(release: dict) -> str:
    """
    A guaranteed-distinct tiebreaker, for when two different releases still collide.

    Only ever used after resolve_edition_label() has failed to separate them - which happens
    when MusicBrainz genuinely holds two releases with the same title, year and
    disambiguation (different pressings of the same edition, usually). Prefers the catalogue
    number because it means something to a person; falls back to the release MBID, which
    means nothing but is unique by construction.
    """
    catalog = _tidy(release.get("catalog_number"))
    if catalog:
        return catalog[:MAX_LABEL_LENGTH]

    mbid = _tidy(release.get("release_mbid"))
    if mbid:
        #? enough to be unique in any real library without turning the folder into a UUID
        return mbid[:8]

    return ""


def describe_edition(release: dict) -> str:
    """
    What to show a person for this edition, never empty.

    The folder name uses resolve_edition_label() and omits the suffix entirely for ordinary
    albums; the UI still needs something to put in an "edition" column, so it says "Standard"
    where the folder says nothing.
    """
    return resolve_edition_label(release) or "Standard"
