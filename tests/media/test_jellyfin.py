"""
Jellyfin client: normalisation, filtering, auth and play-state reporting.

Fixtures mirror the shapes the live server at jellyfin.local.7labs.dev
(Jellyfin 10.11.11) actually returns.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, ClassVar

import pytest

from custom_components.kino.media.base import (
    Category,
    MediaBackendError,
    MediaQuery,
    SortOrder,
)
from custom_components.kino.media.jellyfin import (
    JellyfinAuthError,
    JellyfinClient,
)


class FakeResponse:
    def __init__(
        self, status: int, payload: Any, content_type: str = "application/json"
    ):
        self.status = status
        self._payload = payload
        self.headers = {"Content-Type": content_type}

    async def json(self) -> Any:
        return self._payload

    async def read(self) -> bytes:
        return self._payload

    async def __aenter__(self) -> FakeResponse:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None


class FakeSession:
    """Records requests and replays canned responses by path."""

    def __init__(self, routes: Mapping[str, Any] | None = None) -> None:
        self.routes: dict[str, Any] = dict(routes or {})
        self.requests: list[dict[str, Any]] = []

    async def request(
        self,
        method: str,
        url: str,
        *,
        params=None,
        json=None,
        headers=None,
        timeout=None,
    ) -> FakeResponse:
        path = url.split("://", 1)[-1].split("/", 1)[-1]
        self.requests.append(
            {
                "method": method,
                "path": "/" + path,
                "params": dict(params or {}),
                "json": json,
                "headers": dict(headers or {}),
            }
        )
        for route, response in self.routes.items():
            if route in url:
                if isinstance(response, FakeResponse):
                    return response
                return FakeResponse(200, response)
        return FakeResponse(200, {})


MOVIE = {
    "Id": "abc123",
    "Name": "10 Cloverfield Lane",
    "Type": "Movie",
    "ProductionYear": 2016,
    "RunTimeTicks": 63_600_000_000,  # 106 minutes
    "Genres": ["Thriller", "Drama"],
    "ProductionLocations": ["United States"],
    "CommunityRating": 7.2,
    "Overview": "Eine junge Frau erwacht in einem Bunker.",
    "Taglines": ["Monsters come in many forms."],
    "ProviderIds": {"Tmdb": "333371", "Imdb": "tt1179933"},
    "Path": "/mnt/nfs/movies/10 Cloverfield Lane (2016).mkv",
    "ImageTags": {"Primary": "tag1"},
    "UserData": {"Played": False, "PlaybackPositionTicks": 19_080_000_000},
    "MediaStreams": [
        {
            "Type": "Video",
            "Width": 3840,
            "Height": 2160,
            "AverageFrameRate": 23.976,
            "VideoRange": "HDR10",
        },
        {
            "Type": "Audio",
            "Codec": "truehd",
            "ChannelLayout": "7.1",
            "Language": "deu",
        },
    ],
}

UNMATCHED_MOVIE = {
    "Id": "gotg-holiday",
    "Name": "The Guardians of the Galaxy Holiday Special",
    "Type": "Movie",
    "ProductionYear": 2022,
    "ProviderIds": {},
    "Path": None,
    "UserData": {},
}


def _client(session, **kwargs) -> JellyfinClient:
    return JellyfinClient(
        session,
        base_url="https://jellyfin.local.7labs.dev",
        token="tok",
        user_id="user-1",
        **kwargs,
    )


class TestNormalisation:
    async def test_movie_fields_are_mapped(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )

        page = await _client(session).search(MediaQuery())

        item = page.items[0]
        assert item.title == "10 Cloverfield Lane"
        assert item.year == 2016
        assert item.runtime_minutes == 106
        assert item.genres == ("Thriller", "Drama")
        assert item.rating == 7.2
        assert item.tagline == "Monsters come in many forms."
        assert item.tmdb_id == "333371"
        assert item.imdb_id == "tt1179933"

    async def test_4k_is_derived_from_the_video_stream(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )
        page = await _client(session).search(MediaQuery())
        assert page.items[0].is_4k is True

    async def test_format_lines_match_the_detail_view(self):
        """FR-56: `3840×2160 · @23.976Hz · HDR10`."""
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )
        item = (await _client(session).search(MediaQuery())).items[0]
        assert item.video_format == "3840×2160 · @23.976Hz · HDR10"
        assert item.audio_format == "TRUEHD · 7.1 · deu"

    async def test_resume_position_becomes_a_percentage(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )
        item = (await _client(session).search(MediaQuery())).items[0]
        assert item.resume_percent == pytest.approx(30.0, abs=0.1)
        assert item.resume_seconds == pytest.approx(1908.0, abs=0.1)

    async def test_unmatched_item_is_flagged_not_hidden(self):
        """FR-47: an entry the card offers must actually play."""
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [UNMATCHED_MOVIE], "TotalRecordCount": 1}}
        )

        item = (await _client(session).search(MediaQuery())).items[0]

        assert item.playable is False
        assert "nicht abspielbar" in (item.unplayable_reason or "")

    async def test_path_only_item_is_still_playable(self):
        raw = dict(UNMATCHED_MOVIE, Path="/mnt/nfs/movies/x.mkv")
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [raw], "TotalRecordCount": 1}}
        )
        item = (await _client(session).search(MediaQuery())).items[0]
        assert item.playable is True

    async def test_favorite_rating_3d_and_image_tags_are_mapped(self):
        raw = dict(
            MOVIE,
            OfficialRating="FSK-16",
            Video3DFormat="HalfSideBySide",
            ImageTags={"Primary": "tag1", "Thumb": "thumb1", "Banner": "banner1"},
            BackdropImageTags=["bd1"],
            UserData=dict(MOVIE["UserData"], IsFavorite=True),
        )
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [raw], "TotalRecordCount": 1}}
        )

        item = (await _client(session).search(MediaQuery())).items[0]

        assert item.is_favorite is True
        assert item.official_rating == "FSK-16"
        assert item.is_3d is True
        assert item.thumb_tag == "thumb1"
        assert item.banner_tag == "banner1"
        payload = item.as_dict()
        assert payload["favorite"] is True
        assert payload["officialRating"] == "FSK-16"
        assert payload["is3d"] is True
        assert payload["thumbTag"] == "thumb1"
        assert payload["bannerTag"] == "banner1"
        assert payload["backdropTag"] == "bd1"

    async def test_favorite_defaults_to_false(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )
        item = (await _client(session).search(MediaQuery())).items[0]
        assert item.is_favorite is False
        assert item.is_3d is False


class TestQuerying:
    async def test_search_term_and_sort_reach_the_server(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )

        await _client(session).search(
            MediaQuery(search="cloverfield", sort=SortOrder.YEAR)
        )

        params = session.requests[0]["params"]
        assert params["SearchTerm"] == "cloverfield"
        assert params["SortBy"] == "ProductionYear"
        assert params["SortOrder"] == "Descending"

    async def test_shows_category_switches_item_type(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(category=Category.SHOWS))
        assert session.requests[0]["params"]["IncludeItemTypes"] == "Series"

    async def test_unwatched_filter_is_server_side(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(only_unwatched=True))
        assert session.requests[0]["params"]["Filters"] == "IsUnplayed"

    async def test_combined_watch_filters_do_not_clobber_each_other(self):
        """Unwatched + resumable used to leave only the last one standing."""
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(
            MediaQuery(only_unwatched=True, only_resumable=True)
        )
        assert session.requests[0]["params"]["Filters"] == "IsUnplayed,IsResumable"

    async def test_watched_and_favorites_join_the_filter_list(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(
            MediaQuery(only_watched=True, only_favorites=True, only_resumable=True)
        )
        assert (
            session.requests[0]["params"]["Filters"]
            == "IsPlayed,IsResumable,IsFavorite"
        )

    async def test_new_sort_fields_reach_the_server(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        client = _client(session)
        expectations = {
            SortOrder.RUNTIME: ("Runtime", "Descending"),
            SortOrder.LAST_PLAYED: ("DatePlayed", "Descending"),
            SortOrder.RANDOM: ("Random", "Ascending"),
            SortOrder.CRITICS: ("CriticRating", "Descending"),
        }
        for sort, (sort_by, sort_order) in expectations.items():
            session.requests.clear()
            await client.search(MediaQuery(sort=sort))
            params = session.requests[0]["params"]
            assert params["SortBy"] == sort_by
            assert params["SortOrder"] == sort_order

    async def test_sort_dir_overrides_the_field_default(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(sort=SortOrder.YEAR, sort_dir="asc"))
        assert session.requests[0]["params"]["SortOrder"] == "Ascending"

    async def test_sort_dir_also_wins_over_the_recent_override(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(
            MediaQuery(category=Category.RECENT, sort_dir="asc")
        )
        params = session.requests[0]["params"]
        assert params["SortBy"] == "DateCreated"
        assert params["SortOrder"] == "Ascending"

    async def test_recent_and_continue_include_both_item_kinds(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        client = _client(session)
        for category in (Category.RECENT, Category.CONTINUE):
            session.requests.clear()
            await client.search(MediaQuery(category=category))
            assert session.requests[0]["params"]["IncludeItemTypes"] == "Movie,Series"

    async def test_year_range_is_expanded(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(year_from=2020, year_to=2022))
        assert session.requests[0]["params"]["Years"] == "2020,2021,2022"

    async def test_absurd_year_range_is_ignored_rather_than_sent(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(year_from=1800, year_to=2026))
        assert "Years" not in session.requests[0]["params"]

    async def test_open_ended_year_from_runs_to_the_current_year(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(year_from=2020))
        years = session.requests[0]["params"]["Years"].split(",")
        assert years[0] == "2020"
        assert years[-1] == str(datetime.now(tz=timezone.utc).year)

    async def test_open_ended_year_to_starts_at_1900(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(year_to=1950))
        years = session.requests[0]["params"]["Years"].split(",")
        assert years[0] == "1900"
        assert years[-1] == "1950"

    async def test_4k_filter_is_server_side(self):
        """A client-side cut after pagination skipped and repeated titles."""
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(only_4k=True))
        assert session.requests[0]["params"]["MinWidth"] == "3000"

    async def test_hd_filter_is_a_width_window(self):
        """HD means HD: sub-720p rips belong to the SD tier, not this one."""
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(only_hd=True))
        params = session.requests[0]["params"]
        assert params["MaxWidth"] == "2999"
        assert params["MinWidth"] == "1280"

    async def test_sd_filter_is_server_side(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(only_sd=True))
        params = session.requests[0]["params"]
        assert params["MaxWidth"] == "1279"
        assert "MinWidth" not in params

    async def test_3d_filter_is_server_side(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(only_3d=True))
        assert session.requests[0]["params"]["Is3D"] == "true"

    async def test_official_ratings_are_pipe_joined(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(ratings=("FSK-12", "FSK-16")))
        assert session.requests[0]["params"]["OfficialRatings"] == "FSK-12|FSK-16"

    async def test_uhd_category_filters_like_the_4k_tag(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(category=Category.UHD))
        assert session.requests[0]["params"]["MinWidth"] == "3000"

    async def test_country_filter_is_applied_client_side(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )

        page = await _client(session).search(MediaQuery(countries=("Germany",)))

        assert page.items == ()

    async def test_pagination_reports_more(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE], "TotalRecordCount": 50}}
        )

        page = await _client(session).search(MediaQuery(limit=1, offset=0))

        assert page.total == 50
        assert page.has_more is True
        assert session.requests[0]["params"]["StartIndex"] == "0"


class TestFavorites:
    async def test_marking_posts_to_the_favorites_endpoint(self):
        session = FakeSession()
        await _client(session).set_favorite("abc123", True)
        request = session.requests[0]
        assert request["method"] == "POST"
        assert request["path"] == "/Users/user-1/FavoriteItems/abc123"

    async def test_unmarking_deletes(self):
        session = FakeSession()
        await _client(session).set_favorite("abc123", False)
        request = session.requests[0]
        assert request["method"] == "DELETE"
        assert request["path"] == "/Users/user-1/FavoriteItems/abc123"

    async def test_favorites_need_a_connected_user(self):
        client = JellyfinClient(
            FakeSession(), base_url="https://x", token="t", user_id=None
        )
        with pytest.raises(JellyfinAuthError):
            await client.set_favorite("abc123", True)


class TestFacets:
    async def test_filters_endpoint_supplies_genres_ratings_and_years(self):
        session = FakeSession(
            {
                "/Items/Filters": {
                    "Genres": ["Thriller", "Drama", ""],
                    "OfficialRatings": ["FSK-16", "FSK-12", ""],
                    "Years": [2016, 1999, 2022],
                }
            }
        )

        facets = await _client(session).facets()

        request = session.requests[0]
        assert request["path"] == "/Items/Filters"
        assert request["params"]["UserId"] == "user-1"
        assert request["params"]["IncludeItemTypes"] == "Movie,Series"
        assert facets.genres == ("Drama", "Thriller")
        assert facets.ratings == ("FSK-12", "FSK-16")
        assert facets.year_min == 1999
        assert facets.year_max == 2022

    async def test_empty_library_yields_empty_facets(self):
        session = FakeSession({"/Items/Filters": {}})
        facets = await _client(session).facets()
        assert facets.genres == ()
        assert facets.ratings == ()
        assert facets.year_min is None
        assert facets.year_max is None

    async def test_ratings_sort_by_system_then_rank(self):
        """F12: Jellyfin's alphabetical order put FSK-18 before FSK-6."""
        session = FakeSession(
            {
                "/Items/Filters": {
                    "OfficialRatings": [
                        "18",
                        "FSK-0",
                        "FSK-12",
                        "FSK-16",
                        "FSK-18",
                        "FSK-6",
                        "G",
                        "MA 15+",
                        "NR",
                        "PG",
                        "PG-13",
                        "R",
                        "TV-14",
                        "TV-MA",
                    ]
                }
            }
        )

        facets = await _client(session).facets()

        assert facets.ratings == (
            "FSK-0",
            "FSK-6",
            "FSK-12",
            "FSK-16",
            "FSK-18",
            "G",
            "PG",
            "PG-13",
            "R",
            "NR",
            "TV-14",
            "TV-MA",
            "MA 15+",
            "18",
        )


