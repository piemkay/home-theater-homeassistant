"""
Jellyfin client: normalisation, filtering, auth and play-state reporting.

Fixtures mirror the shapes the live server at jellyfin.local.7labs.dev
(Jellyfin 10.11.11) actually returns.
"""

from __future__ import annotations

from collections.abc import Mapping
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

    async def test_4k_filter_is_applied_client_side(self):
        hd = dict(MOVIE, Id="hd", MediaStreams=[{"Type": "Video", "Width": 1920}])
        session = FakeSession(
            {"/Users/user-1/Items": {"Items": [MOVIE, hd], "TotalRecordCount": 2}}
        )

        page = await _client(session).search(MediaQuery(only_4k=True))

        assert [i.id for i in page.items] == ["abc123"]

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
