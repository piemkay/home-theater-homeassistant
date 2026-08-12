"""
Jellyfin client: normalisation, filtering, auth and play-state reporting.

Fixtures mirror the shapes the live server at jellyfin.local.7labs.dev
(Jellyfin 10.11.11) actually returns.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any

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