SERIES = {
    "Id": "series1",
    "Name": "House of the Dragon",
    "Type": "Series",
    "ProductionYear": 2022,
    "Genres": ["Drama", "Fantasy"],
    "Overview": "Das Haus Targaryen auf dem Höhepunkt seiner Macht.",
    "UserData": {"Played": False, "UnplayedItemCount": 13},
    "ImageTags": {"Primary": "tagS"},
}

SEASON = {
    "Id": "season3",
    "Name": "Staffel 3",
    "Type": "Season",
    "IndexNumber": 3,
    "SeriesName": "House of the Dragon",
    "UserData": {"Played": False, "UnplayedItemCount": 5},
}

EPISODE = {
    "Id": "ep308",
    "Name": "Der Drachenritt",
    "Type": "Episode",
    "IndexNumber": 8,
    "ParentIndexNumber": 3,
    "SeriesName": "House of the Dragon",
    "RunTimeTicks": 33_600_000_000,  # 56 minutes
    "Overview": "Ein Bote überbringt eine Nachricht.",
    "Path": "/mnt/nfs/series/HotD/S03E08.mkv",
    "UserData": {"Played": False, "PlaybackPositionTicks": 11_472_000_000},
}


class TestSeries:
    """F2: the series drill-down — seasons, episodes, and their naming."""

    async def test_seasons_come_from_the_shows_endpoint(self):
        session = FakeSession({"/Shows/series1/Seasons": {"Items": [SEASON]}})

        seasons = await _client(session).seasons("series1")

        request = session.requests[0]
        assert request["path"] == "/Shows/series1/Seasons"
        assert request["params"]["UserId"] == "user-1"
        assert len(seasons) == 1
        season = seasons[0]
        assert season.kind == "season"
        assert season.title == "Staffel 3"
        assert season.index_number == 3
        assert season.unplayed_count == 5

    async def test_episodes_are_scoped_to_a_season(self):
        session = FakeSession({"/Shows/series1/Episodes": {"Items": [EPISODE]}})

        episodes = await _client(session).episodes("series1", "season3")

        request = session.requests[0]
        assert request["path"] == "/Shows/series1/Episodes"
        assert request["params"]["SeasonId"] == "season3"
        episode = episodes[0]
        assert episode.kind == "episode"
        assert episode.series_name == "House of the Dragon"
        assert episode.episode_code == "S03E08"
        assert episode.runtime_minutes == 56
        assert episode.resume_seconds == pytest.approx(1147.2)
        assert episode.playable  # it has a path

    async def test_an_episode_is_recognised_by_its_series(self):
        session = FakeSession({"/Shows/series1/Episodes": {"Items": [EPISODE]}})

        episode = (await _client(session).episodes("series1"))[0]

        assert episode.display_title == "House of the Dragon · S03E08"
        payload = episode.as_dict()
        assert payload["seriesName"] == "House of the Dragon"
        assert payload["episodeCode"] == "S03E08"

    async def test_a_series_entry_stays_a_show(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [SERIES], "TotalRecordCount": 1}}
        )

        page = await _client(session).search(MediaQuery(category=Category.SHOWS))

        show = page.items[0]
        assert show.kind == "show"
        assert show.unplayed_count == 13
        assert show.display_title == "House of the Dragon"


