"""
Reading a catalogue entry back out of a file path (FR-46, in reverse).

The player reports what it opened as a path — `.../The Death of Robin Hood
(2026)/The Death of Robin Hood (2026) {imdb-tt32273171} [WEBDL-2160p]…mkv` —
and nothing else. That name is not something to show anybody, and it carries no
poster. But it does carry the two things needed to find the entry it came from:
the title, and very often the IMDb ID that Radarr and Sonarr write into it.

No Home Assistant import and no I/O, so the parsing is unit-testable (NFR-6).
"""

from __future__ import annotations

import re

#: `{imdb-tt1234567}` / `[imdbid-tt1234567]`, as the *arr naming schemes write.
_IMDB = re.compile(r"[{\[]imdb(?:id)?-(tt\d+)[}\]]", re.IGNORECASE)

#: `{tmdb-1234}` / `[tmdbid-1234]`.
_TMDB = re.compile(r"[{\[]tmdb(?:id)?-(\d+)[}\]]", re.IGNORECASE)

#: Everything from the first bracket onwards is packaging, not title.
_TITLE_END = re.compile(r"\s*[({\[]")

#: Scene naming has no brackets at all: `The.Big.Lebowski.1998.1080p…`. Cut at
#: the year, but never so far that nothing is left to search for.
_BARE_YEAR = re.compile(r"\s(?:19|20)\d{2}(?:\s|$)")

#: `Series Name - S03E08 - Episode Title […]` — the series name is what the
#: catalogue search takes; the code then picks the episode out of the series.
_EPISODE = re.compile(r"\s*-\s*S\d{1,3}E\d{1,3}\b.*$", re.IGNORECASE)

#: The code itself, wherever it sits in the name.
_EPISODE_CODE = re.compile(r"\bS(\d{1,3})E(\d{1,3})\b", re.IGNORECASE)


def provider_ids_from_path(path: str) -> dict[str, str]:
    """Return the provider IDs the file name carries, in catalogue spelling."""
    found: dict[str, str] = {}
    if match := _IMDB.search(path):
        found["Imdb"] = match.group(1)
    if match := _TMDB.search(path):
        found["Tmdb"] = match.group(1)
    return found


def episode_code_from_path(path: str) -> tuple[int, int] | None:
    """Return (season, episode) when the file name carries an SxxEyy code.

    An episode file must resolve to the *episode*, not to its series — the
    series id would put the wrong title on screen and, worse, report the
    playback session against the wrong entry (F2).
    """
    stem = path.replace("\\", "/").rsplit("/", 1)[-1]
    match = _EPISODE_CODE.search(stem)
    if not match:
        return None
    return int(match.group(1)), int(match.group(2))


def title_from_path(path: str) -> str:
    """Return a searchable title, with the release packaging stripped off.

    Good enough to hand to the catalogue's search; the provider ID decides
    which of the results is really the one.
    """
    stem = path.replace("\\", "/").rsplit("/", 1)[-1]
    stem = stem.rsplit(".", 1)[0] if "." in stem else stem
    stem = _EPISODE.sub("", stem)
    stem = _TITLE_END.split(stem, maxsplit=1)[0]
    stem = " ".join(stem.replace(".", " ").replace("_", " ").split())
    head = _BARE_YEAR.split(stem, maxsplit=1)[0].strip()
    return head or stem
