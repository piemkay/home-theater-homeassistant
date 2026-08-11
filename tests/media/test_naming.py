"""
Reading a catalogue entry back out of a file path.

Every path here is one the Zidoo really reported as `media_uri` while playing,
so the parsing is measured against the library as it is actually named.
"""

from __future__ import annotations

import pytest

from custom_components.kino.media.naming import (
    provider_ids_from_path,
    title_from_path,
)

ROBIN_HOOD = (
    "/mnt/nfs/192.168.50.10#entertainment/movies/The Death of Robin Hood (2026)/"
    "The Death of Robin Hood (2026) {imdb-tt32273171} "
    "[WEBDL-2160p][EAC3 Atmos 5.1][h265]-SCOPE.mkv"
)
HOUSE_OF_THE_DRAGON = (
    "/mnt/nfs/192.168.50.10#entertainment/series/House of the Dragon/Season 3/"
    "House of the Dragon (2022) - S03E08 - The Treasons at Tumbleton "
    "[WEBDL-2160p][DV HDR10][EAC3 Atmos 5.1][h265]-CAKES.mkv"
)
CLOVERFIELD = (
    "/mnt/nfs/192.168.50.10#entertainment/movies/10 Cloverfield Lane (2016)/"
    "10 Cloverfield Lane (2016) {imdb-tt1179933} [Remux-2160p][HDR10]"
    "[TrueHD Atmos 7.1][HEVC]-FraMeSToR.mkv"
)


class TestTitle:
    @pytest.mark.parametrize(
        ("path", "expected"),
        [
            (ROBIN_HOOD, "The Death of Robin Hood"),
            (CLOVERFIELD, "10 Cloverfield Lane"),
            # The catalogue knows the series, not the episode file.
            (HOUSE_OF_THE_DRAGON, "House of the Dragon"),
        ],
    )
    def test_release_packaging_is_stripped(self, path, expected):
        assert title_from_path(path) == expected

    def test_a_plain_name_survives_untouched(self):
        assert title_from_path("/media/movies/Gravity.mkv") == "Gravity"

    def test_dots_and_underscores_are_spaces(self):
        assert title_from_path("/x/The.Big.Lebowski.1998.mkv") == "The Big Lebowski"

    def test_nothing_recognisable_is_not_a_guess(self):
        assert title_from_path("") == ""
        assert title_from_path("/media/(2016)/(2016).mkv") == ""


class TestProviderIds:
    def test_the_imdb_id_the_arr_naming_writes(self):
        assert provider_ids_from_path(ROBIN_HOOD) == {"Imdb": "tt32273171"}

    @pytest.mark.parametrize(
        "fragment",
        ["{imdb-tt1179933}", "[imdbid-tt1179933]", "{IMDB-tt1179933}"],
    )
    def test_the_spellings_seen_in_the_wild(self, fragment):
        assert provider_ids_from_path(f"/x/Film {fragment}.mkv") == {
            "Imdb": "tt1179933"
        }

    def test_tmdb_ids_too(self):
        assert provider_ids_from_path("/x/Film {tmdb-333371}.mkv") == {"Tmdb": "333371"}

    def test_a_path_without_ids_claims_none(self):
        assert provider_ids_from_path("/media/movies/Gravity.mkv") == {}