class TestAuth:
    async def test_token_is_sent_in_the_authorization_header(self):
        session = FakeSession()
        client = _client(session)

        await client.system_info()

        header = session.requests[0]["headers"]["Authorization"]
        assert header.startswith('MediaBrowser Token="tok"')
        assert 'Client="Kino"' in header

    async def test_401_becomes_a_plain_german_auth_error(self):
        session = FakeSession({"/Users/user-1/Items": FakeResponse(401, {})})

        with pytest.raises(JellyfinAuthError) as excinfo:
            await _client(session).search(MediaQuery())

        assert "neu verbinden" in str(excinfo.value)
        assert excinfo.value.recoverable is False

    async def test_missing_user_is_a_clear_error_not_a_crash(self):
        client = JellyfinClient(
            FakeSession(), base_url="https://x", token="t", user_id=None
        )

        with pytest.raises(JellyfinAuthError):
            await client.search(MediaQuery())

    async def test_quick_connect_exchange_stores_token_and_user(self):
        session = FakeSession(
            {
                "/Users/AuthenticateWithQuickConnect": {
                    "AccessToken": "new-token",
                    "User": {"Id": "user-9"},
                }
            }
        )
        client = JellyfinClient(session, base_url="https://x")

        await client.quick_connect_authenticate("SECRET")

        assert client.user_id == "user-9"
        assert 'Token="new-token"' in client.authorization_header()

    async def test_unapproved_quick_connect_is_recoverable(self):
        session = FakeSession({"/Users/AuthenticateWithQuickConnect": {}})
        client = JellyfinClient(session, base_url="https://x")

        with pytest.raises(JellyfinAuthError) as excinfo:
            await client.quick_connect_authenticate("SECRET")

        assert excinfo.value.recoverable is True


