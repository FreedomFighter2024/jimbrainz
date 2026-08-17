"""
Building the Soulseek search string.

This is the one place a bad decision costs you every result while saying nothing about why, so
it is worth pinning down precisely. There is no live slskd on a dev machine (see "What the tests
cannot tell you" in CLAUDE.md), so these assert the query we build rather than the results it
gets back.

The rule being tested throughout: **punctuation between two alphanumerics is part of the word
and stays**; punctuation standing on its own is dropped. Taking a word apart ourselves is the
one option that can be wrong however Soulseek matches - see LOOSE_PUNCTUATION for both readings.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.api.slskd_endpoint import build_search_query  # noqa: E402


# ---------------------------------------------------------------- the reported bug

def test_an_ampersand_inside_a_word_survives():
    """
    The reported case: Metallica's S&M2 was searched for as "Metallica S M2".

    If Soulseek tokenizes on non-alphanumerics then the folder "Metallica - S&M2 (2020)" holds
    the tokens metallica/s/m/2 and there is no "m2" anywhere in it, so the album name asked for
    a term that cannot exist on either side - and matched nothing at all.
    """
    assert build_search_query("Metallica", "S&M2") == "Metallica S&M2"
    assert build_search_query("Metallica", "S&M") == "Metallica S&M"


def test_other_words_built_around_punctuation_survive_too():
    assert build_search_query("Various", "R&B Classics") == "Various R&B Classics"
    assert build_search_query("Jay-Z", "The Blueprint") == "Jay-Z The Blueprint"
    assert build_search_query("AC/DC", "Back in Black") == "AC/DC Back in Black"


def test_an_apostrophe_inside_a_word_survives():
    """
    Same rule, and the same reasoning: whatever Soulseek does to "That's" in the query it does
    to "That's" in the folder name.
    """
    query = build_search_query("Earth, Wind & Fire", "That's the Way of the World")
    assert query == "Earth Wind Fire That's the Way of the World"


# ---------------------------------------------------------------- punctuation that does go

def test_a_spaced_ampersand_is_dropped():
    """
    Not a word here, just a separator - the words either side are already terms. Sharers write
    it as "&", "and", or leave it out, so asking for it would match only the first group.
    """
    assert build_search_query("Simon & Garfunkel", "Bookends") == "Simon Garfunkel Bookends"
    assert build_search_query("Above & Beyond", "Group Therapy") == "Above Beyond Group Therapy"


def test_trailing_and_wrapping_punctuation_is_dropped():
    assert build_search_query("Guns N' Roses", "Appetite") == "Guns N Roses Appetite"
    assert build_search_query("Tame Impala", "The Slow Rush (Deluxe)") == "Tame Impala The Slow Rush Deluxe"


def test_a_title_made_only_of_punctuation_leaves_just_the_artist():
    """Sigur Rós really did release an album called "( )". Better a broad search than none."""
    assert build_search_query("Sigur Ros", "( )") == "Sigur Ros"


# ---------------------------------------------------------------- what must keep working

def test_short_but_meaningful_terms_are_kept():
    """
    A volume number is one character and is the whole point of the title. An earlier attempt at
    the ampersand bug dropped every term under two characters, which fixed nothing here and
    quietly turned "Vol. 2" into "Vol".
    """
    assert build_search_query("Various", "Greatest Hits Vol. 2") == "Various Greatest Hits Vol 2"


def test_edition_text_is_not_added():
    """
    The trade this module is built on: "deluxe edition" almost never appears in the folder names
    people share, so asking for it returns nothing. Edition is a ranking signal, never a query
    term - see src/matching.py.
    """
    assert build_search_query("Tame Impala", "The Slow Rush") == "Tame Impala The Slow Rush"


def test_empty_input_gives_an_empty_query():
    """The route refuses to search on this rather than asking slskd for everything."""
    assert build_search_query("", "") == ""
    assert build_search_query(None, None) == ""


def test_whitespace_is_collapsed():
    assert build_search_query("  Boards   of  Canada ", " Geogaddi  ") == "Boards of Canada Geogaddi"
