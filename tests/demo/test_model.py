"""Clips, showcases and the human timecode parsing they depend on."""

from __future__ import annotations

from custom_components.kino.demo.model import (
    Clip,
    DemoSettings,
    Showcase,
    format_timecode,
    parse_timecode,
)


class TestTimecodes:
    def test_parses_the_three_spellings_of_the_same_moment(self):
        # "1:12:04", "72:04" and bare seconds all mean the same instant.
        assert parse_timecode("1:12:04") == 4324_000
        assert parse_timecode("72:04") == 4324_000
        assert parse_timecode("4324") == 4324_000

    def test_forgives_stray_whitespace(self):
        assert parse_timecode("  1 : 12 : 04 ") == 4324_000

    def test_refuses_what_is_not_a_timecode(self):
        # A wrong number is worse than no number.
        for text in ("", "abc", "1:2:x", "--", None):
            assert parse_timecode(text) is None

    def test_formats_below_and_above_the_hour(self):
        assert format_timecode(62_000) == "1:02"
        assert format_timecode(4324_000) == "1:12:04"

    def test_round_trips(self):
        assert parse_timecode(format_timecode(4324_000)) == 4324_000

    def test_never_goes_negative(self):
        assert format_timecode(-5000) == "0:00"


class TestClip:
    def test_default_name_carries_the_title_and_the_span(self):
        clip = Clip(id="c1", title="Sturmwarnung", start_ms=3720_000, end_ms=3765_000)
        assert clip.default_name() == "Sturmwarnung — 1:02:00–1:02:45"

    def test_from_dict_fills_a_missing_name(self):
        clip = Clip.from_dict(
            {"title": "Nordlicht", "startMs": 480_000, "endMs": 540_000}
        )
        assert clip.name == "Nordlicht — 8:00–9:00"

    def test_from_dict_swaps_a_reversed_span(self):
        clip = Clip.from_dict({"startMs": 900, "endMs": 100})
        assert (clip.start_ms, clip.end_ms) == (100, 900)

    def test_duration_is_derived_not_stored(self):
        assert Clip(id="c", start_ms=1000, end_ms=4000).duration_ms == 3000

    def test_tags_are_deduplicated_and_trimmed(self):
        clip = Clip.from_dict({"tags": [" bass_heavy ", "bass_heavy", "", "panning"]})
        assert clip.tags == ("bass_heavy", "panning")

    def test_round_trips_through_its_dict_form(self):
        original = Clip.from_dict(
            {
                "id": "c1",
                "itemId": "abc",
                "path": "/media/x.mkv",
                "title": "Feuerprobe",
                "startMs": 1560_000,
                "endMs": 1610_000,
                "tags": ["atmos_heights"],
                "notes": "Funkenflug",
                "audioTrack": "1: English TrueHD",
                "volumeOffsetDb": -2.5,
            }
        )
        assert Clip.from_dict(original.as_dict()) == original

    def test_reports_whether_it_carries_overrides(self):
        assert not Clip(id="c").has_overrides
        assert Clip(id="c", trinnov_preset="Nacht").has_overrides


class TestShowcase:
    def test_defaults_to_auto_advance(self):
        assert Showcase.from_dict({"name": "Gäste"}).advance == "auto"

    def test_rejects_an_unknown_advance_mode(self):
        assert Showcase.from_dict({"advance": "telepathy"}).advance == "auto"

    def test_clamps_the_gap(self):
        assert Showcase.from_dict({"gapSeconds": 999}).gap_seconds == 60
        assert Showcase.from_dict({"gapSeconds": -5}).gap_seconds == 0

    def test_round_trips(self):
        original = Showcase.from_dict(
            {
                "id": "s1",
                "name": "Bass",
                "clips": ["c1", "c2"],
                "advance": "tap",
                "gapSeconds": 10,
                "referenceVolumeDb": -24.0,
            }
        )
        assert Showcase.from_dict(original.as_dict()) == original


class TestDemoSettings:
    def test_lead_in_defaults_to_the_signal_chain_handshake(self):
        assert DemoSettings().lead_in_seconds == 8.0

    def test_clamps_absurd_values(self):
        assert DemoSettings.from_dict({"leadInSeconds": 999}).lead_in_seconds == 60.0
        assert DemoSettings.from_dict({"leadInSeconds": -5}).lead_in_seconds == 0.0
        assert DemoSettings.from_dict({"retroCaptureSeconds": 1}).retro_capture_seconds == 5

    def test_accepts_both_spellings(self):
        assert DemoSettings.from_dict({"lead_in_seconds": 3}).lead_in_seconds == 3.0
        assert DemoSettings.from_dict({"leadInSeconds": 3}).lead_in_seconds == 3.0

    def test_round_trips(self):
        original = DemoSettings(lead_in_seconds=6.0, ramp_out=True)
        assert DemoSettings.from_dict(original.as_dict()) == original