class TestPlayState:
    """FR-48/FR-49: report as a first-class session so Jellystat sees it."""

    async def test_start_reports_position_in_ticks(self):
        session = FakeSession()
        await _client(session).report_start("abc123", position_seconds=1908.0)

        body = session.requests[0]["json"]
        assert session.requests[0]["path"] == "/Sessions/Playing"
        assert body["ItemId"] == "abc123"
        assert body["PositionTicks"] == 19_080_000_000

    async def test_progress_carries_the_pause_flag(self):
        session = FakeSession()
        await _client(session).report_progress(
            "abc123", position_seconds=60.0, paused=True
        )

        body = session.requests[0]["json"]
        assert session.requests[0]["path"] == "/Sessions/Playing/Progress"
        assert body["IsPaused"] is True

    async def test_stop_reports_the_final_position(self):
        session = FakeSession()
        await _client(session).report_stop("abc123", position_seconds=3600.0)

        assert session.requests[0]["path"] == "/Sessions/Playing/Stopped"
        assert session.requests[0]["json"]["PositionTicks"] == 36_000_000_000


class TestFailureModes:
    async def test_server_error_is_plain_german(self):
        session = FakeSession({"/Users/user-1/Items": FakeResponse(500, {})})

        with pytest.raises(MediaBackendError) as excinfo:
            await _client(session).search(MediaQuery())

        assert "Jellyfin meldet Fehler 500" in str(excinfo.value)

    async def test_transport_failure_suggests_retrying(self):
        class BrokenSession(FakeSession):
            async def request(self, *args, **kwargs):
                raise OSError("connection refused")

        with pytest.raises(MediaBackendError) as excinfo:
            await _client(BrokenSession()).search(MediaQuery())

        assert "nicht erreichbar" in str(excinfo.value)
        assert excinfo.value.recoverable is True

    async def test_refresh_hits_the_library_endpoint(self):
        """FR-44: the NAS spun down, try again."""
        session = FakeSession()
        await _client(session).refresh()
        assert session.requests[0]["path"] == "/Library/Refresh"


def _scan_movie(
    movie_id: str,
    *,
    genres: tuple[str, ...] = (),
    langs: tuple[str, ...] = (),
    width: int = 3840,
    year: int = 2020,
    official: str | None = "FSK-16",
    community: float | None = 7.0,
    critic: float | None = None,
    watched: bool = False,
    favorite: bool = False,
    resume_ticks: int = 0,
) -> dict[str, Any]:
    """One catalogue entry, shaped like the scan sees it."""
    return {
        "Id": movie_id,
        "Name": movie_id,
        "Type": "Movie",
        "ProductionYear": year,
        "Genres": list(genres),
        "OfficialRating": official,
        "CommunityRating": community,
        "CriticRating": critic,
        "UserData": {
            "Played": watched,
            "IsFavorite": favorite,
            "PlaybackPositionTicks": resume_ticks,
        },
        "MediaStreams": [
            {"Type": "Video", "Width": width},
            *({"Type": "Audio", "Language": lang} for lang in langs),
        ],
    }


class TestScanSearch:
    """Multi-genre AND and audio languages go through the catalogue scan."""

    ITEMS: ClassVar[list[dict[str, Any]]] = [
        _scan_movie("a", genres=("Action",), langs=("ger", "eng")),
        _scan_movie("b", genres=("Action", "Crime"), langs=("eng",)),
        _scan_movie("c", genres=("Crime",), langs=("deu",)),
    ]

    def _session(self) -> FakeSession:
        return FakeSession(
            {"/Users/user-1/Items": {"Items": self.ITEMS, "TotalRecordCount": 3}}
        )

    async def test_single_genre_stays_server_side(self):
        session = self._session()
        await _client(session).search(MediaQuery(genres=("Action",)))
        assert len(session.requests) == 1
        assert session.requests[0]["params"]["Genres"] == "Action"

    async def test_multiple_genres_narrow_with_and(self):
        """Stacked genre chips mean "both", not Jellyfin's "either"."""
        session = self._session()

        page = await _client(session).search(MediaQuery(genres=("Action", "Crime")))

        assert page.total == 1
        # The scan itself must not pre-filter genres…
        assert "Genres" not in session.requests[0]["params"]
        # …the visible page is fetched by ID afterwards.
        assert session.requests[1]["params"]["Ids"] == "b"

    async def test_audio_language_filter_matches_any_selected_track(self):
        session = self._session()

        page = await _client(session).search(MediaQuery(audio_langs=("ger",)))

        # "deu" folds onto "ger", so both German-tracked titles qualify.
        assert page.total == 2
        assert session.requests[1]["params"]["Ids"] == "a,c"

    async def test_scan_pagination_reports_exact_totals(self):
        session = FakeSession(
            {
                "/Users/user-1/Items": {
                    "Items": [
                        _scan_movie(f"m{i}", genres=("Action", "Crime"))
                        for i in range(5)
                    ],
                    "TotalRecordCount": 5,
                }
            }
        )

        page = await _client(session).search(
            MediaQuery(genres=("Action", "Crime"), limit=2, offset=2)
        )

        assert page.total == 5
        assert page.offset == 2
        assert page.has_more is True
        assert session.requests[1]["params"]["Ids"] == "m2,m3"

    async def test_an_empty_page_needs_no_second_request(self):
        session = self._session()
        page = await _client(session).search(
            MediaQuery(genres=("Action", "Crime"), offset=10)
        )
        assert page.total == 1
        assert page.items == ()
        assert len(session.requests) == 1


class TestNewServerFilters:
    async def test_person_filter_is_server_side(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(person_ids=("p1", "p2")))
        assert session.requests[0]["params"]["PersonIds"] == "p1|p2"

    async def test_min_community_rating_reaches_the_server(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery(min_rating=7.0))
        params = session.requests[0]["params"]
        assert params["MinCommunityRating"] == "7.0"
        assert "MinCriticRating" not in params

    async def test_min_critic_filters_through_the_scan(self):
        """Jellyfin 10.11 accepts MinCriticRating and ignores it — so we don't
        send it; the critics minimum is applied here instead."""
        session = FakeSession(
            {
                "/Users/user-1/Items": {
                    "Items": [
                        _scan_movie("fresh", critic=93.0),
                        _scan_movie("rotten", critic=40.0),
                        _scan_movie("unscored", critic=None),
                    ],
                    "TotalRecordCount": 3,
                }
            }
        )

        page = await _client(session).search(MediaQuery(min_critic=80.0))

        assert page.total == 1
        assert "MinCriticRating" not in session.requests[0]["params"]
        assert session.requests[1]["params"]["Ids"] == "fresh"


class TestDetailExtras:
    async def test_critic_rating_is_mapped(self):
        movie = dict(MOVIE, CriticRating=93)
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [movie], "TotalRecordCount": 1}}
        )
        page = await _client(session).search(MediaQuery())
        assert page.items[0].critic_rating == 93
        assert page.items[0].as_dict()["criticRating"] == 93

    async def test_people_arrive_with_the_detail_only(self):
        movie = dict(
            MOVIE,
            People=[
                {
                    "Id": "p1",
                    "Name": "Mary Elizabeth Winstead",
                    "Type": "Actor",
                    "Role": "Michelle",
                    "PrimaryImageTag": "t1",
                },
                {"Id": "p2", "Name": "Dan Trachtenberg", "Type": "Director"},
                {"Name": "Ohne Id — wird verworfen", "Type": "Writer"},
            ],
        )
        session = FakeSession({"/Users/user-1/Items/abc123": movie})

        item = await _client(session).item("abc123")

        assert "People" in session.requests[0]["params"]["Fields"]
        assert [p.name for p in item.people] == [
            "Mary Elizabeth Winstead",
            "Dan Trachtenberg",
        ]
        first = item.as_dict()["people"][0]
        assert first == {
            "id": "p1",
            "name": "Mary Elizabeth Winstead",
            "type": "Actor",
            "role": "Michelle",
            "imageTag": "t1",
        }

    async def test_grid_searches_do_not_request_people(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery())
        assert "People" not in session.requests[0]["params"]["Fields"]

    async def test_similar_comes_from_the_similar_endpoint(self):
        session = FakeSession(
            {"/Items/abc123/Similar": {"Items": [MOVIE], "TotalRecordCount": 1}}
        )

        items = await _client(session).similar("abc123", limit=6)

        request = session.requests[0]
        assert request["path"] == "/Items/abc123/Similar"
        assert request["params"]["UserId"] == "user-1"
        assert request["params"]["Limit"] == "6"
        assert items[0].title == "10 Cloverfield Lane"

    async def test_similar_trims_a_server_that_over_delivers(self):
        """Jellyfin 10.11 hands back more than the Limit it was asked for."""
        session = FakeSession(
            {
                "/Items/abc123/Similar": {
                    "Items": [dict(MOVIE, Id=f"s{i}") for i in range(7)],
                }
            }
        )
        items = await _client(session).similar("abc123", limit=3)
        assert [item.id for item in items] == ["s0", "s1", "s2"]


class TestFacetCounts:
    ITEMS: ClassVar[list[dict[str, Any]]] = [
        _scan_movie("a", genres=("Action",), official="FSK-16", langs=("eng",)),
        _scan_movie("b", genres=("Action", "Crime"), official="FSK-18", langs=("ger",)),
        _scan_movie("c", genres=("Crime",), official="FSK-16", langs=("ger",)),
    ]

    def _session(self) -> FakeSession:
        return FakeSession(
            {"/Users/user-1/Items": {"Items": self.ITEMS, "TotalRecordCount": 3}}
        )

    async def test_counts_preview_the_toggle(self):
        """The user's example: with Action on, Crime shows the intersection."""
        counts = await _client(self._session()).facet_counts(
            MediaQuery(genres=("Action",))
        )

        assert counts["total"] == 2
        assert counts["genres"]["Crime"] == 1  # Action AND Crime
        assert counts["genres"]["Action"] == 3  # tapping Action off again

    async def test_or_groups_widen(self):
        """Age ratings stay OR — adding one grows the result."""
        counts = await _client(self._session()).facet_counts(
            MediaQuery(ratings=("FSK-16",))
        )
        assert counts["total"] == 2
        assert counts["ratings"]["FSK-18"] == 3
        assert counts["ratings"]["FSK-16"] == 3  # toggled off: no rating filter

    async def test_tag_counts_respect_exclusivity(self):
        session = FakeSession(
            {
                "/Users/user-1/Items": {
                    "Items": [
                        _scan_movie("uhd", width=3840),
                        _scan_movie("hd", width=1920),
                    ],
                    "TotalRecordCount": 2,
                }
            }
        )

        counts = await _client(session).facet_counts(MediaQuery(only_hd=True))

        # Tapping 4K while HD is active swaps the tier instead of demanding both.
        assert counts["tags"]["only_4k"] == 1
        assert counts["tags"]["only_hd"] == 2  # toggled off

    async def test_language_counts_fold_synonyms(self):
        session = FakeSession(
            {
                "/Users/user-1/Items": {
                    "Items": [
                        _scan_movie("x", langs=("deu",)),
                        _scan_movie("y", langs=("ger", "eng")),
                    ],
                    "TotalRecordCount": 2,
                }
            }
        )
        counts = await _client(session).facet_counts(MediaQuery())
        assert counts["audioLangs"]["ger"] == 2
        assert "deu" not in counts["audioLangs"]

    async def test_the_scan_is_cached_between_counts(self):
        session = self._session()
        client = _client(session)

        await client.facet_counts(MediaQuery(genres=("Action",)))
        await client.facet_counts(MediaQuery(genres=("Action", "Crime")))

        assert len(session.requests) == 1

    async def test_refresh_drops_the_scan_cache(self):
        session = self._session()
        client = _client(session)

        await client.facet_counts(MediaQuery())
        await client.refresh()
        await client.facet_counts(MediaQuery())

        scans = [r for r in session.requests if r["path"] == "/Users/user-1/Items"]
        assert len(scans) == 2


class TestFacetLanguages:
    async def test_facets_carry_audio_languages_by_frequency(self):
        session = FakeSession(
            {
                "/Items/Filters": {
                    "Genres": ["Drama"],
                    "OfficialRatings": ["FSK-16"],
                    "Years": [2001, 2020],
                },
                "/Users/user-1/Items": {
                    "Items": [
                        _scan_movie("x", langs=("ger", "eng")),
                        _scan_movie("y", langs=("ger",)),
                        _scan_movie("z", langs=("und",)),
                    ],
                    "TotalRecordCount": 3,
                },
            }
        )

        facets = await _client(session).facets()

        assert facets.audio_languages == ("ger", "eng")

    async def test_a_failing_scan_does_not_break_the_facets(self):
        class FlakySession(FakeSession):
            async def request(self, method, url, **kwargs):
                if "/Users/user-1/Items" in url:
                    return FakeResponse(500, {})
                return await super().request(method, url, **kwargs)

        facets = await _client(
            FlakySession({"/Items/Filters": {"Genres": ["Drama", "Action"]}})
        ).facets()

        assert facets.genres == ("Action", "Drama")
        assert facets.audio_languages == ()


def _stream(
    kind: str, index: int, language: str | None, **extra: Any
) -> dict[str, Any]:
    return {"Type": kind, "Index": index, "Language": language, **extra}


TRACKED_MOVIE = dict(
    MOVIE,
    MediaStreams=[
        _stream("Video", 0, None, Width=3840),
        _stream("Audio", 1, "ger", Codec="dts", ChannelLayout="7.1", IsDefault=True),
        _stream("Audio", 2, "ger", Codec="ac3", ChannelLayout="5.1"),
        _stream("Audio", 3, "eng", Codec="ac3", Title="Commentary by the Director"),
        _stream("Subtitle", 4, "ger", Codec="PGSSUB", IsForced=True),
        _stream("Subtitle", 5, "eng", Codec="subrip"),
    ],
)


class TestTracks:
    """Every audio and subtitle stream, not just the first of each."""

    async def test_the_detail_lists_all_audio_and_subtitle_tracks(self):
        session = FakeSession({"/Users/user-1/Items/abc123": TRACKED_MOVIE})

        item = await _client(session).item("abc123")

        assert [(t.index, t.language, t.codec) for t in item.audio_tracks] == [
            (1, "ger", "DTS"),
            (2, "ger", "AC3"),
            (3, "eng", "AC3"),
        ]
        assert [(t.index, t.language, t.is_forced) for t in item.subtitle_tracks] == [
            (4, "ger", True),
            (5, "eng", False),
        ]
        assert item.audio_tracks[0].channel_layout == "7.1"
        assert item.audio_tracks[0].is_default is True
        assert item.audio_tracks[2].is_commentary is True

    async def test_tracks_reach_the_card_as_dicts(self):
        session = FakeSession({"/Users/user-1/Items/abc123": TRACKED_MOVIE})

        payload = (await _client(session).item("abc123")).as_dict()

        assert payload["audioTracks"][0] == {
            "index": 1,
            "language": "ger",
            "codec": "DTS",
            "channelLayout": "7.1",
            "title": None,
            "default": True,
            "forced": False,
            "commentary": False,
        }
        assert len(payload["subtitleTracks"]) == 2

    async def test_a_commentary_is_not_a_language_the_film_exists_in(self):
        """A German film with an English commentary is not an English film."""
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [TRACKED_MOVIE], "TotalRecordCount": 1}}
        )
        client = _client(session)

        german = await client.search(MediaQuery(audio_langs=("ger",)))
        english = await client.search(MediaQuery(audio_langs=("eng",)))

        assert german.total == 1
        assert english.total == 0


class TestLanguageCodes:
    """One language is one chip, however the file happened to spell it."""

    async def test_every_spelling_of_german_is_one_language(self):
        # The live library really does carry all of these side by side.
        movie = dict(
            MOVIE,
            MediaStreams=[
                _stream("Audio", 1, "ger"),
                _stream("Audio", 2, "deu"),
                _stream("Audio", 3, "de"),
                _stream("Audio", 4, "de-DE"),
            ],
        )
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [movie], "TotalRecordCount": 1}}
        )

        counts = await _client(session).facet_counts(MediaQuery())

        assert counts["audioLangs"] == {"ger": 1}

    async def test_two_letter_and_suffixed_codes_fold_onto_the_three_letter_one(self):
        movie = dict(
            MOVIE,
            MediaStreams=[
                _stream("Subtitle", 1, "en"),
                _stream("Subtitle", 2, "zh-hans"),
                _stream("Subtitle", 3, "pt_BR"),
                _stream("Subtitle", 4, "mkd"),
            ],
        )
        session = FakeSession({"/Users/user-1/Items/abc123": movie})

        item = await _client(session).item("abc123")

        assert [t.language for t in item.subtitle_tracks] == [
            "eng",
            "chi",
            "por",
            "mac",
        ]

    async def test_an_unknown_code_survives_rather_than_vanishing(self):
        movie = dict(MOVIE, MediaStreams=[_stream("Audio", 1, "xyz")])
        session = FakeSession({"/Users/user-1/Items/abc123": movie})
        item = await _client(session).item("abc123")
        assert item.audio_tracks[0].language == "xyz"


class TestTrailers:
    async def test_remote_trailers_reach_the_detail(self):
        movie = dict(
            MOVIE,
            RemoteTrailers=[
                {"Name": "Trailer", "Url": "https://www.youtube.com/watch?v=abc"},
                {"Name": "Ohne Url"},
            ],
        )
        session = FakeSession({"/Users/user-1/Items/abc123": movie})

        item = await _client(session).item("abc123")

        assert "RemoteTrailers" in session.requests[0]["params"]["Fields"]
        assert [(t.name, t.url) for t in item.trailers] == [
            ("Trailer", "https://www.youtube.com/watch?v=abc")
        ]
        assert item.as_dict()["trailers"][0]["url"].endswith("v=abc")

    async def test_grid_searches_do_not_request_trailers(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )
        await _client(session).search(MediaQuery())
        assert "RemoteTrailers" not in session.requests[0]["params"]["Fields"]


def _scan_subs(movie_id: str, *, langs=(), sub_langs=()) -> dict[str, Any]:
    record = _scan_movie(movie_id, langs=langs)
    record["MediaStreams"] += [
        {"Type": "Subtitle", "Language": lang} for lang in sub_langs
    ]
    return record


class TestSubtitleFilter:
    ITEMS: ClassVar[list[dict[str, Any]]] = [
        _scan_subs("a", langs=("eng",), sub_langs=("ger", "eng")),
        _scan_subs("b", langs=("eng",), sub_langs=("fre", "ger")),
        _scan_subs("c", langs=("ger",)),
    ]

    def _session(self) -> FakeSession:
        return FakeSession(
            {"/Users/user-1/Items": {"Items": self.ITEMS, "TotalRecordCount": 3}}
        )

    async def test_subtitle_languages_take_the_scan_path(self):
        session = self._session()

        page = await _client(session).search(MediaQuery(subtitle_langs=("ger",)))

        assert page.total == 2
        assert session.requests[1]["params"]["Ids"] == "a,b"

    async def test_subtitles_and_audio_narrow_together(self):
        page = await _client(self._session()).search(
            MediaQuery(audio_langs=("eng",), subtitle_langs=("fre",))
        )
        assert page.total == 1

    async def test_facets_carry_subtitle_languages(self):
        session = FakeSession(
            {
                "/Items/Filters": {"Genres": ["Drama"]},
                "/Users/user-1/Items": {"Items": self.ITEMS, "TotalRecordCount": 3},
            }
        )

        facets = await _client(session).facets()

        # Both scans (films and series) meet the same fixture, so the ranking
        # is what matters here, not the absolute counts.
        assert facets.subtitle_languages[0] == "ger"
        assert set(facets.subtitle_languages) == {"ger", "eng", "fre"}

    async def test_counts_preview_each_subtitle_language(self):
        counts = await _client(self._session()).facet_counts(MediaQuery())
        assert counts["subtitleLangs"] == {"ger": 2, "eng": 1, "fre": 1}


def _episode(series_id: str, suffix: str, *, langs=(), sub_langs=()) -> dict[str, Any]:
    return {
        "Id": f"{series_id}-{suffix}",
        "Type": "Episode",
        "SeriesId": series_id,
        "MediaStreams": [
            *({"Type": "Audio", "Language": lang} for lang in langs),
            *({"Type": "Subtitle", "Language": lang} for lang in sub_langs),
        ],
    }


class SeriesSession(FakeSession):
    """A library of two series, whose languages live in their episodes."""

    SERIES: ClassVar[list[dict[str, Any]]] = [
        {"Id": "s1", "Name": "Eins", "Type": "Series", "UserData": {}},
        {"Id": "s2", "Name": "Zwei", "Type": "Series", "UserData": {}},
    ]
    EPISODES: ClassVar[list[dict[str, Any]]] = [
        _episode("s1", "a", langs=("ger", "eng"), sub_langs=("ger",)),
        _episode("s1", "b", langs=("ger",)),
        _episode("s2", "a", langs=("jpn",), sub_langs=("eng",)),
    ]

    async def request(self, method, url, *, params=None, **kwargs):
        # The base class does the recording; only the payload is ours.
        await super().request(method, url, params=params, **kwargs)
        params = dict(params or {})
        if params.get("IncludeItemTypes") == "Episode":
            return FakeResponse(200, {"Items": self.EPISODES})
        if params.get("Ids"):
            wanted = params["Ids"].split(",")
            return FakeResponse(
                200, {"Items": [s for s in self.SERIES if s["Id"] in wanted]}
            )
        return FakeResponse(200, {"Items": self.SERIES, "TotalRecordCount": 2})


class TestSeriesLanguages:
    """A series has no streams of its own — its episodes' languages are its own."""

    async def test_a_series_can_be_filtered_by_its_episodes_languages(self):
        page = await _client(SeriesSession()).search(
            MediaQuery(category=Category.SHOWS, audio_langs=("jpn",))
        )
        assert page.total == 1
        assert page.items[0].id == "s2"

    async def test_series_subtitle_languages_come_from_the_episodes_too(self):
        page = await _client(SeriesSession()).search(
            MediaQuery(category=Category.SHOWS, subtitle_langs=("ger",))
        )
        assert page.total == 1
        assert page.items[0].id == "s1"

    async def test_the_shows_facet_counts_offer_languages_at_all(self):
        counts = await _client(SeriesSession()).facet_counts(
            MediaQuery(category=Category.SHOWS)
        )
        assert counts["audioLangs"] == {"ger": 1, "eng": 1, "jpn": 1}
        assert counts["subtitleLangs"] == {"ger": 1, "eng": 1}

    async def test_the_episode_sweep_happens_once_across_scans(self):
        session = SeriesSession()
        client = _client(session)

        await client.facet_counts(MediaQuery(category=Category.SHOWS))
        await client.search(MediaQuery(category=Category.SHOWS, audio_langs=("ger",)))

        sweeps = [
            r
            for r in session.requests
            if r["params"].get("IncludeItemTypes") == "Episode"
        ]
        assert len(sweeps) == 1

    async def test_the_sweep_gets_more_time_than_an_ordinary_read(self):
        """It is the one read that grows with the library, not with the page."""

        class TimingSession(SeriesSession):
            def __init__(self):
                super().__init__()
                self.timeouts: list[float | None] = []

            async def request(self, method, url, *, params=None, timeout=None, **kw):
                if (params or {}).get("IncludeItemTypes") == "Episode":
                    self.timeouts.append(timeout)
                return await super().request(method, url, params=params, **kw)

        session = TimingSession()
        await _client(session, timeout=15.0).facet_counts(
            MediaQuery(category=Category.SHOWS)
        )

        assert session.timeouts == [90.0]

    async def test_a_failing_episode_sweep_leaves_the_series_browsable(self):
        class BrokenSession(SeriesSession):
            async def request(self, method, url, *, params=None, **kwargs):
                if (params or {}).get("IncludeItemTypes") == "Episode":
                    self.requests.append({"method": method, "params": dict(params)})
                    return FakeResponse(500, {})
                return await super().request(method, url, params=params, **kwargs)

        counts = await _client(BrokenSession()).facet_counts(
            MediaQuery(category=Category.SHOWS)
        )

        assert counts["total"] == 2
        assert counts["audioLangs"] == {}


class TestPersons:
    async def test_person_search_asks_the_persons_endpoint(self):
        session = FakeSession(
            {
                "/Persons": {
                    "Items": [
                        {
                            "Id": "p1",
                            "Name": "Guillermo del Toro",
                            "Type": "Person",
                            "ImageTags": {"Primary": "t1"},
                        },
                        {"Name": "Ohne Id"},
                    ]
                }
            }
        )

        people = await _client(session).persons("del toro", limit=5)

        request = session.requests[0]
        assert request["path"] == "/Persons"
        assert request["params"]["SearchTerm"] == "del toro"
        assert request["params"]["Limit"] == "5"
        assert [(p.id, p.name, p.image_tag) for p in people] == [
            ("p1", "Guillermo del Toro", "t1")
        ]

    async def test_a_blank_query_asks_nothing(self):
        session = FakeSession()
        assert await _client(session).persons("  ") == ()
        assert session.requests == []


class TestWatched:
    async def test_marking_posts_to_the_played_endpoint(self):
        session = FakeSession()
        await _client(session).set_watched("abc123", True)
        request = session.requests[0]
        assert request["method"] == "POST"
        assert request["path"] == "/Users/user-1/PlayedItems/abc123"

    async def test_unmarking_deletes(self):
        session = FakeSession()
        await _client(session).set_watched("abc123", False)
        assert session.requests[0]["method"] == "DELETE"

    async def test_marking_watched_invalidates_the_scan(self):
        """The grid behind the sheet must not keep claiming the opposite."""
        session = FakeSession(
            {
                "/Users/user-1/Items": {
                    "Items": [_scan_movie("a", langs=("ger",))],
                    "TotalRecordCount": 1,
                }
            }
        )
        client = _client(session)
        await client.search(MediaQuery(audio_langs=("ger",)))
        before = len(session.requests)

        await client.set_watched("a", True)
        await client.search(MediaQuery(audio_langs=("ger",)))

        rescans = [
            r
            for r in session.requests[before:]
            if r["path"] == "/Users/user-1/Items" and "Ids" not in r["params"]
        ]
        assert rescans, "the cached scan should have been dropped"

    async def test_watching_needs_a_connected_user(self):
        client = JellyfinClient(
            FakeSession(), base_url="https://x", token="t", user_id=None
        )
        with pytest.raises(JellyfinAuthError):
            await client.set_watched("abc123", True)


class TestFavoritesCategory:
    async def test_the_favorites_category_covers_films_and_series(self):
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [], "TotalRecordCount": 0}}
        )

        await _client(session).search(MediaQuery(category=Category.FAVORITES))

        params = session.requests[0]["params"]
        assert params["IncludeItemTypes"] == "Movie,Series"
        assert params["Filters"] == "IsFavorite"
